// Keeps all app data next to the executable so the whole folder / portable exe can be copied
// elsewhere without losing data:
//   <root>/data/     config.json, monitoring.db, secrets.json, logs/
//   <root>/backup/   automatic configuration backups (and manual full backups)
// <root> is the exe folder, or the user profile if that folder is read-only.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let cachedRootDir = null;

function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

// Folder the user launched DevoWatch from (where an administrator may place policy.json).
function getInstallDir() {
  // electron-builder's portable exe runs from a temp extraction dir; PORTABLE_EXECUTABLE_DIR is the real exe location.
  return app.isPackaged
    ? process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'))
    : path.join(__dirname, '..');
}

function getRootDir() {
  if (cachedRootDir) return cachedRootDir;
  const base = getInstallDir();
  // Read-only locations (Program Files, locked-down shares) fall back to the user profile.
  cachedRootDir = isWritableDir(path.join(base, 'data')) ? base : app.getPath('userData');
  return cachedRootDir;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getDataDir() {
  return ensureDir(path.join(getRootDir(), 'data'));
}

function getBackupDir() {
  return ensureDir(path.join(getRootDir(), 'backup'));
}

function getConfigPath() {
  return path.join(getDataDir(), 'config.json');
}

function getDbPath() {
  return path.join(getDataDir(), 'monitoring.db');
}

function getLogDir() {
  return path.join(getDataDir(), 'logs');
}

module.exports = { getInstallDir, getRootDir, getDataDir, getBackupDir, getConfigPath, getDbPath, getLogDir };
