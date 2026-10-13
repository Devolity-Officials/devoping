// Recent alerts (host down/recovered, SSL and domain expiry) shown in the sidebar.
// Persisted to devoping_data/alerts.json so the latest alerts survive a restart.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const log = require('./logger');
const { getDataDir } = require('./paths');
const { writeFileAtomic } = require('./fsutil');

const MAX_ALERTS = 50;
const SAVE_DELAY_MS = 3000;
const LEVEL_RANK = { ok: 0, warning: 1, critical: 2, expired: 3 };

let alerts = null;
let broadcastFn = () => {};
let saveTimer = null;
const lastState = new Map(); // `${hostId}|${checkType}|${port}` -> is up
const sslLevels = new Map(); // hostId -> expiry level

function filePath() {
  return path.join(getDataDir(), 'alerts.json');
}

function load() {
  if (alerts) return alerts;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    alerts = Array.isArray(parsed) ? parsed.filter((a) => a && typeof a.id === 'string').slice(0, MAX_ALERTS) : [];
  } catch {
    alerts = [];
  }
  return alerts;
}

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, SAVE_DELAY_MS);
}

function flush() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!alerts) return;
  try {
    writeFileAtomic(filePath(), JSON.stringify(alerts));
  } catch (err) {
    log.warn(`Could not save alerts: ${err.message}`);
  }
}

function setBroadcaster(fn) {
  broadcastFn = fn;
}

function add({ severity, title, message = '', hostId = null, domainId = null }) {
  const alert = { id: crypto.randomUUID(), ts: Date.now(), severity, title, message, hostId, domainId, read: false };
  const list = load();
  list.unshift(alert);
  if (list.length > MAX_ALERTS) list.length = MAX_ALERTS;
  persist();
  broadcastFn('alerts:new', alert);
  return alert;
}

function list() {
  return load();
}

function markRead() {
  load().forEach((a) => { a.read = true; });
  persist();
  return load();
}

function clear() {
  alerts = [];
  persist();
  return alerts;
}

function expiryLevel(days, warnDays, criticalDays) {
  if (days === null || days === undefined) return null;
  if (days <= 0) return 'expired';
  if (days <= criticalDays) return 'critical';
  if (days <= warnDays) return 'warning';
  return 'ok';
}

const stateKey = (row) => `${row.host_id}|${row.check_type}|${row.port ?? ''}`;
const checkLabel = (row) => (row.check_type === 'tcp' ? `TCP ${row.port}` : row.check_type === 'ping' ? 'Ping' : 'HTTP');

function sslLevel(row) {
  const s = config.getSettings();
  return expiryLevel(row.ssl_days_remaining, s.sslWarnDays, s.sslCriticalDays);
}

// Seeds the last known state from history so a restart doesn't re-alert on unchanged hosts.
function seed(latestRows) {
  for (const row of latestRows) {
    lastState.set(stateKey(row), Boolean(row.is_up));
    const level = sslLevel(row);
    if (level) sslLevels.set(row.host_id, level);
  }
}

// One alert per host per check run: what went down, what recovered, and SSL expiry changes.
function recordHostResults(host, rows) {
  const down = [];
  const recovered = [];
  for (const row of rows) {
    const key = stateKey(row);
    const prev = lastState.get(key);
    const up = Boolean(row.is_up);
    lastState.set(key, up);
    if (!up && prev !== false) down.push(`${checkLabel(row)}: ${row.error || 'no response'}`);
    else if (up && prev === false) recovered.push(checkLabel(row));

    const level = sslLevel(row);
    if (level) {
      const prevLevel = sslLevels.get(host.id) || 'ok';
      sslLevels.set(host.id, level);
      if (LEVEL_RANK[level] > LEVEL_RANK[prevLevel]) {
        add({
          severity: level === 'warning' ? 'warning' : 'danger',
          title: `${host.name}: SSL ${level === 'expired' ? 'certificate expired' : 'expiring soon'}`,
          message: level === 'expired' ? 'The certificate is no longer valid' : `${row.ssl_days_remaining} day(s) left`,
          hostId: host.id,
        });
      }
    }
  }
  if (down.length) {
    const allDown = rows.every((r) => !r.is_up);
    add({ severity: 'danger', title: `${host.name} ${allDown ? 'is down' : 'has failing checks'}`, message: down.join(' · '), hostId: host.id });
  }
  if (recovered.length) {
    add({ severity: 'success', title: `${host.name} recovered`, message: `${recovered.join(', ')} responding again`, hostId: host.id });
  }
}

function forgetHost(hostId) {
  for (const key of [...lastState.keys()]) if (key.startsWith(`${hostId}|`)) lastState.delete(key);
  sslLevels.delete(hostId);
}

module.exports = { setBroadcaster, add, list, markRead, clear, flush, seed, recordHostResults, forgetHost, expiryLevel, LEVEL_RANK };
