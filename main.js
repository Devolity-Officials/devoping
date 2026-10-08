const { app, BrowserWindow, Menu, dialog, powerMonitor, session } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const log = require('./src/logger');
const paths = require('./src/paths');

paths.configurePortableData();

const INDEX_HTML = path.join(__dirname, 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_HTML).href;
// Must match the dark theme's --sidebar/--foreground/--background in style.css. The overlay is
// 1px shorter than --titlebar-h (36px) so the title bar's bottom border shows under the buttons.
const TITLEBAR = { height: 35, color: '#13151b', symbolColor: '#eef0f4', background: '#0f1115' };

let mainWindow = null;
let db = null;
let monitor = null;
let backup = null;
let telemetry = null;

// One instance per data folder - two copies writing the same config/DB would corrupt them.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  try {
    paths.migrateLegacyData();
    start();
  } catch (err) {
    dialog.showErrorBox('Devoping could not migrate application data', String(err.message || err));
    app.exit(1);
  }
}

function start() {
  const { getLogDir, getDataDir } = paths;
  process.on('uncaughtException', (err) => log.error(`Uncaught exception: ${err.stack || err}`));
  process.on('unhandledRejection', (reason) => log.error(`Unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`));

  hardenWebContents();

  app.whenReady().then(async () => {
    try {
      log.init(getLogDir());
      log.info(`Devoping ${app.getVersion()} starting (Electron ${process.versions.electron}, data: ${getDataDir()})`);
      lockDownSession();
      Menu.setApplicationMenu(null);

      // Config is a small sync read; load it and register IPC, then paint the window immediately.
      require('./src/config').load();
      monitor = require('./src/monitor');
      const broadcast = require('./src/ipc').registerIpcHandlers(() => mainWindow);
      createWindow();

      // The SQLite history DB (WASM) is the heaviest step; initialise it after the UI is up.
      db = require('./src/db');
      await db.initDb();

      // Non-critical for first paint and login: start these once the window is shown.
      backup = require('./src/backup');
      backup.init({
        broadcast,
        appVersion: app.getVersion(),
        // Restored hosts/settings take effect immediately for a signed-in session.
        onRestored: () => {
          if (monitor.isActive()) {
            monitor.stopAll();
            monitor.startAll();
          }
        },
      });
      telemetry = require('./src/telemetry');
      telemetry.init({ version: app.getVersion(), electron: process.versions.electron, locale: app.getLocale(), environment: app.isPackaged ? 'production' : 'development' });
    } catch (err) {
      log.error(`Startup failed: ${err.stack || err}`);
      dialog.showErrorBox('Devoping could not start', String(err.message || err));
      app.exit(1);
      return;
    }

    // Laptops sleep often: refresh everything as soon as the machine wakes up.
    powerMonitor.on('resume', () => {
      log.info('System resumed from sleep');
      if (monitor && monitor.isActive()) setTimeout(() => monitor.checkAll(), 5000);
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    // Hold the quit briefly so pending telemetry can be uploaded.
    event.preventDefault();
    try {
      if (monitor) monitor.stopAll();
      require('./src/telnet').stopAll();
      if (backup) backup.stop();
    } catch (err) {
      log.error(`Shutdown error: ${err.stack || err}`);
    }
    Promise.resolve(telemetry && telemetry.stop())
      .catch((err) => log.error(`Telemetry shutdown error: ${err.message}`))
      .finally(() => {
        try {
          if (db) db.close();
          log.info('Devoping stopped');
        } catch (err) {
          log.error(`Shutdown error: ${err.stack || err}`);
        }
        app.quit();
      });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// The UI is a local page only: no navigation, pop-ups, webviews or remote content.
function hardenWebContents() {
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      log.warn(`Blocked window.open to ${url}`);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (url !== INDEX_URL) {
        event.preventDefault();
        log.warn(`Blocked navigation to ${url}`);
      }
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

// Deny every permission request (camera, mic, geolocation, notifications, ...).
function lockDownSession() {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 650,
    title: 'Devoping',
    icon: path.join(__dirname, 'renderer', 'img', 'icon.png'),
    backgroundColor: TITLEBAR.background,
    // Custom themed title bar; Windows still draws (and recolours) the min/max/close buttons.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: TITLEBAR.color, symbolColor: TITLEBAR.symbolColor, height: TITLEBAR.height },
    // Show only once the first frame is painted, to avoid a white flash and feel faster.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  mainWindow.loadFile(INDEX_HTML);

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error(`Renderer process gone: ${details.reason} (exit code ${details.exitCode})`);
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => mainWindow && !mainWindow.isDestroyed() && mainWindow.reload(), 1000);
    }
  });
  mainWindow.on('unresponsive', () => log.warn('Window became unresponsive'));
  mainWindow.on('responsive', () => log.info('Window responsive again'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('child-process-gone', (_e, details) => {
  log.error(`Child process gone: ${details.type} ${details.reason} (exit code ${details.exitCode})`);
});
