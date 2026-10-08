// Keeps all app data, including Electron's userData, under <install>/appdata.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
let legacyDirectories = [];

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
  const installDir = getInstallDir();
  const appDataDir = path.join(installDir, 'appdata');
  const roamingDir = app.getPath('appData');

  fs.mkdirSync(appDataDir, { recursive: true });
  legacyDirectories = [app.getPath('userData'), path.join(roamingDir, 'DevoWatch'), path.join(roamingDir, 'devowatch')];
  app.setPath('userData', appDataDir);
  app.setPath('sessionData', path.join(appDataDir, 'session'));
  return appDataDir;
}

function migrateLegacyData() {
  const appDataDir = path.join(getInstallDir(), 'appdata');
  copyMissing(path.join(getInstallDir(), 'data'), appDataDir);
  copyMissing(path.join(getInstallDir(), 'backup'), path.join(appDataDir, 'backup'));
  for (const legacyDir of legacyDirectories) {
    if (path.resolve(legacyDir) !== path.resolve(appDataDir)) copyMissing(legacyDir, appDataDir);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getDataDir() {
  return ensureDir(path.join(getInstallDir(), 'appdata'));
}

function getBackupDir() {
  return ensureDir(path.join(getDataDir(), 'backup'));
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

module.exports = { getInstallDir, configurePortableData, migrateLegacyData, getDataDir, getBackupDir, getConfigPath, getDbPath, getLogDir };
