// Domain WHOIS / RDAP lookups and a watch list with automatic expiry-date checks.
// RDAP (JSON over HTTPS, via the rdap.org bootstrap) is preferred; classic WHOIS on TCP 43
// (IANA referral -> registry -> registrar) fills gaps and provides the raw text.
const net = require('net');
const config = require('./config');
const alerts = require('./alerts');
const log = require('./logger');
const { normalizeTarget } = require('./dns-tools');

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;
const LOOKUP_TIMEOUT_MS = 12000;
const MAX_WHOIS_BYTES = 128 * 1024;
const MAX_RDAP_REDIRECTS = 3;
const MAX_DOMAINS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECHECK_MS = DAY_MS;
const RETRY_FAILED_MS = 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 60 * 1000;
const SWEEP_GAP_MS = 1500; // be polite to WHOIS servers (rate limits)

const ianaReferrals = new Map(); // tld -> whois server ('' = none)
let broadcastFn = () => {};
let sweepTimer = null;
let firstSweepTimer = null;
let sweeping = false;
const checking = new Set();

function setBroadcaster(fn) {
  broadcastFn = fn;
}

function normalizeDomain(input) {
  const { hostname, isIp } = normalizeTarget(input);
  if (isIp) throw new Error('Enter a domain name, not an IP address');
  if (!hostname.includes('.')) throw new Error('Enter a full domain name, e.g. example.com');
  return hostname;
}

// ---------- WHOIS (TCP 43) ----------
function whoisQuery(server, query) {
  return new Promise((resolve, reject) => {
    if (!HOSTNAME_RE.test(server)) {
      reject(new Error(`Invalid WHOIS server "${server}"`));
      return;
    }
    const chunks = [];
    let size = 0;
    const socket = net.connect({ host: server, port: 43 });
    socket.setTimeout(LOOKUP_TIMEOUT_MS, () => socket.destroy(new Error(`${server} timed out`)));
    socket.on('connect', () => socket.write(`${query}\r\n`));
    socket.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_WHOIS_BYTES) chunks.push(chunk);
      else socket.destroy();
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function whoisServerFor(tld) {
  if (ianaReferrals.has(tld)) return ianaReferrals.get(tld);
  const text = await whoisQuery('whois.iana.org', tld);
  // Some registries (e.g. .uk) aren't listed at IANA but follow the whois.nic.<tld> convention.
  const server = ((/^(?:refer|whois):[ \t]*(\S+)/im.exec(text) || [])[1] || `whois.nic.${tld}`).toLowerCase();
  ianaReferrals.set(tld, server);
  return server;
}

async function whoisLookup(domain) {
  const server = await whoisServerFor(domain.split('.').pop());
  const query = server === 'whois.denic.de' ? `-T dn,ace ${domain}` : domain;
  let text = await whoisQuery(server, query);
  // Thin registries (.com/.net) point to the registrar's WHOIS server for the full record.
  const referral = (/^[ \t]*Registrar WHOIS Server:[ \t]*(\S+)/im.exec(text) || [])[1];
  const registrarServer = referral ? referral.replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, '').toLowerCase() : '';
  if (registrarServer && registrarServer !== server && HOSTNAME_RE.test(registrarServer)) {
    try {
      text += `\n\n# ${registrarServer}\n${await whoisQuery(registrarServer, domain)}`;
    } catch (err) {
      log.warn(`Registrar WHOIS ${registrarServer} failed: ${err.message}`);
    }
  }
  return { server, text: text.trim() };
}

function parseDate(value) {
  if (!value) return null;
  const v = String(value).trim().replace(/\s*\(.*\)$/, '');
  let t = Date.parse(v);
  if (Number.isNaN(t)) t = Date.parse(v.replace(/^(\d{4})[./](\d{2})[./](\d{2})/, '$1-$2-$3'));
  if (Number.isNaN(t)) {
    const m = /^(\d{2})[./-](\d{2})[./-](\d{4})/.exec(v);
    if (m) t = Date.parse(`${m[3]}-${m[2]}-${m[1]}`);
  }
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function field(text, names) {
  const re = new RegExp(`^[ \\t]*(?:${names})[ \\t]*:[ \\t]*(.+)$`, 'im');
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

function fieldAll(text, names, lower = false) {
  const re = new RegExp(`^[ \\t]*(?:${names})[ \\t]*:[ \\t]*(\\S+)`, 'gim');
  return [...new Set([...text.matchAll(re)].map((m) => (lower ? m[1].toLowerCase() : m[1]).replace(/\.$/, '')))];
}

function parseWhois(text) {
  return {
    notFound: /^\s*(no match|not found|no data found|no entries found|domain not found|status:\s*(free|available))/im.test(text),
    registrar: field(text, 'Registrar|Sponsoring Registrar|Registrar Name|registrar'),
    createdAt: parseDate(field(text, 'Creation Date|Created On|Created|created|Registered on|Registration Time|Domain Registration Date|registered')),
    updatedAt: parseDate(field(text, 'Updated Date|Last Modified|last-modified|changed|Last updated')),
    expiresAt: parseDate(field(text, 'Registry Expiry Date|Registrar Registration Expiration Date|Expiration Date|Expiry Date|Expiry date|Expires On|Expires on|expires|paid-till|Expiration Time|Renewal date|Valid Until|expire')),
    status: fieldAll(text, 'Domain Status|status|state'),
    nameservers: fieldAll(text, 'Name Server|nserver|Nameservers?', true),
  };
}

// ---------- RDAP (HTTPS) ----------
async function rdapLookup(domain) {
  let url = `https://rdap.org/domain/${encodeURIComponent(domain)}`;
  for (let hop = 0; hop <= MAX_RDAP_REDIRECTS; hop++) {
    const res = await fetch(url, {
      headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': 'Devoping (+https://devolity.com)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), url);
      if (next.protocol !== 'https:') throw new Error('RDAP redirect to a non-HTTPS server refused');
      url = next.toString();
      continue;
    }
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new Error(`RDAP HTTP ${res.status}`);
    return parseRdap(await res.json());
  }
  throw new Error('Too many RDAP redirects');
}

function vcardName(entity) {
  const props = (entity && entity.vcardArray && entity.vcardArray[1]) || [];
  const fn = props.find((p) => Array.isArray(p) && p[0] === 'fn');
  return fn && fn[3] ? String(fn[3]) : null;
}

function parseRdap(d) {
  const event = (action) => ((d.events || []).find((e) => e.eventAction === action) || {}).eventDate;
  const registrar = (d.entities || []).find((e) => Array.isArray(e.roles) && e.roles.includes('registrar'));
  const ianaId = registrar && Array.isArray(registrar.publicIds)
    ? (registrar.publicIds.find((p) => /iana/i.test(p.type)) || {}).identifier || null
    : null;
  return {
    notFound: false,
    registrar: vcardName(registrar),
    registrarIanaId: ianaId ? String(ianaId) : null,
    createdAt: parseDate(event('registration')),
    updatedAt: parseDate(event('last changed')),
    expiresAt: parseDate(event('expiration')),
    status: Array.isArray(d.status) ? d.status.map(String) : [],
    nameservers: (d.nameservers || []).map((n) => String(n.ldhName || '').toLowerCase()).filter(Boolean),
    dnssec: d.secureDNS ? Boolean(d.secureDNS.delegationSigned) : null,
  };
}

// ---------- combined lookup ----------
const daysUntil = (iso) => (iso ? Math.floor((Date.parse(iso) - Date.now()) / DAY_MS) : null);

async function lookupName(name) {
  const [rdapRes, whoisRes] = await Promise.allSettled([rdapLookup(name), whoisLookup(name)]);
  const r = rdapRes.status === 'fulfilled' && !rdapRes.value.notFound ? rdapRes.value : null;
  const w = whoisRes.status === 'fulfilled' ? whoisRes.value : null;
  const p = w && w.text ? parseWhois(w.text) : null;
  const pUseful = p && !p.notFound && (p.expiresAt || p.createdAt || p.registrar || p.nameservers.length);
  const expiresAt = (r && r.expiresAt) || (p && p.expiresAt) || null;
  return {
    domain: name,
    found: Boolean(r || pUseful),
    source: r ? 'RDAP' : pUseful ? 'WHOIS' : null,
    registrar: (r && r.registrar) || (p && p.registrar) || null,
    registrarIanaId: (r && r.registrarIanaId) || null,
    createdAt: (r && r.createdAt) || (p && p.createdAt) || null,
    updatedAt: (r && r.updatedAt) || (p && p.updatedAt) || null,
    expiresAt,
    daysLeft: daysUntil(expiresAt),
    status: r && r.status.length ? r.status : (p && p.status) || [],
    nameservers: r && r.nameservers.length ? r.nameservers : (p && p.nameservers) || [],
    dnssec: r ? r.dnssec : null,
    whoisServer: w ? w.server : null,
    raw: w ? w.text : '',
    errors: [
      rdapRes.status === 'rejected' ? `RDAP: ${rdapRes.reason.message}` : null,
      whoisRes.status === 'rejected' ? `WHOIS: ${whoisRes.reason.message}` : null,
    ].filter(Boolean),
    checkedAt: new Date().toISOString(),
  };
}

// Subdomains (www.example.co.uk) are walked up until the registered domain answers.
async function lookup(input) {
  const name = normalizeDomain(input);
  const labels = name.split('.');
  let first = null;
  for (let i = 0; i <= labels.length - 2; i++) {
    const result = await lookupName(labels.slice(i).join('.'));
    if (result.found) return result;
    first = first || result;
  }
  return first;
}

// ---------- watch list ----------
function list() {
  return config.getDomains().map((d) => ({ ...d, daysLeft: daysUntil(d.expiresAt), checking: checking.has(d.id) }));
}

function add(input) {
  const name = normalizeDomain(input);
  const domains = config.getDomains();
  if (domains.some((d) => d.name === name)) throw new Error(`${name} is already in the watch list`);
  if (domains.length >= MAX_DOMAINS) throw new Error(`The watch list is limited to ${MAX_DOMAINS} domains`);
  const created = config.addDomain(name);
  check(created.id).catch(() => {});
  return created;
}

function remove(id) {
  return config.deleteDomain(id);
}

function levelOf(daysLeft) {
  const s = config.getSettings();
  return alerts.expiryLevel(daysLeft, s.domainWarnDays ?? 30, s.domainCriticalDays ?? 7);
}

async function check(id) {
  const entry = config.getDomain(id);
  if (!entry) throw new Error('Domain not found');
  if (checking.has(id)) return entry;
  checking.add(id);
  broadcastFn('domains:changed', {});
  try {
    const res = await lookup(entry.name);
    const now = new Date().toISOString();
    if (!res.found) {
      const error = res.errors.length ? res.errors.join('; ') : 'No registration data found';
      return config.updateDomain(id, { lastAttemptAt: now, error });
    }
    const level = levelOf(res.daysLeft) || 'ok';
    const prevLevel = entry.alertLevel || 'ok';
    if (alerts.LEVEL_RANK[level] > alerts.LEVEL_RANK[prevLevel]) {
      alerts.add({
        severity: level === 'warning' ? 'warning' : 'danger',
        title: `${entry.name} ${level === 'expired' ? 'has expired' : 'expires soon'}`,
        message: res.expiresAt ? `Expiry date ${res.expiresAt.slice(0, 10)} (${res.daysLeft} day(s) left)` : '',
        domainId: id,
      });
    } else if (prevLevel !== 'ok' && level === 'ok') {
      alerts.add({ severity: 'success', title: `${entry.name} renewed`, message: `New expiry date ${res.expiresAt.slice(0, 10)}`, domainId: id });
    }
    return config.updateDomain(id, {
      registeredName: res.domain,
      registrar: res.registrar,
      createdAt: res.createdAt,
      expiresAt: res.expiresAt,
      status: res.status.slice(0, 10),
      nameservers: res.nameservers.slice(0, 10),
      source: res.source,
      alertLevel: level,
      lastCheckedAt: now,
      lastAttemptAt: now,
      error: null,
    });
  } catch (err) {
    config.updateDomain(id, { lastAttemptAt: new Date().toISOString(), error: err.message });
    throw err;
  } finally {
    checking.delete(id);
    broadcastFn('domains:changed', {});
  }
}

async function sweep({ all = false } = {}) {
  if (sweeping) return 0;
  sweeping = true;
  let count = 0;
  try {
    const now = Date.now();
    const due = config.getDomains().filter((d) => all || (
      now - (Date.parse(d.lastCheckedAt) || 0) >= RECHECK_MS && now - (Date.parse(d.lastAttemptAt) || 0) >= RETRY_FAILED_MS
    ));
    for (const d of due) {
      if (!sweepTimer && !all) break; // stopped (signed out)
      await check(d.id).catch((err) => log.warn(`Domain check ${d.name} failed: ${err.message}`));
      count++;
      await new Promise((r) => setTimeout(r, SWEEP_GAP_MS));
    }
  } finally {
    sweeping = false;
  }
  return count;
}

function checkAll() {
  const total = config.getDomains().length;
  sweep({ all: true }).catch((err) => log.warn(`Domain sweep failed: ${err.message}`));
  return total;
}

function start() {
  stop();
  sweepTimer = setInterval(() => sweep().catch(() => {}), SWEEP_EVERY_MS);
  firstSweepTimer = setTimeout(() => sweep().catch(() => {}), FIRST_SWEEP_DELAY_MS);
}

function stop() {
  if (sweepTimer) clearInterval(sweepTimer);
  if (firstSweepTimer) clearTimeout(firstSweepTimer);
  sweepTimer = null;
  firstSweepTimer = null;
}

module.exports = { setBroadcaster, lookup, list, add, remove, check, checkAll, start, stop };
