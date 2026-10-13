// Portable data folder next to the exe (the project folder in development):
//   devoping_data/  config.json, monitoring.db, alerts.json, telnet-history.log
//   devoping_data/backup/   backups + config.json.bak
//   devoping_data/logs/     devoping.log
//   devoping_data/session/  Electron/Chromium data and machine-bound files (DPAPI secrets, telemetry queue)
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const DATA_DIR_NAME = 'devoping_data';
// Files from older layouts and where they live now; existing files are never overwritten.
const LEGACY_FILES = {
  'config.json': 'config.json',
  'config.json.bak': 'backup/config.json.bak',
  'monitoring.db': 'monitoring.db',
  'alerts.json': 'alerts.json',
  'telnet-history.log': 'telnet-history.log',
  'secrets.json': 'session/secrets.json',
  'telemetry-queue.json': 'session/telemetry-queue.json',
};
const LEGACY_DIRS = { backup: 'backup', logs: 'logs' };

let legacyDirectories = [];
const ensured = new Set();

function getInstallDir() {
  return app.isPackaged
    ? process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'))
    : path.join(__dirname, '..');
}

function copyMissing(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (!fs.existsSync(to)) {
      fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: false });
    } else if (entry.isDirectory() && fs.statSync(to).isDirectory()) {
      copyMissing(from, to);
    }
  }
}

function configurePortableData() {
  const dataDir = path.join(getInstallDir(), DATA_DIR_NAME);
  const sessionDir = path.join(dataDir, 'session');
  const roamingDir = app.getPath('appData');

  fs.mkdirSync(sessionDir, { recursive: true });
  legacyDirectories = [app.getPath('userData'), path.join(roamingDir, 'DevoWatch'), path.join(roamingDir, 'devowatch')];
  // Chromium's own files stay in session/ so the top level only holds Devoping's data.
  app.setPath('userData', sessionDir);
  app.setPath('sessionData', sessionDir);
  app.setPath('crashDumps', path.join(sessionDir, 'Crashpad'));
  app.setPath('logs', path.join(dataDir, 'logs'));
  return dataDir;
}

function copyFileIfMissing(from, to) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function migrateFrom(source, dataDir) {
  if (!fs.existsSync(source) || path.resolve(source) === path.resolve(dataDir)) return;
  for (const [from, to] of Object.entries(LEGACY_FILES)) copyFileIfMissing(path.join(source, from), path.join(dataDir, to));
  for (const [from, to] of Object.entries(LEGACY_DIRS)) copyMissing(path.join(source, from), path.join(dataDir, to));
}

// Copies data from older layouts (appdata/, data/, backup/ next to the exe, %APPDATA%\Devoping).
function migrateLegacyData() {
  const installDir = getInstallDir();
  const dataDir = path.join(installDir, DATA_DIR_NAME);
  migrateFrom(path.join(installDir, 'appdata'), dataDir);
  migrateFrom(path.join(installDir, 'data'), dataDir);
  copyMissing(path.join(installDir, 'backup'), path.join(dataDir, 'backup'));
  for (const legacyDir of legacyDirectories) migrateFrom(legacyDir, dataDir);
  // Files dropped into the top level from an old appdata folder are moved to their subfolder.
  for (const [from, to] of Object.entries(LEGACY_FILES)) {
    const src = path.join(dataDir, from);
    const dest = path.join(dataDir, to);
    if (src !== dest && fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
    }
  }
}

function ensureDir(dir) {
  if (!ensured.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    ensured.add(dir);
  }
  return dir;
}

function getDataDir() {
  return ensureDir(path.join(getInstallDir(), DATA_DIR_NAME));
}

function getBackupDir() {
  return ensureDir(path.join(getDataDir(), 'backup'));
}

function getSessionDir() {
  return ensureDir(path.join(getDataDir(), 'session'));
}

function getConfigPath() {
  return path.join(getDataDir(), 'config.json');
}

function getConfigBackupPath() {
  return path.join(getBackupDir(), 'config.json.bak');
}

function getDbPath() {
  return path.join(getDataDir(), 'monitoring.db');
}

function getLogDir() {
  return path.join(getDataDir(), 'logs');
}

module.exports = {
  DATA_DIR_NAME,
  getInstallDir,
  configurePortableData,
  migrateLegacyData,
  getDataDir,
  getBackupDir,
  getSessionDir,
  getConfigPath,
  getConfigBackupPath,
  getDbPath,
  getLogDir,
};
