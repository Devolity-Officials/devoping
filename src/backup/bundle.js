// Backup file format.
//   plain:     gzip(JSON envelope)                       -> *.json.gz   (or *.json for config snapshots)
//   encrypted: "DWENC1" | salt(16) | iv(12) | tag(16) | AES-256-GCM(gzip(JSON))  -> *.json.gz.enc
// Envelope: { app: 'Devoping', format: 1, kind: 'config'|'full', createdAt, appVersion, config, db?, secrets? }
// `db` is the base64 SQLite file (check history) and is present only in 'full' backups.
// `secrets` (cloud credentials) is present only in encrypted full backups.
const zlib = require('zlib');
const crypto = require('crypto');

const APP = 'Devoping';
const FORMAT = 1;
const MAGIC = Buffer.from('DWENC1');
const MAX_BACKUP_BYTES = 200 * 1024 * 1024;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function envelope({ kind, config, dbBuffer, appVersion, secrets }) {
  return {
    app: APP,
    format: FORMAT,
    kind,
    createdAt: new Date().toISOString(),
    appVersion,
    config,
    db: dbBuffer ? dbBuffer.toString('base64') : undefined,
    secrets: secrets && Object.keys(secrets).length ? secrets : undefined,
  };
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, SCRYPT);
}

function encrypt(buffer, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

function decrypt(buffer, passphrase) {
  if (!passphrase) throw new Error('This backup is encrypted. Set the backup passphrase first.');
  let offset = MAGIC.length;
  const salt = buffer.subarray(offset, (offset += 16));
  const iv = buffer.subarray(offset, (offset += 12));
  const tag = buffer.subarray(offset, (offset += 16));
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(buffer.subarray(offset)), decipher.final()]);
  } catch {
    throw new Error('Wrong passphrase or damaged backup file.');
  }
}

// Builds a compressed (and optionally encrypted) backup file. Returns { buffer, extension }.
function pack(env, passphrase) {
  if (env.secrets && !passphrase) throw new Error('Credentials may only be stored in encrypted backups');
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(env)), { level: 9 });
  return passphrase ? { buffer: encrypt(gz, passphrase), extension: '.json.gz.enc' } : { buffer: gz, extension: '.json.gz' };
}

// Accepts any backup flavour (plain JSON, gzip, encrypted) and returns the validated envelope.
function unpack(buffer, passphrase) {
  if (buffer.length > MAX_BACKUP_BYTES) throw new Error('Backup file is too large');
  let data = buffer;
  if (data.subarray(0, MAGIC.length).equals(MAGIC)) data = decrypt(data, passphrase);
  if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data, { maxOutputLength: MAX_BACKUP_BYTES * 2 });
  let env;
  try {
    env = JSON.parse(data.toString('utf8'));
  } catch {
    throw new Error('Not a Devoping backup file');
  }
  if (!env || ![APP, 'DevoWatch'].includes(env.app) || env.format !== FORMAT || !env.config) throw new Error('Not a Devoping backup file');
  return { ...env, db: env.db ? Buffer.from(env.db, 'base64') : null };
}

function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

module.exports = { envelope, pack, unpack, timestamp, MAX_BACKUP_BYTES };
