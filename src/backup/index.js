// Local backup manager (portable): every backup lives in <app-home>/devoping_data/backup.
//  - automatic configuration snapshots after each real config change,
//  - manual full backups (config + optional check history), optionally AES-256 encrypted,
//  - restore from any local backup (a safety snapshot is always taken first).
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

const DEFAULTS = {
  localEnabled: true,
  localKeep: 30,
  includeHistory: true,
};
const LOCAL_DEBOUNCE_MS = 5000;
const NAME_RE = /^(?:devoping|devowatch)-(config|backup)-\d{8}-\d{6}(-\d+)?\.json(\.gz)?(\.enc)?$/;
const PASSPHRASE_KEY = 'backup.passphrase';

let broadcast = () => {};
let appVersion = '0.0.0';
let onRestored = () => {};
let localTimer = null;
let lastLocalHash = null;
let busy = null;

function settings() {
  const s = config.getSettings().backup || {};
  return { ...DEFAULTS, ...s };
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
  if (copy.settings && copy.settings.telemetry) {
    delete copy.settings.telemetry.lastSentAt;
    delete copy.settings.telemetry.lastResult;
  }
  copy.hosts = (copy.hosts || []).map(({ updatedAt, ...h }) => (h.ipAuto ? { ...h, ip: '' } : h));
  copy.domains = (copy.domains || []).map(({ id, name, addedAt }) => ({ id, name, addedAt }));
  copy.users = (copy.users || []).map(({ lastLoginAt, previousLoginAt, loginCount, ...u }) => u);
  return crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

function uniqueName(dir, base, ext) {
  let name = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}${ext}`;
  return name;
}

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
  const name = uniqueName(dir, `devoping-config-${bundle.timestamp()}`, '.json');
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
  });
  return bundle.pack(env, passphrase);
}

function backupLocalNow() {
  const { buffer, extension } = buildFullBackup();
  const dir = getBackupDir();
  const name = uniqueName(dir, `devoping-backup-${bundle.timestamp()}`, extension);
  writeFileAtomic(path.join(dir, name), buffer);
  pruneLocal(settings().localKeep);
  log.info(`Manual local backup ${name} (${buffer.length} bytes)`);
  broadcast('backup:changed', {});
  return { name, size: buffer.length };
}

// Machine-specific telemetry bookkeeping stays from this PC; everything else comes from the backup.
function mergeRestoredSettings(incoming, current) {
  const out = { ...incoming };
  const curTel = current.telemetry || {};
  out.telemetry = incoming.telemetry
    ? { ...curTel, enabled: incoming.telemetry.enabled !== false }
    : current.telemetry;
  return out;
}

async function restore({ source, name } = {}) {
  if (source !== 'local') throw new Error('Unknown backup source');
  if (!NAME_RE.test(String(name))) throw new Error('Invalid backup name');
  if (busy) throw new Error(`A ${busy} is already running`);
  busy = 'restore';
  try {
    progress('restoring', { name });
    const file = path.join(getBackupDir(), name);
    if (fs.statSync(file).size > bundle.MAX_BACKUP_BYTES) throw new Error('Backup file is too large');
    const env = bundle.unpack(fs.readFileSync(file), secrets.get(PASSPHRASE_KEY));
    snapshotConfig('before restore', { force: true });
    const current = config.getSettings();
    const incoming = { ...env.config, settings: mergeRestoredSettings(env.config.settings || {}, current) };
    config.replaceAll(incoming);
    if (env.db) db.replaceFrom(env.db);
    lastLocalHash = configHash(config.snapshot());
    log.info(`Restored ${env.kind} backup ${name} (created ${env.createdAt})`);
    onRestored();
    broadcast('backup:changed', {});
    return { kind: env.kind, createdAt: env.createdAt, hosts: incoming.hosts.length, history: Boolean(env.db) };
  } finally {
    busy = null;
    progress('idle');
  }
}

function int(value, min, max, name) {
  const n = Math.round(Number(value));
  if (!(n >= min && n <= max)) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}

function updateSettings(patch = {}) {
  const out = {};
  if ('localEnabled' in patch) out.localEnabled = patch.localEnabled === true;
  if ('localKeep' in patch) out.localKeep = int(patch.localKeep, 1, 365, 'Local backups to keep');
  if ('includeHistory' in patch) out.includeHistory = patch.includeHistory === true;
  const next = saveSettings(out);
  if (out.localEnabled) snapshotConfig('local backup enabled');
  return next;
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
    local: { enabled: s.localEnabled, keep: s.localKeep, includeHistory: s.includeHistory, dir: getBackupDir(), backups: listLocal().slice(0, 100) },
    passphraseSet: secrets.has(PASSPHRASE_KEY),
    busy,
  };
}

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
}

// Writes any pending automatic backup before the app exits.
function stop() {
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
  setPassphrase,
  backupLocalNow,
  listLocal,
  restore,
};
