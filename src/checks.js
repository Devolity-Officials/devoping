// Individual probe implementations used by the monitor scheduler.
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');
const ping = require('ping');
const dnsConfig = require('./dns-config');
const { BANNER_PORTS } = require('./ports');

const DEFAULT_TIMEOUT_MS = 10000;
const TCP_TIMEOUT_MS = 5000;
const BANNER_WAIT_MS = 1500;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 1024 * 1024;
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST']);
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const USER_AGENT = `Devoping/${require('../package.json').version} (+https://devolity.com)`;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;

// Ping targets are passed as process arguments, so only plain IPs/hostnames are allowed
// (no leading "-" that ping.exe would treat as an option).
function isValidPingTarget(target) {
  const s = String(target || '');
  return net.isIP(s) !== 0 || HOSTNAME_RE.test(s);
}

function extractSslInfo(socket) {
  if (!socket || typeof socket.getPeerCertificate !== 'function') return null;
  const cert = socket.getPeerCertificate();
  if (!cert || !Object.keys(cert).length || !cert.valid_to) return null;
  const validTo = new Date(cert.valid_to);
  const validFrom = new Date(cert.valid_from);
  const daysRemaining = Math.ceil((validTo.getTime() - Date.now()) / 86400000);
  return {
    issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || 'Unknown',
    subject: (cert.subject && cert.subject.CN) || null,
    validFrom: validFrom.toISOString(),
    validTo: validTo.toISOString(),
    daysRemaining,
    valid: daysRemaining > 0,
  };
}

function parseStatusMatcher(spec) {
  const s = String(spec || '').trim();
  if (!s) return null;
  const tests = [];
  for (const token of s.split(/[\s,]+/).filter(Boolean)) {
    let m;
    if ((m = /^([1-5])xx$/i.exec(token))) {
      const base = Number(m[1]) * 100;
      tests.push((c) => c >= base && c < base + 100);
    } else if ((m = /^(\d{3})-(\d{3})$/.exec(token))) {
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      tests.push((c) => c >= lo && c <= hi);
    } else if (/^\d{3}$/.test(token)) {
      const code = Number(token);
      tests.push((c) => c === code);
    } else {
      throw new Error(`Invalid status pattern "${token}" (use e.g. 200, 2xx or 200-299)`);
    }
  }
  return (code) => tests.some((fn) => fn(code));
}

// Accepts an array of { name, value } (or a plain object) and drops anything unsafe.
function sanitizeHeaders(headers) {
  const out = {};
  const entries = Array.isArray(headers)
    ? headers.map((h) => [h && h.name, h && h.value])
    : Object.entries(headers || {});
  for (const [name, value] of entries) {
    const n = String(name || '').trim();
    const v = String(value == null ? '' : value);
    if (HEADER_NAME_RE.test(n) && !/[\r\n]/.test(v)) out[n] = v;
  }
  return out;
}

/**
 * Performs an HTTP(S) request (curl-style): measures latency, optionally follows redirects,
 * checks an expected status and/or response keyword, and (for https) reads the server's TLS
 * certificate for expiry tracking.
 */
function checkHttp(rawUrl, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    method = 'GET',
    headers = null,
    body = '',
    expectStatus = '',
    bodyMatch = '',
    followRedirects = true,
  } = options || {};

  let statusMatcher;
  try {
    statusMatcher = parseStatusMatcher(expectStatus);
  } catch (err) {
    return Promise.resolve({ ok: false, error: err.message });
  }
  const verb = HTTP_METHODS.has(String(method).toUpperCase()) ? String(method).toUpperCase() : 'GET';
  const userHeaders = headers ? sanitizeHeaders(headers) : {};
  const needBody = Boolean(bodyMatch);
  const start = Date.now();

  const evaluate = ({ status, latencyMs, ssl, respBody }) => {
    const statusOk = statusMatcher ? statusMatcher(status) : status < 500;
    const bodyOk = bodyMatch ? (typeof respBody === 'string' && respBody.toLowerCase().includes(String(bodyMatch).toLowerCase())) : true;
    let error = null;
    if (!statusOk) error = `Unexpected status ${status}`;
    else if (!bodyOk) error = `Keyword "${bodyMatch}" not found in response`;
    return { ok: statusOk && bodyOk, statusCode: status, latencyMs, ssl, error };
  };

  const request = (urlStr, verbToUse, redirectsLeft) => new Promise((resolve) => {
    let target;
    try {
      target = new URL(urlStr);
    } catch {
      resolve({ ok: false, error: `Invalid URL: ${urlStr}` });
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      resolve({ ok: false, error: `Unsupported protocol: ${target.protocol}` });
      return;
    }
    let settled = false;
    let deadline = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const lib = target.protocol === 'https:' ? https : http;
    const reqHeaders = { 'User-Agent': USER_AGENT, ...userHeaders };
    const sendBody = verbToUse === 'POST' && body;
    if (sendBody && reqHeaders['Content-Length'] === undefined && reqHeaders['content-length'] === undefined) {
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = lib.request(
      target,
      {
        method: verbToUse,
        timeout: timeoutMs,
        // Certificate trust is evaluated explicitly below (expiry), not enforced on the request.
        rejectUnauthorized: false,
        lookup: dnsConfig.lookup,
        headers: reqHeaders,
      },
      (res) => {
        const status = res.statusCode;
        const ssl = target.protocol === 'https:' ? extractSslInfo(res.socket) : null;
        if (followRedirects && redirectsLeft > 0 && [301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          let nextUrl = null;
          try {
            nextUrl = new URL(res.headers.location, target).toString();
          } catch {
            nextUrl = null;
          }
          res.destroy();
          if (nextUrl) {
            const nextVerb = (status === 307 || status === 308) ? verbToUse : (verbToUse === 'HEAD' ? 'HEAD' : 'GET');
            request(nextUrl, nextVerb, redirectsLeft - 1).then(finish);
            return;
          }
        }
        const latencyMs = Date.now() - start;
        if (!needBody || verbToUse === 'HEAD') {
          res.destroy();
          finish(evaluate({ status, latencyMs, ssl, respBody: null }));
          return;
        }
        let received = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received <= MAX_BODY_BYTES) chunks.push(chunk);
          else res.destroy();
        });
        const done = () => finish(evaluate({ status, latencyMs, ssl, respBody: Buffer.concat(chunks).toString('utf8') }));
        res.on('end', done);
        res.on('close', done);
      }
    );
    deadline = setTimeout(() => req.destroy(new Error('Request timed out')), timeoutMs + 2000);
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', (err) => finish({ ok: false, error: err.message, latencyMs: Date.now() - start }));
    if (sendBody) req.write(body);
    req.end();
  });

  return request(rawUrl, verb, followRedirects ? MAX_REDIRECTS : 0);
}

const TCP_ERRORS = {
  ECONNREFUSED: 'Connection refused (port closed)',
  ECONNRESET: 'Connection reset',
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
  ENOTFOUND: 'Host name not found',
  EAI_AGAIN: 'DNS lookup failed',
  ETIMEDOUT: 'Connection timed out',
};

function cleanBanner(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim()) || '';
  return line.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 120) || null;
}

// TCP connect check. Never sends data; for greeting protocols it passively reads the first line.
function checkTcp(host, port, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!isValidPingTarget(host)) return resolve({ ok: false, error: `Invalid target: ${host}` });
    if (!Number.isInteger(port) || port < 1 || port > 65535) return resolve({ ok: false, error: `Invalid port: ${port}` });
    const start = Date.now();
    let connectedAt = null;
    let banner = '';
    let settled = false;
    let connectTimer = null;
    let bannerTimer = null;
    const socket = net.connect({ host, port, lookup: dnsConfig.lookup });
    const success = () => ({ ok: true, latencyMs: connectedAt - start, banner: cleanBanner(banner) });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(bannerTimer);
      socket.destroy();
      resolve(result);
    };
    connectTimer = setTimeout(() => finish({ ok: false, error: `Connection timed out after ${timeoutMs / 1000}s` }), timeoutMs);
    socket.once('connect', () => {
      connectedAt = Date.now();
      clearTimeout(connectTimer);
      if (!BANNER_PORTS.has(port)) return finish(success());
      bannerTimer = setTimeout(() => finish(success()), BANNER_WAIT_MS);
    });
    socket.on('data', (chunk) => {
      banner += chunk.toString('latin1');
      if (banner.length > 256 || /\n/.test(banner)) finish(success());
    });
    socket.on('error', (err) => finish(connectedAt ? success() : { ok: false, error: TCP_ERRORS[err.code] || err.message }));
    socket.on('close', () => {
      if (connectedAt) finish(success());
    });
  });
}

// Prefers IPv4 so the result can be pinged; falls back to any address family.
function resolveHostIp(hostname) {
  return new Promise((resolve) => {
    dnsConfig.lookup(hostname, { family: 4 }, (err, address) => {
      if (!err) return resolve(address);
      dnsConfig.lookup(hostname, {}, (err2, address2) => resolve(err2 ? null : address2));
    });
  });
}

async function checkPing(target, timeoutSeconds = 10) {
  if (!isValidPingTarget(target)) return { ok: false, error: `Invalid ping target: ${target}` };
  let timer;
  try {
    const res = await Promise.race([
      ping.promise.probe(target, {
        timeout: timeoutSeconds,
        extra: process.platform === 'linux' ? ['-c', '1'] : [],
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Ping timed out')), (timeoutSeconds + 5) * 1000);
      }),
    ]);
    return {
      ok: !!res.alive,
      latencyMs: res.time === 'unknown' ? null : parseFloat(res.time),
      error: res.alive ? null : 'Host unreachable',
    };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkHttp, checkPing, checkTcp, resolveHostIp, isValidPingTarget };
