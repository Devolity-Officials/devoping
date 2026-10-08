// Devoping telemetry collector - reference server (Node.js 18+, no dependencies).
//
//   POST /v1/events   JSON batch from the Devoping app -> appended to data/events-YYYY-MM-DD.ndjson
//   GET  /healthz     liveness probe
//
// Run behind an HTTPS reverse proxy (Caddy/nginx); this process itself only listens on localhost.
// Environment: PORT (8787), HOST (127.0.0.1), DATA_DIR (./data), RETENTION_DAYS (90),
//              RATE_LIMIT_PER_HOUR (120), TRUST_PROXY (1 when behind a proxy that sets X-Forwarded-For).
// Privacy: client IPs are never written to disk; they are only hashed in memory for rate limiting.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 90;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR) || 120;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_BODY = 256 * 1024;
const MAX_EVENTS = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[a-z0-9_.-]{1,40}$/i;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- rate limiting (in memory, per hashed client IP, rolling hour) ----
const salt = crypto.randomBytes(16);
const hits = new Map();
function rateLimited(ip) {
  const key = crypto.createHmac('sha256', salt).update(ip).digest('hex');
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < 3600000);
  list.push(now);
  hits.set(key, list);
  return list.length > RATE_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) if (!list.some((t) => now - t < 3600000)) hits.delete(k);
}, 600000).unref();

// ---- validation: accept only the documented, privacy-safe shape ----
// Mirrors the app's sanitiser: numbers/booleans only, plus two allow-listed enum strings.
const STRING_PROPS = { version: /^\d+(\.\d+){0,3}(-[a-z0-9.]+)?$/i, cloud_backup: /^(none|s3|gdrive|onedrive)$/ };

function cleanProps(props) {
  const out = {};
  if (!props || typeof props !== 'object') return out;
  for (const [k, v] of Object.entries(props).slice(0, 100)) {
    if (!/^[a-z0-9_]{1,40}$/i.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && STRING_PROPS[k] && STRING_PROPS[k].test(v)) out[k] = v;
  }
  return out;
}

function str(v, max = 40) {
  return typeof v === 'string' ? v.slice(0, max).replace(/[^\w .:+()-]/g, '') : null;
}

function validate(body) {
  if (!body || body.schema !== 1) throw new Error('unsupported schema');
  if (!UUID_RE.test(String(body.installId))) throw new Error('invalid installId');
  if (!Array.isArray(body.events) || !body.events.length || body.events.length > MAX_EVENTS) throw new Error('invalid events');
  const app = { name: str(body.app && body.app.name), version: str(body.app && body.app.version), electron: str(body.app && body.app.electron) };
  const os = { platform: str(body.os && body.os.platform), release: str(body.os && body.os.release), arch: str(body.os && body.os.arch), locale: str(body.os && body.os.locale, 16) };
  const events = body.events
    .filter((e) => e && NAME_RE.test(String(e.name)) && Number.isFinite(e.ts))
    .map((e) => ({ name: e.name, ts: new Date(e.ts).toISOString(), props: cleanProps(e.props) }));
  return { installId: body.installId.toLowerCase(), app, os, events };
}

// ---- storage: one NDJSON file per UTC day, old files pruned ----
function store({ installId, app, os, events }) {
  const receivedAt = new Date().toISOString();
  const file = path.join(DATA_DIR, `events-${receivedAt.slice(0, 10)}.ndjson`);
  const lines = events.map((event) => JSON.stringify({ receivedAt, installId, app, os, ...event })).join('\n');
  fs.appendFileSync(file, `${lines}\n`);
}

function pruneOldFiles() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  for (const name of fs.readdirSync(DATA_DIR)) {
    const m = /^events-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name);
    if (m && Date.parse(m[1]) < cutoff) fs.unlinkSync(path.join(DATA_DIR, name));
  }
}
pruneOldFiles();
setInterval(pruneOldFiles, 6 * 3600000).unref();

// ---- HTTP ----
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
  if (req.url !== '/v1/events') return send(res, 404, { error: 'not found' });
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'expected application/json' });
  if (rateLimited(ip)) return send(res, 429, { error: 'rate limited' });

  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      send(res, 413, { error: 'payload too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    try {
      const batch = validate(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (batch.events.length) store(batch);
      send(res, 202, { accepted: batch.events.length });
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  });
});

server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(PORT, HOST, () => console.log(`Devoping telemetry collector listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`));
