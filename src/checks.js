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
const USER_AGENT = `DevoWatch/${require('../package.json').version} (+https://devolity.com)`;
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

/**
 * Performs an HTTP(S) request, measuring latency and (for https) reading the
 * server's TLS certificate for expiry tracking.
 */
function checkHttp(rawUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let start = Date.now();
    let target;
    try {
      target = new URL(rawUrl);
    } catch (err) {
      resolve({ ok: false, error: `Invalid URL: ${rawUrl}` });
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
    const req = lib.request(
      target,
      {
        method: 'GET',
        timeout: timeoutMs,
        // We only care about reading the certificate, not enforcing trust here -
        // validity/expiry is evaluated explicitly below and surfaced to the user.
        rejectUnauthorized: false,
        lookup: dnsConfig.lookup,
        headers: { 'User-Agent': USER_AGENT },
      },
      (res) => {
        const latencyMs = Date.now() - start;
        const ssl = target.protocol === 'https:' ? extractSslInfo(res.socket) : null;
        finish({
          ok: res.statusCode < 500,
          statusCode: res.statusCode,
          latencyMs,
          ssl,
        });
        // Only the status line/headers are needed; drop the body and the socket.
        res.destroy();
      }
    );
    // `timeout` above only covers socket inactivity; this bounds the whole request.
    deadline = setTimeout(() => req.destroy(new Error('Request timed out')), timeoutMs + 2000);
    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', (err) => {
      finish({ ok: false, error: err.message, latencyMs: Date.now() - start });
    });
    req.end();
  });
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
