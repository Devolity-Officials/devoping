// DNS record lookups: structured results via Node's c-ares resolver (same wire queries as dig),
// OS resolver + hosts file view, and raw output from whichever of dig/host/nslookup is installed.
const dns = require('dns');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFile } = require('child_process');
const dnsConfig = require('./dns-config');

const DNS_SERVERS = {
  system: { label: 'System default', servers: null },
  google: { label: 'Google (8.8.8.8)', servers: ['8.8.8.8', '8.8.4.4'] },
  cloudflare: { label: 'Cloudflare (1.1.1.1)', servers: ['1.1.1.1', '1.0.0.1'] },
  quad9: { label: 'Quad9 (9.9.9.9)', servers: ['9.9.9.9', '149.112.112.112'] },
};

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;
const RAW_OUTPUT_LIMIT = 64 * 1024;

// Accepts a URL, hostname or IP and returns a validated bare hostname/IP (safe to pass to CLI tools).
function normalizeTarget(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error('Enter a hostname, URL or IP address');
  if (net.isIP(value)) return { hostname: value, isIp: true };
  try {
    value = new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    throw new Error(`Invalid hostname: ${input}`);
  }
  value = value.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (net.isIP(value)) return { hostname: value, isIp: true };
  if (!HOSTNAME_RE.test(value)) throw new Error(`Invalid hostname: ${input}`);
  return { hostname: value, isIp: false };
}

function resolveServer(serverKey) {
  if (serverKey === 'global') {
    const servers = dnsConfig.getGlobalServers();
    if (servers.length) return { key: 'global', label: `Global (${servers.join(', ')})`, servers };
  }
  if (DNS_SERVERS[serverKey]) return { key: serverKey, ...DNS_SERVERS[serverKey] };
  if (net.isIP(String(serverKey || ''))) return { key: serverKey, label: serverKey, servers: [serverKey] };
  return { key: 'system', ...DNS_SERVERS.system };
}

function makeResolver(server) {
  return dnsConfig.createResolver(server.servers);
}

function formatRecords(type, records) {
  switch (type) {
    case 'A':
    case 'AAAA':
      return records.map((r) => ({ value: r.address, ttl: r.ttl }));
    case 'MX':
      return records
        .sort((a, b) => a.priority - b.priority)
        .map((r) => ({ value: `${r.priority} ${r.exchange}` }));
    case 'TXT':
      return records.map((chunks) => ({ value: chunks.join('') }));
    case 'SOA':
      return [{
        value: `${records.nsname} ${records.hostmaster} serial=${records.serial} refresh=${records.refresh} `
          + `retry=${records.retry} expire=${records.expire} minttl=${records.minttl}`,
      }];
    case 'CAA':
      return records.map((r) => {
        const tag = Object.keys(r).find((k) => k !== 'critical' && k !== 'type');
        return { value: `${r.critical} ${tag} "${r[tag]}"` };
      });
    default:
      return records.map((r) => ({ value: String(r) }));
  }
}

async function query(resolver, type, name) {
  const start = Date.now();
  const section = { type, name, records: [] };
  try {
    let records;
    if (type === 'A') records = await resolver.resolve4(name, { ttl: true });
    else if (type === 'AAAA') records = await resolver.resolve6(name, { ttl: true });
    else if (type === 'PTR') records = await resolver.reverse(name);
    else records = await resolver.resolve(name, type);
    section.records = formatRecords(type, records);
  } catch (err) {
    if (err.code === 'ENODATA') section.note = 'No records';
    else if (err.code === 'ENOTFOUND') section.note = type === 'PTR' ? 'No PTR record' : 'NXDOMAIN (name does not exist)';
    else section.error = err.code || err.message;
  }
  section.ms = Date.now() - start;
  return section;
}

// Walks up the labels until an NS record set is found - that name is the zone apex.
async function findZone(resolver, hostname) {
  const labels = hostname.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    try {
      await resolver.resolveNs(candidate);
      return candidate;
    } catch {
      // not a zone cut (or lookup failed) - try the parent
    }
  }
  return hostname;
}

function readHostsFile(hostname) {
  const hostsPath = process.platform === 'win32'
    ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\drivers\\etc\\hosts`
    : '/etc/hosts';
  try {
    return fs.readFileSync(hostsPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, '').trim().split(/\s+/))
      .filter((parts) => parts.length > 1 && parts.slice(1).some((h) => h.toLowerCase() === hostname))
      .map((parts) => parts[0]);
  } catch {
    return [];
  }
}

// OS resolver path (what browsers/ping use): honours the hosts file and local DNS suffixes.
async function systemLookup(hostname) {
  const start = Date.now();
  const hostsFile = readHostsFile(hostname);
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true });
    return { addresses: addresses.map((a) => `${a.address} (IPv${a.family})`), hostsFile, ms: Date.now() - start };
  } catch (err) {
    return { addresses: [], hostsFile, error: err.code || err.message, ms: Date.now() - start };
  }
}

function runTool(cmd, args, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, timeout: 20000 });
    let out = '';
    const collect = (chunk) => {
      if (out.length < RAW_OUTPUT_LIMIT) out += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', () => resolve(out.slice(0, RAW_OUTPUT_LIMIT).trim()));
    if (stdinText) child.stdin.write(stdinText);
    child.stdin.end();
  });
}

// Tries dig, then host, then nslookup (built into Windows). Arguments are passed without a shell.
async function rawToolOutput(hostname, isIp, server) {
  const first = server.servers ? server.servers[0] : null;
  // CLI tools take a bare server address; strip any ":port" suffix.
  const ns = first ? first.replace(/^\[(.+)\]:\d+$/, '$1').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1') : null;
  const types = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA'];
  const attempts = [
    {
      tool: 'dig',
      args: isIp
        ? ['+noall', '+answer', ...(ns ? [`@${ns}`] : []), '-x', hostname]
        : ['+noall', '+answer', ...(ns ? [`@${ns}`] : []), ...types.flatMap((t) => [hostname, t])],
    },
    { tool: 'host', args: ['-a', hostname, ...(ns ? [ns] : [])] },
    {
      tool: 'nslookup',
      args: ns ? ['-', ns] : [],
      stdin: isIp
        ? `set type=PTR\n${hostname}\nexit\n`
        : `${types.map((t) => `set type=${t}\n${hostname}`).join('\n')}\nexit\n`,
    },
  ];
  for (const attempt of attempts) {
    try {
      const output = await runTool(attempt.tool, attempt.args, attempt.stdin);
      return { tool: attempt.tool, command: [attempt.tool, ...attempt.args].join(' '), output };
    } catch (err) {
      if (err.code !== 'ENOENT') return { tool: attempt.tool, error: err.message };
    }
  }
  return { tool: null, error: 'No DNS command-line tool (dig/host/nslookup) found on PATH' };
}

async function lookup(target, serverKey = 'system') {
  const started = Date.now();
  const { hostname, isIp } = normalizeTarget(target);
  const server = resolveServer(serverKey);
  const resolver = makeResolver(server);
  let zone = null;
  let sections;

  if (isIp) {
    sections = [await query(resolver, 'PTR', hostname)];
  } else {
    zone = await findZone(resolver, hostname);
    const jobs = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'CAA'].map((t) => query(resolver, t, hostname));
    jobs.push(query(resolver, 'NS', zone), query(resolver, 'SOA', zone));
    if (zone !== hostname) {
      jobs.push(query(resolver, 'MX', zone), query(resolver, 'TXT', zone));
    }
    jobs.push(query(resolver, 'TXT', `_dmarc.${zone}`));
    sections = await Promise.all(jobs);

    const ips = sections
      .filter((s) => s.name === hostname && (s.type === 'A' || s.type === 'AAAA'))
      .flatMap((s) => s.records.map((r) => r.value))
      .slice(0, 4);
    sections.push(...(await Promise.all(ips.map((ip) => query(resolver, 'PTR', ip)))));
  }

  const [system, raw] = await Promise.all([
    isIp ? null : systemLookup(hostname),
    rawToolOutput(hostname, isIp, server),
  ]);

  return {
    query: hostname,
    isIp,
    zone,
    server: server.label,
    sections,
    system,
    raw,
    durationMs: Date.now() - started,
  };
}

function listServers() {
  const list = Object.entries(DNS_SERVERS).map(([key, s]) => ({ key, label: s.label }));
  const global = dnsConfig.getGlobalServers();
  if (global.length) list.unshift({ key: 'global', label: `Global (${global.join(', ')})`, isDefault: true });
  return list;
}

// Clears the Windows DNS client (resolver) cache; does not require elevation.
function flushCache() {
  if (process.platform !== 'win32') return Promise.reject(new Error('Flushing the DNS cache is only supported on Windows'));
  const ipconfig = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ipconfig.exe');
  return new Promise((resolve, reject) => {
    execFile(ipconfig, ['/flushdns'], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (err) reject(new Error(output || err.message));
      else resolve({ output, flushedAt: new Date().toISOString() });
    });
  });
}

module.exports = { lookup, listServers, normalizeTarget, flushCache };
