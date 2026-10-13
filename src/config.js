// JSON-backed store for app settings, monitored hosts and user accounts.
// Historical check results live in the SQLite (sql.js) database instead - see db.js.
const fs = require('fs');
const crypto = require('crypto');
const { getConfigPath, getConfigBackupPath } = require('./paths');
const { writeFileAtomic, quarantine } = require('./fsutil');
const log = require('./logger');

const WATCH_INTERVAL_MS = 3000;

const DEFAULT_CONFIG = {
  settings: {
    retentionDays: 7,
    defaultIntervalMinutes: 5,
    sslWarnDays: 30,
    sslCriticalDays: 7,
    domainWarnDays: 30,
    domainCriticalDays: 7,
    dnsServers: [],
  },
  hosts: [],
  domains: [],
  users: [],
};

let cache = null;
let lastSig = null; // mtime/size of config.json as last read or written by the app
let watching = false;
const saveListeners = [];
const reloadListeners = [];

// Entries without an id (hand-written or older files) get a stable one derived from their content.
function withId(item, i, prefix) {
  if (typeof item.id === 'string' && item.id) return item;
  if (item.id !== undefined && item.id !== null && item.id !== '') return { ...item, id: String(item.id) };
  const hash = crypto.createHash('sha1').update(JSON.stringify([i, item.name, item.url, item.ip])).digest('hex');
  return { ...item, id: `${prefix}-${hash.slice(0, 32)}` };
}

const list = (value) => (Array.isArray(value) ? value : []);

function parseConfig(raw) {
  // Windows editors often save JSON with a UTF-8 BOM, which JSON.parse rejects.
  let parsed = typeof raw === 'string' ? JSON.parse(raw.replace(/^\uFEFF/, '')) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
  // A backup snapshot (devoping-config-*.json) copied in as config.json is accepted as well.
  if (!parsed.users && parsed.config && typeof parsed.config === 'object') parsed = parsed.config;
  return {
    settings: { ...DEFAULT_CONFIG.settings, ...(parsed.settings || {}) },
    hosts: list(parsed.hosts)
      .filter((h) => h && typeof h === 'object' && (h.url || h.ip))
      .map((h, i) => ({ ...withId(h, i, 'h'), name: h.name || h.url || h.ip, enabled: h.enabled !== false })),
    domains: list(parsed.domains)
      .filter((d) => d && typeof d.name === 'string' && d.name)
      .map((d, i) => withId(d, i, 'd')),
    users: list(parsed.users).filter((u) => u && typeof u.username === 'string' && u.username && typeof u.passwordHash === 'string'),
  };
}

function fileSig(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

// Picks up a config.json that was copied in or edited while the app is running.
function watch() {
  if (watching) return;
  watching = true;
  fs.watchFile(getConfigPath(), { interval: WATCH_INTERVAL_MS, persistent: false }, () => reloadFromDisk());
}

// `beforeSave`: the app is about to write, so an unreadable file is moved aside instead of overwritten.
function reloadFromDisk({ beforeSave = false } = {}) {
  const filePath = getConfigPath();
  const sig = fileSig(filePath);
  if (!sig || sig === lastSig) return false;
  lastSig = sig;
  let next;
  try {
    next = parseConfig(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    log.warn(`config.json changed on disk but can't be read (${err.message}); keeping the current configuration`);
    if (beforeSave) log.warn(`Unreadable config.json moved to ${quarantine(filePath)}`);
    return false;
  }
  if (!next.users.length) {
    log.warn('config.json changed on disk but contains no user accounts; keeping the current configuration');
    if (beforeSave) log.warn(`config.json without users moved to ${quarantine(filePath)}`);
    return false;
  }
  cache = next;
  try {
    fs.copyFileSync(filePath, getConfigBackupPath());
  } catch (err) {
    log.warn(`Could not update config.json.bak: ${err.message}`);
  }
  log.info(`config.json replaced on disk - reloaded ${cache.hosts.length} hosts, ${cache.domains.length} domains, ${cache.users.length} users`);
  for (const fn of [...saveListeners, ...reloadListeners]) {
    try {
      fn(cache);
    } catch (err) {
      log.error(`Config reload listener failed: ${err.message}`);
    }
  }
  return true;
}

// Loads config.json; if it is damaged, restores the last-known-good backup (config.json.bak).
// Never silently falls back to defaults when a file exists - that would wipe the admin account.
function load() {
  if (cache) return cache;
  const filePath = getConfigPath();
  const backupPath = getConfigBackupPath();
  watch();
  if (!fs.existsSync(filePath) && !fs.existsSync(backupPath)) {
    cache = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    save();
    return cache;
  }
  try {
    cache = parseConfig(fs.readFileSync(filePath, 'utf8'));
    lastSig = fileSig(filePath);
    fs.copyFileSync(filePath, backupPath);
    log.info(`Loaded ${filePath}: ${cache.hosts.length} hosts, ${cache.domains.length} domains, ${cache.users.length} users`);
    return cache;
  } catch (err) {
    log.error(`Config file ${filePath} is unreadable: ${err.message}`);
  }
  try {
    cache = parseConfig(fs.readFileSync(backupPath, 'utf8'));
  } catch (err) {
    throw new Error(`Configuration file is damaged and no valid backup exists.\n\n${filePath}\n\n`
      + 'Restore it from a backup, or delete it to start over (this removes users and hosts).');
  }
  if (fs.existsSync(filePath)) log.warn(`Damaged config moved to ${quarantine(filePath)}`);
  save();
  log.warn('Configuration restored from config.json.bak');
  return cache;
}

function save() {
  // A config.json copied in since the last read wins over in-memory changes (never overwrite it).
  if (lastSig && fileSig(getConfigPath()) !== lastSig && reloadFromDisk({ beforeSave: true })) return;
  writeFileAtomic(getConfigPath(), JSON.stringify(cache, null, 2));
  lastSig = fileSig(getConfigPath());
  for (const fn of saveListeners) {
    try {
      fn(cache);
    } catch (err) {
      log.error(`Config save listener failed: ${err.message}`);
    }
  }
}

// Called after every successful save (used by the automatic local backup).
function onSave(fn) {
  saveListeners.push(fn);
}

// Called when config.json was replaced on disk and reloaded.
function onReload(fn) {
  reloadListeners.push(fn);
}

// Deep copy of the whole configuration (settings, hosts, users) for backups.
function snapshot() {
  return JSON.parse(JSON.stringify(load()));
}

// Replaces the whole configuration (restore from backup). Validates like a file load.
function replaceAll(data) {
  const next = parseConfig(data);
  if (!next.users.length) throw new Error('Backup contains no user accounts; refusing to restore it.');
  cache = next;
  save();
  return cache;
}

// ---- settings ----
function getSettings() {
  return load().settings;
}

function updateSettings(partial) {
  const cfg = load();
  cfg.settings = { ...cfg.settings, ...partial };
  save();
  return cfg.settings;
}

// ---- hosts ----
function getHosts() {
  return load().hosts;
}

function getHost(id) {
  return load().hosts.find((h) => h.id === id) || null;
}

function addHost(host) {
  const cfg = load();
  const newHost = buildHost(host, cfg.settings);
  cfg.hosts.push(newHost);
  save();
  return newHost;
}

function addHosts(hosts) {
  const cfg = load();
  const created = hosts.map((h) => buildHost(h, cfg.settings));
  cfg.hosts.push(...created);
  save();
  return created;
}

function buildHost(host, settings) {
  const newHost = {
    id: crypto.randomUUID(),
    name: host.name || host.url || host.ip,
    url: host.url ? host.url.trim() : '',
    ip: host.ip ? host.ip.trim() : '',
    ipAuto: Boolean(host.ipAuto),
    ports: Array.isArray(host.ports) ? host.ports : [],
    pingPort: host.pingPort || null,
    method: typeof host.method === 'string' ? host.method : 'GET',
    expectStatus: typeof host.expectStatus === 'string' ? host.expectStatus : '',
    headers: Array.isArray(host.headers) ? host.headers : [],
    bodyMatch: typeof host.bodyMatch === 'string' ? host.bodyMatch : '',
    body: typeof host.body === 'string' ? host.body : '',
    followRedirects: host.followRedirects !== false,
    intervalMinutes: Number(host.intervalMinutes) || settings.defaultIntervalMinutes,
    enabled: host.enabled !== false,
    createdAt: new Date().toISOString(),
  };
  if (!newHost.url && !newHost.ip) {
    throw new Error('Host must have a URL or an IP address');
  }
  return newHost;
}

function updateHost(id, partial) {
  const cfg = load();
  const idx = cfg.hosts.findIndex((h) => h.id === id);
  if (idx === -1) throw new Error('Host not found');
  cfg.hosts[idx] = {
    ...cfg.hosts[idx],
    ...partial,
    id: cfg.hosts[idx].id,
    updatedAt: new Date().toISOString(),
  };
  save();
  return cfg.hosts[idx];
}

function deleteHost(id) {
  const cfg = load();
  const before = cfg.hosts.length;
  cfg.hosts = cfg.hosts.filter((h) => h.id !== id);
  save();
  return cfg.hosts.length < before;
}

// ---- domains (WHOIS / expiry watch list) ----
function getDomains() {
  return load().domains;
}

function getDomain(id) {
  return load().domains.find((d) => d.id === id) || null;
}

function addDomain(name) {
  const cfg = load();
  const domain = { id: crypto.randomUUID(), name, addedAt: new Date().toISOString() };
  cfg.domains.push(domain);
  save();
  return domain;
}

function updateDomain(id, partial) {
  const cfg = load();
  const idx = cfg.domains.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  cfg.domains[idx] = { ...cfg.domains[idx], ...partial, id: cfg.domains[idx].id, name: cfg.domains[idx].name };
  save();
  return cfg.domains[idx];
}

function deleteDomain(id) {
  const cfg = load();
  const before = cfg.domains.length;
  cfg.domains = cfg.domains.filter((d) => d.id !== id);
  save();
  return cfg.domains.length < before;
}

// ---- users ----
function getUsers() {
  return load().users;
}

function hasUsers() {
  return load().users.length > 0;
}

function findUser(username) {
  return load().users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
}

function addUser(user) {
  const cfg = load();
  cfg.users.push(user);
  save();
  return user;
}

function updateUser(username, partial) {
  const cfg = load();
  const idx = cfg.users.findIndex((u) => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) throw new Error('User not found');
  cfg.users[idx] = { ...cfg.users[idx], ...partial };
  save();
  return cfg.users[idx];
}

module.exports = {
  load,
  onSave,
  onReload,
  snapshot,
  replaceAll,
  getSettings,
  updateSettings,
  getHosts,
  getHost,
  addHost,
  addHosts,
  updateHost,
  deleteHost,
  getDomains,
  getDomain,
  addDomain,
  updateDomain,
  deleteDomain,
  getUsers,
  hasUsers,
  findUser,
  addUser,
  updateUser,
};
