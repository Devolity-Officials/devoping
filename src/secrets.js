// Credential store for cloud-backup secrets (S3 keys, OAuth refresh tokens, backup passphrase).
// Values are encrypted with Electron safeStorage (Windows DPAPI: bound to the current Windows
// user) and kept in data/secrets.json. They are never exported; they are only copied into
// passphrase-encrypted full backups (see backup/index.js).
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const { getDataDir } = require('./paths');
const { writeFileAtomic } = require('./fsutil');
const log = require('./logger');

let cache = null;

function filePath() {
  return path.join(getDataDir(), 'secrets.json');
}

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist() {
  writeFileAtomic(filePath(), JSON.stringify(load(), null, 2));
}

function set(key, value) {
  const all = load();
  if (value === null || value === undefined || value === '') {
    delete all[key];
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure OS credential storage is unavailable, so credentials cannot be saved.');
    }
    all[key] = safeStorage.encryptString(String(value)).toString('base64');
  }
  persist();
}

function get(key) {
  const value = load()[key];
  if (!value) return null;
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    // Typically: the data folder was copied from another Windows user/PC (DPAPI-bound).
    log.warn(`Stored credential "${key}" can't be decrypted on this account; re-enter it.`);
    return null;
  }
}

function has(key) {
  return Boolean(load()[key]);
}

function removePrefix(prefix) {
  const all = load();
  Object.keys(all).filter((k) => k.startsWith(prefix)).forEach((k) => delete all[k]);
  persist();
}

// Decrypted copy of every readable secret whose key starts with `prefix`.
function exportPrefix(prefix) {
  const out = {};
  Object.keys(load()).filter((k) => k.startsWith(prefix)).forEach((k) => {
    const v = get(k);
    if (v !== null) out[k] = v;
  });
  return out;
}

module.exports = { get, set, has, removePrefix, exportPrefix };
