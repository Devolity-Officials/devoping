// TCP port monitoring definitions: well-known service names and the parser for user input.
// A host's ports are stored as [{ port: 443, service: 'https' }, { port: 9000, service: 'myapp', custom: true }].

const MAX_PORTS = 32;

// Name -> port. The first name listed for a port is used as its display name.
const SERVICES = {
  ftp: 21,
  ssh: 22,
  sftp: 22,
  telnet: 23,
  smtp: 25,
  dns: 53,
  http: 80,
  pop3: 110,
  imap: 143,
  ldap: 389,
  https: 443,
  smb: 445,
  smtps: 465,
  submission: 587,
  ldaps: 636,
  imaps: 993,
  pop3s: 995,
  mssql: 1433,
  oracle: 1521,
  mqtt: 1883,
  nfs: 2049,
  docker: 2376,
  mysql: 3306,
  rdp: 3389,
  postgres: 5432,
  postgresql: 5432,
  amqp: 5672,
  vnc: 5900,
  winrm: 5985,
  'winrm-https': 5986,
  redis: 6379,
  kubernetes: 6443,
  'http-alt': 8080,
  'https-alt': 8443,
  elasticsearch: 9200,
  memcached: 11211,
  mongodb: 27017,
};

const NAME_BY_PORT = {};
for (const [name, port] of Object.entries(SERVICES)) if (!NAME_BY_PORT[port]) NAME_BY_PORT[port] = name;

// Plaintext services that greet the client first; their first line (e.g. "SSH-2.0-OpenSSH_9.6") is recorded.
const BANNER_PORTS = new Set([21, 22, 23, 25, 110, 143, 587, 5900]);

const LABEL_RE = /^[a-z0-9][a-z0-9_.-]{0,23}$/i;

function serviceName(port) {
  return NAME_BY_PORT[port] || null;
}

function toPort(value, token) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid port "${token}" (use 1-65535 or a service name)`);
  return n;
}

// Accepts "443, 8080 ssh;ftp 9000:myapp", an array of such tokens/numbers, or stored port objects.
function parsePorts(input) {
  if (input === undefined || input === null || input === '') return [];
  const tokens = Array.isArray(input)
    ? input.flatMap((t) => (t && typeof t === 'object' ? [`${t.port}${t.custom && t.service ? `:${t.service}` : ''}`] : String(t).split(/[\s,;]+/)))
    : String(input).split(/[\s,;]+/);
  const out = [];
  const seen = new Set();
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    let port;
    let service;
    let custom = false;
    const labelled = /^(\d{1,5})[:/](.+)$/.exec(token);
    if (labelled) {
      port = toPort(labelled[1], token);
      if (!LABEL_RE.test(labelled[2])) throw new Error(`Invalid port label "${labelled[2]}" (letters, digits, - _ . up to 24 chars)`);
      service = labelled[2].toLowerCase();
      custom = true;
    } else if (/^\d+$/.test(token)) {
      port = toPort(token, token);
      service = serviceName(port);
    } else if (SERVICES[token.toLowerCase()]) {
      service = token.toLowerCase();
      port = SERVICES[service];
    } else {
      throw new Error(`Unknown service "${token}". Use a port number, e.g. 9000 or 9000:${token.toLowerCase().slice(0, 20)}`);
    }
    if (seen.has(port)) continue;
    seen.add(port);
    out.push(custom ? { port, service, custom: true } : { port, service: service || null });
  }
  if (out.length > MAX_PORTS) throw new Error(`At most ${MAX_PORTS} ports per host`);
  return out;
}

// Compact text form used in CSV/JSON exports, e.g. "443;22;9000:myapp".
function formatPorts(ports, separator = ', ') {
  return (ports || []).map((p) => (p.custom && p.service ? `${p.port}:${p.service}` : String(p.port))).join(separator);
}

module.exports = { MAX_PORTS, SERVICES, BANNER_PORTS, serviceName, parsePorts, formatPorts };
