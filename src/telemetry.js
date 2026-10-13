// Anonymous usage telemetry.
//
// - ON by default; users can turn it off in Settings (the choice is remembered).
// - The collection endpoint is DEFAULT_ENDPOINT below (built into the app); administrators can
//   override it or force telemetry off with <install dir>/policy.json:
//     { "telemetry": false }   or   { "telemetry": true, "telemetryEndpoint": "https://..." }
//   or the environment variable DEVOPING_TELEMETRY=0 (DEVOWATCH_TELEMETRY remains supported).
// - Only aggregate counters and coarse environment info are sent: never hostnames, URLs, IPs,
//   usernames, error messages or file paths (enforced by sanitizeProps below).
// - The install ID is random (not derived from hardware) and is discarded when telemetry is disabled.
// - Events are queued in devoping_data/session/telemetry-queue.json and POSTed over HTTPS in batches.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const log = require('./logger');
const { getSessionDir, getInstallDir } = require('./paths');
const { writeFileAtomic } = require('./fsutil');

const SCHEMA = 1;
// Grafana Cloud Frontend Observability (Faro) collector; the app key in the URL is public by design.
const DEFAULT_ENDPOINT = 'https://faro-collector-prod-ap-southeast-1.grafana.net/collect/527a72708b642cdc6b4dbda702678f92';
const FARO_RE = /^https:\/\/faro-collector-[a-z0-9-]+\.grafana\.net\/collect\/[a-z0-9]+\/?$/i;
// Usage is auto-submitted on this interval (a heartbeat 'usage' event is sent every time).
const FLUSH_INTERVAL_MS = 15 * 60 * 1000;
const FIRST_FLUSH_DELAY_MS = 10 * 1000;
const EXIT_FLUSH_TIMEOUT_MS = 3000;
const MAX_QUEUE = 500;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const ENUM_RE = /^[a-z0-9_.-]{1,40}$/i;
// The only text values ever sent; everything else must be a number or boolean.
const STRING_PROPS = {
  version: /^\d+(\.\d+){0,3}(-[a-z0-9.]+)?$/i,
  cloud_backup: /^(none|s3|gdrive|onedrive)$/,
};

let appInfo = { version: '0.0.0', electron: '', locale: '', environment: 'production' };
const sessionId = crypto.randomBytes(8).toString('hex'); // one per app run
let counters = {};
let periodStart = Date.now();
let timer = null;
let backoffMs = 0;
let nextAttemptAt = 0;
let sending = false;
let cachedPolicy = null;

function policy() {
  if (cachedPolicy) return cachedPolicy;
  const out = { locked: false, enabled: null, endpoint: null };
  if (process.env.DEVOPING_TELEMETRY === '0' || process.env.DEVOWATCH_TELEMETRY === '0') {
    cachedPolicy = { ...out, locked: true, enabled: false, source: 'environment variable telemetry opt-out' };
    return cachedPolicy;
  }
  try {
    const p = JSON.parse(fs.readFileSync(path.join(getInstallDir(), 'policy.json'), 'utf8'));
    if (typeof p.telemetry === 'boolean') Object.assign(out, { locked: true, enabled: p.telemetry, source: 'policy.json' });
    if (typeof p.telemetryEndpoint === 'string') out.endpoint = validateEndpoint(p.telemetryEndpoint) || null;
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`Ignoring invalid policy.json: ${err.message}`);
  }
  cachedPolicy = out;
  return out;
}

function settings() {
  return { enabled: true, installId: null, lastSentAt: null, lastResult: null, ...(config.getSettings().telemetry || {}) };
}

function saveSettings(patch) {
  config.updateSettings({ telemetry: { ...settings(), ...patch } });
}

function effective() {
  const s = settings();
  const p = policy();
  return {
    enabled: p.locked ? p.enabled : s.enabled,
    endpoint: p.endpoint || DEFAULT_ENDPOINT,
    policy: p,
    settings: s,
  };
}

function validateEndpoint(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('Invalid telemetry endpoint URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('Telemetry endpoint must use https://');
  if (u.username || u.password) throw new Error('Do not put credentials in the endpoint URL');
  return u.toString();
}

// Only numbers, booleans and a few allow-listed enum strings - free text can carry personal data.
function sanitizeProps(props = {}) {
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (!/^[a-z0-9_]{1,40}$/i.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && STRING_PROPS[k] && STRING_PROPS[k].test(v)) out[k] = v;
  }
  return out;
}

function count(name, by = 1) {
  if (!effective().enabled || !ENUM_RE.test(name)) return;
  counters[name] = (counters[name] || 0) + by;
}

function queuePath() {
  return path.join(getSessionDir(), 'telemetry-queue.json');
}

function readQueue() {
  try {
    const q = JSON.parse(fs.readFileSync(queuePath(), 'utf8'));
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

function writeQueue(events) {
  if (!events.length) {
    try { fs.unlinkSync(queuePath()); } catch { /* none */ }
    return;
  }
  writeFileAtomic(queuePath(), JSON.stringify(events.slice(-MAX_QUEUE)));
}

function enqueue(name, props) {
  if (!effective().enabled) return;
  writeQueue([...readQueue(), { name, ts: Date.now(), props: sanitizeProps(props) }]);
}

function usageEvent() {
  const hosts = config.getHosts();
  return {
    name: 'usage',
    ts: Date.now(),
    props: sanitizeProps({
      period_hours: (Date.now() - periodStart) / 3600000,
      hosts: hosts.length,
      hosts_enabled: hosts.filter((h) => h.enabled).length,
      hosts_with_url: hosts.filter((h) => h.url).length,
      hosts_with_ip: hosts.filter((h) => h.ip).length,
      hosts_with_ports: hosts.filter((h) => Array.isArray(h.ports) && h.ports.length).length,
      ports_monitored: hosts.reduce((n, h) => n + (Array.isArray(h.ports) ? h.ports.length : 0), 0),
      domains_watched: config.getDomains().length,
      global_dns: (config.getSettings().dnsServers || []).length > 0,
      ...counters,
    }),
  };
}

function payload(events) {
  return {
    schema: SCHEMA,
    installId: effective().settings.installId,
    sentAt: new Date().toISOString(),
    app: { name: 'Devoping', version: appInfo.version, electron: appInfo.electron },
    os: { platform: process.platform, release: os.release(), arch: process.arch, locale: appInfo.locale },
    events,
  };
}

// Grafana Faro receiver format: event attributes must be strings, measurement values numbers.
function faroPayload(events) {
  const installId = effective().settings.installId || '';
  const iso = (ts) => new Date(ts).toISOString();
  return {
    meta: {
      sdk: { name: 'devoping-telemetry', version: String(SCHEMA) },
      app: { name: 'Devoping', version: appInfo.version, environment: appInfo.environment },
      user: { id: installId },
      session: { id: sessionId },
      page: { url: 'app://devoping/' },
      browser: { name: 'Electron', version: appInfo.electron, os: `${process.platform} ${os.release()} ${process.arch}`, language: appInfo.locale },
      view: { name: 'desktop' },
    },
    events: events.map((e) => ({
      name: e.name,
      domain: 'devoping',
      attributes: Object.fromEntries(Object.entries(e.props || {}).map(([k, v]) => [k, String(v)])),
      timestamp: iso(e.ts),
    })),
    measurements: events.filter((e) => e.name === 'usage').map((e) => ({
      type: 'devoping_usage',
      values: Object.fromEntries(Object.entries(e.props).filter(([, v]) => typeof v !== 'string').map(([k, v]) => [k, Number(v)])),
      timestamp: iso(e.ts),
    })),
  };
}

async function flush({ force = false, heartbeat = false, timeoutMs = 15000 } = {}) {
  const eff = effective();
  if (!eff.enabled || sending) return { skipped: true };
  if (!force && Date.now() < nextAttemptAt) return { skipped: true };
  if (heartbeat || Object.keys(counters).length || Date.now() - periodStart >= FLUSH_INTERVAL_MS) {
    enqueue('usage', usageEvent().props);
    counters = {};
    periodStart = Date.now();
  }
  const events = readQueue();
  if (!events.length) return { sent: 0 };
  if (!eff.endpoint) return { skipped: true, reason: 'no endpoint configured' };
  sending = true;
  const faro = FARO_RE.test(eff.endpoint);
  try {
    const res = await fetch(eff.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `Devoping/${appInfo.version} (+https://devolity.com)`,
        ...(faro ? { 'X-Faro-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify(faro ? faroPayload(events) : payload(events)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeQueue(readQueue().slice(events.length));
    backoffMs = 0;
    nextAttemptAt = 0;
    saveSettings({ lastSentAt: new Date().toISOString(), lastResult: `Sent ${events.length} event(s)` });
    return { sent: events.length };
  } catch (err) {
    backoffMs = Math.min(backoffMs ? backoffMs * 2 : 5 * 60 * 1000, MAX_BACKOFF_MS);
    nextAttemptAt = Date.now() + backoffMs;
    saveSettings({ lastResult: `Upload failed (${err.message}); retrying later` });
    log.warn(`Telemetry upload failed: ${err.message}`);
    return { error: err.message };
  } finally {
    sending = false;
  }
}

function getStatus() {
  const eff = effective();
  return {
    enabled: eff.enabled,
    locked: eff.policy.locked,
    lockedReason: eff.policy.source || null,
    intervalMinutes: FLUSH_INTERVAL_MS / 60000,
    lastSentAt: eff.settings.lastSentAt || null,
    lastResult: eff.settings.lastResult || null,
  };
}

function update({ enabled } = {}) {
  const eff = effective();
  const patch = {};
  if (enabled !== undefined) {
    if (eff.policy.locked && enabled !== eff.policy.enabled) throw new Error(`Telemetry is managed by your administrator (${eff.policy.source})`);
    patch.enabled = enabled === true;
    if (patch.enabled && !eff.settings.installId) patch.installId = crypto.randomUUID();
    if (!patch.enabled) {
      patch.installId = null;
      counters = {};
      writeQueue([]);
    }
  }
  saveSettings(patch);
  if (patch.enabled) {
    enqueue('telemetry_enabled', {});
    setTimeout(() => flush({ force: true }), 2000);
  }
  log.info(`Telemetry settings updated (enabled=${effective().enabled})`);
  return getStatus();
}

function init(info) {
  appInfo = { ...appInfo, ...info };
  cachedPolicy = null;
  const eff = effective();
  if (eff.enabled && !eff.settings.installId) saveSettings({ installId: crypto.randomUUID() });
  if (eff.policy.locked) log.info(`Telemetry ${eff.enabled ? 'enabled' : 'disabled'} by ${eff.policy.source}`);
  enqueue('app_start', { version: appInfo.version.replace(/[^0-9a-z.-]/gi, '') });
  timer = setInterval(() => flush({ heartbeat: true }), FLUSH_INTERVAL_MS);
  setTimeout(() => flush({ heartbeat: true }), FIRST_FLUSH_DELAY_MS);
}

// Sends whatever is queued before the app exits (bounded so quitting never hangs).
async function stop() {
  if (timer) clearInterval(timer);
  if (!effective().enabled) return;
  if (Object.keys(counters).length) {
    enqueue('usage', usageEvent().props);
    counters = {};
  }
  await flush({ force: true, timeoutMs: EXIT_FLUSH_TIMEOUT_MS }).catch(() => {});
}

module.exports = { init, stop, count, flush, getStatus, update, sanitizeProps };
