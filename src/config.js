// JSON-backed store for app settings, monitored hosts and user accounts.
// Historical check results live in the SQLite (sql.js) database instead - see db.js.
const fs = require('fs');
const crypto = require('crypto');
const { getConfigPath } = require('./paths');
const { writeFileAtomic, quarantine } = require('./fsutil');
const log = require('./logger');

const DEFAULT_CONFIG = {
  settings: {
    retentionDays: 7,
    defaultIntervalMinutes: 5,
    sslWarnDays: 30,
    sslCriticalDays: 7,
    dnsServers: [],
  },
  hosts: [],
  users: [],
};

let cache = null;
const saveListeners = [];

function parseConfig(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
  return {
    settings: { ...DEFAULT_CONFIG.settings, ...(parsed.settings || {}) },
    hosts: Array.isArray(parsed.hosts) ? parsed.hosts.filter((h) => h && typeof h.id === 'string') : [],
    users: Array.isArray(parsed.users) ? parsed.users.filter((u) => u && u.username && u.passwordHash) : [],
  };
}

// Loads config.json; if it is damaged, restores the last-known-good backup (config.json.bak).
// Never silently falls back to defaults when a file exists - that would wipe the admin account.
function load() {
  if (cache) return cache;
  const filePath = getConfigPath();
  const backupPath = `${filePath}.bak`;
  if (!fs.existsSync(filePath) && !fs.existsSync(backupPath)) {
    cache = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    save();
    return cache;
  }
  try {
    cache = parseConfig(fs.readFileSync(filePath, 'utf8'));
    fs.copyFileSync(filePath, backupPath);
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
  writeFileAtomic(getConfigPath(), JSON.stringify(cache, null, 2));
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
  getUsers,
  hasUsers,
  findUser,
  addUser,
  updateUser,
};
