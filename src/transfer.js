// Import/export of the host list (JSON, CSV, plain URL/IP lists) and check-history CSV export.
const net = require('net');
const config = require('./config');
const { parsePorts, formatPorts } = require('./ports');

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_HOSTS = 5000;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;
const HOST_FIELDS = ['name', 'url', 'ip', 'ports', 'pingPort', 'intervalMinutes', 'enabled'];
const HISTORY_FIELDS = [
  'timestamp', 'host_name', 'check_type', 'target', 'port', 'is_up', 'latency_ms', 'http_status',
  'resolved_ip', 'ssl_days_remaining', 'ssl_valid_to', 'ssl_issuer', 'detail', 'error',
];

function parseBool(v) {
  if (typeof v === 'boolean') return v;
  return !/^(false|0|no|off|disabled)$/i.test(String(v ?? '').trim());
}

function normalizeUrl(value) {
  let s = String(value || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`unsupported protocol ${u.protocol}`);
  if (!u.hostname) throw new Error('missing hostname');
  return u.toString();
}

function normalizeIp(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (net.isIP(s) || HOSTNAME_RE.test(s)) return s;
  throw new Error(`invalid IP/hostname "${s}"`);
}

// Empty means "use the default fallback ports".
function parsePingPort(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Ping fallback port must be 1-65535 (got "${s}")`);
  return n;
}

// Validates one imported record into the shape config.addHosts expects.
function sanitizeHost(raw, defaultInterval) {
  const url = normalizeUrl(raw.url);
  const ip = normalizeIp(raw.ip);
  if (!url && !ip) throw new Error('needs a URL or IP');
  const interval = Math.round(Number(raw.intervalMinutes ?? raw.interval));
  return {
    name: String(raw.name || '').trim().slice(0, 200) || (url ? new URL(url).hostname : ip),
    url,
    ip,
    ipAuto: false,
    ports: parsePorts(raw.ports),
    pingPort: parsePingPort(raw.pingPort),
    intervalMinutes: interval >= 1 && interval <= 1440 ? interval : defaultInterval,
    enabled: raw.enabled === undefined || raw.enabled === '' ? true : parseBool(raw.enabled),
  };
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim()));
}

const HEADER_ALIASES = {
  name: 'name', host: 'name', title: 'name',
  url: 'url', website: 'url', link: 'url',
  ip: 'ip', ipaddress: 'ip', address: 'ip',
  interval: 'intervalMinutes', intervalminutes: 'intervalMinutes', 'interval(min)': 'intervalMinutes',
  enabled: 'enabled', active: 'enabled',
  ports: 'ports', port: 'ports', tcpports: 'ports',
  pingport: 'pingPort', fallbackport: 'pingPort',
};

// A bare line is a URL if it has a scheme/path, an IP if it is one, otherwise treated as a website.
function targetFromLine(value) {
  const s = value.trim();
  if (net.isIP(s)) return { ip: s };
  return { url: s };
}

function parseImport(text, fileName) {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];
  const ext = (fileName.split('.').pop() || '').toLowerCase();

  if (ext === 'json' || /^[[{]/.test(trimmed)) {
    const data = JSON.parse(trimmed);
    const list = Array.isArray(data) ? data : data && Array.isArray(data.hosts) ? data.hosts : null;
    if (!list) throw new Error('JSON must be an array of hosts or an object with a "hosts" array');
    return list.map((item) => (typeof item === 'string' ? targetFromLine(item) : item || {}));
  }

  const rows = parseCsvRows(trimmed);
  const header = rows[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase().replace(/[\s_-]/g, '')]);
  if (header.some(Boolean)) {
    return rows.slice(1).map((r) => {
      const obj = {};
      header.forEach((key, i) => { if (key) obj[key] = (r[i] || '').trim(); });
      return obj;
    });
  }
  // Plain list: one URL/IP/hostname per line (first column), "#" comments allowed.
  return rows
    .map((r) => r[0].trim())
    .filter((v) => v && !v.startsWith('#'))
    .map(targetFromLine);
}

// Auto-resolved IPs are ignored so a URL-only import matches the same existing URL-only host.
function hostKey(h) {
  return `${(h.url || '').toLowerCase().replace(/\/+$/, '')}|${h.ipAuto ? '' : (h.ip || '').toLowerCase()}`;
}

// Returns { hosts: [...valid new hosts], skipped, invalid: [{ index, reason }] }.
function prepareImport(text, fileName) {
  if (Buffer.byteLength(text) > MAX_IMPORT_BYTES) throw new Error('Import file is larger than 5 MB');
  const records = parseImport(text, fileName);
  if (records.length > MAX_IMPORT_HOSTS) throw new Error(`Import is limited to ${MAX_IMPORT_HOSTS} hosts per file`);
  const { defaultIntervalMinutes } = config.getSettings();
  const seen = new Set(config.getHosts().map(hostKey));
  const hosts = [];
  const invalid = [];
  let skipped = 0;
  records.forEach((raw, index) => {
    try {
      const host = sanitizeHost(raw, defaultIntervalMinutes);
      const key = hostKey(host);
      if (seen.has(key)) {
        skipped++;
        return;
      }
      seen.add(key);
      hosts.push(host);
    } catch (err) {
      invalid.push({ index: index + 1, reason: err.message });
    }
  });
  return { hosts, skipped, invalid, total: records.length };
}

// Prefixes cells that spreadsheet apps would evaluate as formulas (CSV injection).
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(fields, rows) {
  return `${[fields.join(','), ...rows.map((r) => fields.map((f) => csvCell(r[f])).join(','))].join('\r\n')}\r\n`;
}

function exportHosts(format) {
  const hosts = config.getHosts().map((h) => ({
    name: h.name,
    url: h.url,
    ip: h.ipAuto ? '' : h.ip,
    ports: formatPorts(h.ports, ';'),
    pingPort: h.pingPort || '',
    intervalMinutes: h.intervalMinutes,
    enabled: h.enabled,
  }));
  if (format === 'csv') return { content: toCsv(HOST_FIELDS, hosts), count: hosts.length };
  const payload = {
    app: 'Devoping',
    format: 1,
    exportedAt: new Date().toISOString(),
    hosts,
  };
  return { content: `${JSON.stringify(payload, null, 2)}\n`, count: hosts.length };
}

function exportHistory(rows) {
  const mapped = rows.map((r) => ({ ...r, timestamp: new Date(r.timestamp).toISOString(), is_up: r.is_up ? 'up' : 'down' }));
  return { content: toCsv(HISTORY_FIELDS, mapped), count: rows.length };
}

const HTTP_METHODS = ['GET', 'HEAD', 'POST'];
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function validateMethod(v) {
  const m = (String(v ?? 'GET').trim().toUpperCase()) || 'GET';
  if (!HTTP_METHODS.includes(m)) throw new Error('Method must be GET, HEAD or POST');
  return m;
}

function validateExpectStatus(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.length > 100) throw new Error('Expected status list is too long');
  for (const token of s.split(/[\s,]+/).filter(Boolean)) {
    if (!/^([1-5]xx|\d{3}(-\d{3})?)$/i.test(token)) throw new Error(`Invalid status pattern "${token}" (use e.g. 200, 2xx or 200-299)`);
  }
  return s;
}

// Accepts an array of { name, value }, a plain object, or multiline "Name: value" text.
function parseHeaderInput(v) {
  let entries = [];
  if (Array.isArray(v)) entries = v.map((h) => [h && h.name, h && h.value]);
  else if (v && typeof v === 'object') entries = Object.entries(v);
  else if (typeof v === 'string') {
    entries = v.split(/\r?\n/).map((line) => {
      const i = line.indexOf(':');
      return i === -1 ? [line.trim(), ''] : [line.slice(0, i), line.slice(i + 1)];
    });
  }
  const out = [];
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName ?? '').trim();
    const value = String(rawValue ?? '').trim();
    if (!name) continue;
    if (!HEADER_NAME_RE.test(name)) throw new Error(`Invalid header name "${name}"`);
    if (/[\r\n]/.test(value)) throw new Error('Header values cannot contain line breaks');
    if (name.length > 100 || value.length > 2000) throw new Error('Header is too long');
    out.push({ name, value });
    if (out.length > 30) throw new Error('At most 30 custom headers');
  }
  return out;
}

function validateKeyword(v) {
  const s = String(v ?? '');
  if (s.length > 200) throw new Error('Response keyword must be 200 characters or fewer');
  return s;
}

function validateRequestBody(v) {
  const s = String(v ?? '');
  if (s.length > 10000) throw new Error('Request body must be 10000 characters or fewer');
  return s;
}

// Validates host data coming from the UI. For updates (partial) only the provided fields are checked.
function validateHostInput(raw, { partial = false } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid host data');
  const out = {};
  const has = (k) => !partial || Object.prototype.hasOwnProperty.call(raw, k);
  if (has('name')) {
    out.name = String(raw.name ?? '').trim();
    if (out.name.length > 200) throw new Error('Name must be 200 characters or fewer');
  }
  try {
    if (has('url')) out.url = normalizeUrl(raw.url);
  } catch (err) {
    throw new Error(`Invalid URL: ${err.message}`);
  }
  if (has('ip')) out.ip = normalizeIp(raw.ip);
  if (has('ports')) out.ports = parsePorts(raw.ports);
  if (has('pingPort')) out.pingPort = parsePingPort(raw.pingPort);
  if (has('method')) out.method = validateMethod(raw.method);
  if (has('expectStatus')) out.expectStatus = validateExpectStatus(raw.expectStatus);
  if (has('headers')) out.headers = parseHeaderInput(raw.headers);
  if (has('bodyMatch')) out.bodyMatch = validateKeyword(raw.bodyMatch);
  if (has('body')) out.body = validateRequestBody(raw.body);
  if (Object.prototype.hasOwnProperty.call(raw, 'followRedirects')) out.followRedirects = raw.followRedirects !== false;
  if (has('intervalMinutes')) {
    const n = Math.round(Number(raw.intervalMinutes));
    if (!(n >= 1 && n <= 1440)) throw new Error('Interval must be between 1 and 1440 minutes');
    out.intervalMinutes = n;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'enabled')) out.enabled = raw.enabled === true;
  if (!partial && !out.url && !out.ip) throw new Error('Provide a URL or an IP address (or both)');
  return out;
}

module.exports = { prepareImport, exportHosts, exportHistory, validateHostInput, MAX_IMPORT_BYTES };
