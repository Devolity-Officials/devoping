// Global DNS servers (Settings > DNS). When configured, monitoring checks and IP auto-resolution
// query these servers instead of the OS resolver; otherwise the OS resolver is used unchanged.
const dns = require('dns');
const net = require('net');
const config = require('./config');

const MAX_SERVERS = 4;

// Accepts "1.1.1.1", "1.1.1.1:53", "2606:4700::1111" or "[2606:4700::1111]:53".
function normalizeServer(value) {
  const s = String(value).trim();
  if (net.isIP(s)) return s;
  let m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(s);
  if (m && net.isIPv4(m[1]) && Number(m[2]) > 0 && Number(m[2]) < 65536) return s;
  m = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/i.exec(s);
  if (m && net.isIPv6(m[1]) && Number(m[2]) > 0 && Number(m[2]) < 65536) return s;
  return null;
}

function parseServers(input) {
  const items = (Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/))
    .map((v) => String(v).trim())
    .filter(Boolean);
  const servers = [];
  for (const item of items) {
    const normalized = normalizeServer(item);
    if (!normalized) throw new Error(`Invalid DNS server: ${item}`);
    if (!servers.includes(normalized)) servers.push(normalized);
  }
  if (servers.length > MAX_SERVERS) throw new Error(`At most ${MAX_SERVERS} DNS servers are allowed`);
  return servers;
}

function getGlobalServers() {
  const list = config.getSettings().dnsServers;
  return Array.isArray(list) ? list : [];
}

function createResolver(servers) {
  const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  if (servers && servers.length) resolver.setServers(servers);
  return resolver;
}

function lookupError(hostname) {
  const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  err.code = 'ENOTFOUND';
  err.hostname = hostname;
  return err;
}

// Drop-in replacement for dns.lookup (usable as the `lookup` option of http/https/net).
// Falls back to the OS resolver for IP literals and names the global servers can't answer
// (e.g. hosts-file or intranet-only names).
function lookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  } else if (typeof options === 'number') {
    options = { family: options };
  }
  options = options || {};
  const servers = getGlobalServers();
  if (!servers.length || net.isIP(hostname) || hostname === 'localhost') {
    dns.lookup(hostname, options, callback);
    return;
  }
  const resolver = createResolver(servers);
  const family = Number(options.family) || 0;
  const jobs = [];
  if (family !== 6) jobs.push(resolver.resolve4(hostname).then((a) => a.map((address) => ({ address, family: 4 }))).catch(() => []));
  if (family !== 4) jobs.push(resolver.resolve6(hostname).then((a) => a.map((address) => ({ address, family: 6 }))).catch(() => []));
  Promise.all(jobs).then((lists) => {
    const all = lists.flat();
    if (!all.length) {
      dns.lookup(hostname, options, (err, ...rest) => callback(err ? lookupError(hostname) : null, ...rest));
      return;
    }
    if (options.all) callback(null, all);
    else callback(null, all[0].address, all[0].family);
  });
}

module.exports = { parseServers, getGlobalServers, createResolver, lookup };
