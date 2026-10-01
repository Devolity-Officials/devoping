// Backup manager:
//  - automatic local configuration backups in <root>/backup (after every real config change),
//  - manual full backups (config + check history) locally,
//  - scheduled cloud backups through provider plugins (./providers), with remote retention,
//  - restore from any local or cloud backup (a safety snapshot is always taken first).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const secrets = require('../secrets');
const log = require('../logger');
const { getBackupDir } = require('../paths');
const { writeFileAtomic } = require('../fsutil');
const bundle = require('./bundle');
const providers = require('./providers');

const DEFAULTS = {
  localEnabled: true,
  localKeep: 30,
  cloudProvider: '',
  cloudEnabled: false,
  cloudIntervalHours: 24,
  cloudKeep: 14,
  includeHistory: true,
  providers: {},
  lastCloudAt: null,
  lastCloudAttemptAt: null,
  lastCloudResult: null,
};
const LOCAL_DEBOUNCE_MS = 5000;
const CLOUD_TICK_MS = 10 * 60 * 1000;
const CLOUD_RETRY_MS = 60 * 60 * 1000;
const NAME_RE = /^devowatch-(config|backup)-\d{8}-\d{6}(-\d+)?\.json(\.gz)?(\.enc)?$/;
const PASSPHRASE_KEY = 'backup.passphrase';

let broadcast = () => {};
let appVersion = '0.0.0';
let onRestored = () => {};
let localTimer = null;
let cloudTimer = null;
let lastLocalHash = null;
let busy = null;
const runtime = new Map(); // providerId -> { tokens }

function settings() {
  const s = config.getSettings().backup || {};
  return { ...DEFAULTS, ...s, providers: { ...(s.providers || {}) } };
}

function saveSettings(patch) {
  const next = { ...settings(), ...patch };
  config.updateSettings({ backup: next });
  return next;
}

function progress(phase, extra = {}) {
  broadcast('backup:progress', { phase, ...extra });
}

// Hash of the meaningful configuration: ignores bookkeeping fields and auto-resolved IPs that
// change on their own, so only real edits produce a new automatic backup.
function configHash(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg));
  if (copy.settings && copy.settings.backup) {
    delete copy.settings.backup.lastCloudAt;
    delete copy.settings.backup.lastCloudAttemptAt;
    delete copy.settings.backup.lastCloudResult;
  }
  if (copy.settings && copy.settings.telemetry) {
    delete copy.settings.telemetry.lastSentAt;
    delete copy.settings.telemetry.lastResult;
  }
  copy.hosts = (copy.hosts || []).map(({ updatedAt, ...h }) => (h.ipAuto ? { ...h, ip: '' } : h));
  return crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

function uniqueName(dir, base, ext) {
  let name = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}${ext}`;
  return name;
}

// ---------------- local ----------------
function listLocal() {
  const dir = getBackupDir();
  return fs.readdirSync(dir)
    .filter((n) => NAME_RE.test(n))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, modified: st.mtime.toISOString(), kind: name.includes('-config-') ? 'config' : 'full', encrypted: name.endsWith('.enc') };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified) || b.name.localeCompare(a.name));
}

function pruneLocal(keep) {
  for (const kind of ['config', 'full']) {
    listLocal().filter((b) => b.kind === kind).slice(keep).forEach((b) => {
      try {
        fs.unlinkSync(path.join(getBackupDir(), b.name));
      } catch (err) {
        log.warn(`Could not delete old backup ${b.name}: ${err.message}`);
      }
    });
  }
}

function snapshotConfig(reason, { force = false } = {}) {
  const s = settings();
  if (!s.localEnabled && !force) return null;
  const cfg = config.snapshot();
  const hash = configHash(cfg);
  if (hash === lastLocalHash && !force) return null;
  const dir = getBackupDir();
  const name = uniqueName(dir, `devowatch-config-${bundle.timestamp()}`, '.json');
  const env = bundle.envelope({ kind: 'config', config: cfg, appVersion });
  writeFileAtomic(path.join(dir, name), JSON.stringify(env, null, 2));
  lastLocalHash = hash;
  pruneLocal(s.localKeep);
  log.info(`Local configuration backup ${name} (${reason})`);
  broadcast('backup:changed', {});
  return name;
}

function scheduleLocal() {
  if (localTimer) clearTimeout(localTimer);
  localTimer = setTimeout(() => {
    localTimer = null;
    try {
      snapshotConfig('config changed');
    } catch (err) {
      log.error(`Automatic local backup failed: ${err.message}`);
    }
  }, LOCAL_DEBOUNCE_MS);
}

function buildFullBackup() {
  const s = settings();
  const passphrase = secrets.get(PASSPHRASE_KEY);
  const env = bundle.envelope({
    kind: 'full',
    config: config.snapshot(),
    dbBuffer: s.includeHistory ? db.exportBuffer() : null,
    appVersion,
    // Cloud credentials travel only inside passphrase-encrypted backups; the passphrase itself never does.
    secrets: passphrase ? credentialSecrets() : null,
  });
  return bundle.pack(env, passphrase);
}

function credentialSecrets() {
  const all = secrets.exportPrefix('backup.');
  delete all[PASSPHRASE_KEY];
  return all;
}

// Machine-specific bookkeeping is kept from this PC; everything else comes from the backup.
function mergeRestoredSettings(incoming, current, restoredSecrets) {
  const out = { ...incoming };
  const curBackup = current.backup || {};
  if (incoming.backup) {
    const providersIn = { ...(incoming.backup.providers || {}) };
    for (const id of Object.keys(providersIn)) {
      const signedIn = secrets.has(`backup.${id}.refreshToken`) || Boolean(restoredSecrets && restoredSecrets[`backup.${id}.refreshToken`]);
      if (!signedIn) providersIn[id] = { ...providersIn[id], account: null };
    }
    out.backup = {
      ...incoming.backup,
      providers: providersIn,
      lastCloudAt: curBackup.lastCloudAt || null,
      lastCloudAttemptAt: curBackup.lastCloudAttemptAt || null,
      lastCloudResult: curBackup.lastCloudResult || null,
    };
  } else {
    out.backup = current.backup;
  }
  const curTel = current.telemetry || {};
  out.telemetry = incoming.telemetry
    ? { ...curTel, enabled: incoming.telemetry.enabled !== false }
    : current.telemetry;
  return out;
}

function backupLocalNow() {
  const { buffer, extension } = buildFullBackup();
  const dir = getBackupDir();
  const name = uniqueName(dir, `devowatch-backup-${bundle.timestamp()}`, extension);
  writeFileAtomic(path.join(dir, name), buffer);
  pruneLocal(settings().localKeep);
  log.info(`Manual local backup ${name} (${buffer.length} bytes)`);
  broadcast('backup:changed', {});
  return { name, size: buffer.length };
}

// ---------------- cloud ----------------
function context(provider) {
  const cfg = settings().providers[provider.id];
  if (!cfg) throw new Error(`${provider.label} is not configured yet`);
  if (!runtime.has(provider.id)) runtime.set(provider.id, { tokens: {} });
  return {
    config: cfg,
    tokens: runtime.get(provider.id).tokens,
    getSecret: (key) => secrets.get(`backup.${provider.id}.${key}`),
    setSecret: (key, value) => secrets.set(`backup.${provider.id}.${key}`, value),
  };
}

function activeProvider() {
  const provider = providers.get(settings().cloudProvider);
  if (!provider) throw new Error('Choose and save a cloud provider first');
  return provider;
}

async function pruneRemote(provider, ctx, keep) {
  const ours = (await provider.list(ctx))
    .filter((i) => /^devowatch-backup-/.test(i.name) && NAME_RE.test(i.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const item of ours.slice(keep)) {
    await provider.remove(ctx, item.name);
    log.info(`Removed old cloud backup ${item.name}`);
  }
}

async function backupCloudNow(reason = 'manual') {
  if (busy) throw new Error(`A ${busy} is already running`);
  busy = 'cloud backup';
  const provider = activeProvider();
  const attemptAt = new Date().toISOString();
  try {
    const ctx = context(provider);
    progress('packing');
    const { buffer, extension } = buildFullBackup();
    const name = `devowatch-backup-${bundle.timestamp()}${extension}`;
    progress('uploading', { name, size: buffer.length });
    await provider.upload(ctx, name, buffer);
    progress('pruning');
    await pruneRemote(provider, ctx, settings().cloudKeep);
    const message = `Uploaded ${name} (${(buffer.length / 1024).toFixed(1)} KB) to ${provider.label}`;
    saveSettings({ lastCloudAt: attemptAt, lastCloudAttemptAt: attemptAt, lastCloudResult: { ok: true, at: attemptAt, message } });
    log.info(`Cloud backup (${reason}): ${message}`);
    return { name, size: buffer.length, message };
  } catch (err) {
    saveSettings({ lastCloudAttemptAt: attemptAt, lastCloudResult: { ok: false, at: attemptAt, message: err.message } });
    log.error(`Cloud backup (${reason}) failed: ${err.message}`);
    throw err;
  } finally {
    busy = null;
    progress('idle');
  }
}

function nextCloudRun(s = settings()) {
  if (!s.cloudEnabled || !s.cloudProvider) return null;
  const due = s.lastCloudAt ? Date.parse(s.lastCloudAt) + s.cloudIntervalHours * 3600000 : Date.now();
  const retry = s.lastCloudAttemptAt ? Date.parse(s.lastCloudAttemptAt) + CLOUD_RETRY_MS : 0;
  return Math.max(due, s.lastCloudAt === s.lastCloudAttemptAt ? 0 : retry);
}

function cloudTick() {
  const next = nextCloudRun();
  if (next === null || next > Date.now() || busy) return;
  backupCloudNow('scheduled').catch(() => {});
}

// ---------------- restore ----------------
async function readBackup(source, name) {
  if (!NAME_RE.test(String(name))) throw new Error('Invalid backup name');
  if (source === 'local') {
    const file = path.join(getBackupDir(), name);
    if (fs.statSync(file).size > bundle.MAX_BACKUP_BYTES) throw new Error('Backup file is too large');
    return fs.readFileSync(file);
  }
  if (source === 'cloud') {
    const provider = activeProvider();
    return provider.download(context(provider), name);
  }
  throw new Error('Unknown backup source');
}

async function restore({ source, name } = {}) {
  if (busy) throw new Error(`A ${busy} is already running`);
  busy = 'restore';
  try {
    progress('downloading', { name });
    const env = bundle.unpack(await readBackup(source, name), secrets.get(PASSPHRASE_KEY));
    snapshotConfig('before restore', { force: true });
    const restoredSecrets = env.secrets && typeof env.secrets === 'object' ? env.secrets : null;
    const current = config.getSettings();
    const incoming = { ...env.config, settings: mergeRestoredSettings(env.config.settings || {}, current, restoredSecrets) };
    config.replaceAll(incoming);
    if (env.db) db.replaceFrom(env.db);
    if (restoredSecrets) {
      for (const [key, value] of Object.entries(restoredSecrets)) {
        if (key.startsWith('backup.') && key !== PASSPHRASE_KEY && typeof value === 'string') secrets.set(key, value);
      }
      runtime.clear();
    }
    lastLocalHash = configHash(config.snapshot());
    log.info(`Restored ${env.kind} backup ${name} from ${source} (created ${env.createdAt}${restoredSecrets ? ', with credentials' : ''})`);
    onRestored();
    broadcast('backup:changed', {});
    return { kind: env.kind, createdAt: env.createdAt, hosts: incoming.hosts.length, history: Boolean(env.db), credentials: Boolean(restoredSecrets) };
  } finally {
    busy = null;
    progress('idle');
  }
}

// ---------------- settings / providers ----------------
function int(value, min, max, name) {
  const n = Math.round(Number(value));
  if (!(n >= min && n <= max)) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}

function updateSettings(patch = {}) {
  const out = {};
  if ('localEnabled' in patch) out.localEnabled = patch.localEnabled === true;
  if ('localKeep' in patch) out.localKeep = int(patch.localKeep, 1, 365, 'Local backups to keep');
  if ('cloudEnabled' in patch) out.cloudEnabled = patch.cloudEnabled === true;
  if ('cloudIntervalHours' in patch) out.cloudIntervalHours = int(patch.cloudIntervalHours, 1, 168, 'Backup interval');
  if ('cloudKeep' in patch) out.cloudKeep = int(patch.cloudKeep, 1, 365, 'Cloud backups to keep');
  if ('includeHistory' in patch) out.includeHistory = patch.includeHistory === true;
  if ('cloudProvider' in patch) {
    if (patch.cloudProvider && !providers.get(patch.cloudProvider)) throw new Error('Unknown provider');
    out.cloudProvider = patch.cloudProvider || '';
  }
  const next = saveSettings(out);
  if (out.localEnabled) snapshotConfig('local backup enabled');
  return next;
}

function setProvider(id, values = {}) {
  const provider = providers.get(id);
  if (!provider) throw new Error('Unknown provider');
  const s = settings();
  const previous = s.providers[id] || {};
  const plain = {};
  for (const field of provider.fields) {
    if (field.secret) continue;
    plain[field.key] = field.type === 'checkbox' ? values[field.key] === true : values[field.key];
  }
  const normalized = provider.validate({ ...plain, account: previous.account });
  for (const field of provider.fields.filter((f) => f.secret)) {
    const value = values[field.key];
    if (typeof value === 'string' && value) secrets.set(`backup.${id}.${field.key}`, value.slice(0, 4096));
    if (field.required && !secrets.has(`backup.${id}.${field.key}`)) throw new Error(`${field.label} is required`);
  }
  // A different OAuth app/tenant invalidates the existing sign-in.
  if (provider.oauth && ['clientId', 'tenant'].some((k) => previous[k] !== undefined && previous[k] !== normalized[k])) {
    secrets.set(`backup.${id}.refreshToken`, null);
    normalized.account = null;
  }
  runtime.delete(id);
  saveSettings({ providers: { ...s.providers, [id]: normalized }, cloudProvider: id });
  log.info(`Cloud backup provider configured: ${provider.label}`);
  return getStatus();
}

async function connect(id) {
  const provider = providers.get(id);
  if (!provider || !provider.oauth) throw new Error('This provider does not use sign-in');
  const { account } = await provider.connect(context(provider));
  const s = settings();
  saveSettings({ providers: { ...s.providers, [id]: { ...s.providers[id], account: account || null } } });
  log.info(`${provider.label} connected${account ? ` as ${account}` : ''}`);
  return getStatus();
}

function disconnect(id) {
  const provider = providers.get(id);
  if (!provider) throw new Error('Unknown provider');
  secrets.set(`backup.${id}.refreshToken`, null);
  runtime.delete(id);
  const s = settings();
  if (s.providers[id]) saveSettings({ providers: { ...s.providers, [id]: { ...s.providers[id], account: null } } });
  log.info(`${provider.label} disconnected`);
  return getStatus();
}

async function testConnection() {
  const provider = activeProvider();
  return provider.test(context(provider));
}

async function listCloud() {
  const provider = activeProvider();
  return (await provider.list(context(provider)))
    .filter((i) => NAME_RE.test(i.name))
    .sort((a, b) => b.name.localeCompare(a.name));
}

function setPassphrase(passphrase) {
  if (passphrase === null || passphrase === '') {
    secrets.set(PASSPHRASE_KEY, null);
    return getStatus();
  }
  if (typeof passphrase !== 'string' || passphrase.length < 8 || passphrase.length > 256) {
    throw new Error('Passphrase must be 8-256 characters');
  }
  secrets.set(PASSPHRASE_KEY, passphrase);
  return getStatus();
}

function getStatus() {
  const s = settings();
  return {
    local: { enabled: s.localEnabled, keep: s.localKeep, dir: getBackupDir(), backups: listLocal().slice(0, 100) },
    cloud: {
      provider: s.cloudProvider,
      enabled: s.cloudEnabled,
      intervalHours: s.cloudIntervalHours,
      keep: s.cloudKeep,
      includeHistory: s.includeHistory,
      lastCloudAt: s.lastCloudAt,
      lastResult: s.lastCloudResult,
      nextRunAt: nextCloudRun(s),
      busy,
    },
    passphraseSet: secrets.has(PASSPHRASE_KEY),
    providers: providers.list().map((p) => {
      const cfg = s.providers[p.id] || {};
      return {
        id: p.id,
        label: p.label,
        description: p.description,
        oauth: p.oauth,
        signInLabel: p.signInLabel || null,
        configured: Boolean(s.providers[p.id]),
        connected: p.oauth ? secrets.has(`backup.${p.id}.refreshToken`) : Boolean(s.providers[p.id]),
        account: cfg.account || null,
        fields: p.fields.map((f) => ({
          ...f,
          value: f.secret ? '' : (cfg[f.key] ?? f.default ?? (f.type === 'checkbox' ? false : '')),
          isSet: f.secret ? secrets.has(`backup.${p.id}.${f.key}`) : undefined,
        })),
      };
    }),
  };
}

// ---------------- lifecycle ----------------
function init(options) {
  broadcast = options.broadcast || broadcast;
  appVersion = options.appVersion || appVersion;
  onRestored = options.onRestored || onRestored;
  const newest = listLocal().find((b) => b.kind === 'config');
  if (newest) {
    try {
      lastLocalHash = configHash(bundle.unpack(fs.readFileSync(path.join(getBackupDir(), newest.name))).config);
    } catch {
      lastLocalHash = null;
    }
  }
  try {
    snapshotConfig('startup');
  } catch (err) {
    log.error(`Startup backup failed: ${err.message}`);
  }
  config.onSave(scheduleLocal);
  cloudTimer = setInterval(cloudTick, CLOUD_TICK_MS);
  setTimeout(cloudTick, 60 * 1000);
}

// Writes any pending automatic backup before the app exits.
function stop() {
  if (cloudTimer) clearInterval(cloudTimer);
  if (localTimer) {
    clearTimeout(localTimer);
    localTimer = null;
    try {
      snapshotConfig('shutdown');
    } catch (err) {
      log.error(`Shutdown backup failed: ${err.message}`);
    }
  }
}

module.exports = {
  init,
  stop,
  getStatus,
  updateSettings,
  setProvider,
  connect,
  disconnect,
  testConnection,
  setPassphrase,
  backupLocalNow,
  backupCloudNow,
  listLocal,
  listCloud,
  restore,
};
