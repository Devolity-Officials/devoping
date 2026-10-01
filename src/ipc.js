// Registers all ipcMain handlers exposed to the renderer via preload's contextBridge.
const fs = require('fs');
const { app, ipcMain, dialog, shell } = require('electron');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const monitor = require('./monitor');
const dnsTools = require('./dns-tools');
const dnsConfig = require('./dns-config');
const transfer = require('./transfer');
const backup = require('./backup');
const telemetry = require('./telemetry');
const log = require('./logger');
const { getDataDir, getBackupDir } = require('./paths');
const { resolveHostIp } = require('./checks');

const IMPORT_RESOLVE_CONCURRENCY = 10;
const HOMEPAGE = 'https://devolity.com';

// Very small session gate: only the login/setup channels work before a
// successful login, everything else requires currentUser to be set.
let currentUser = null;

function requireAuth() {
  if (!currentUser) {
    throw new Error('Not authenticated');
  }
}

// Only the app's own bundled page may call into the main process.
function isTrustedSender(event) {
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === 'string' && url.startsWith('file://') && url.endsWith('/renderer/index.html');
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) {
      log.warn(`Blocked IPC "${channel}" from untrusted sender ${event.senderFrame && event.senderFrame.url}`);
      throw new Error('Untrusted sender');
    }
    try {
      return await fn(event, ...args);
    } catch (err) {
      log.warn(`IPC ${channel} failed: ${err.message}`);
      throw err;
    }
  });
}

function requireId(id) {
  if (typeof id !== 'string' || !id || id.length > 100) throw new Error('Invalid host id');
  return id;
}

function sinceDays(days) {
  const d = Math.min(Math.max(Number(days) || 7, 1), 365);
  return Date.now() - d * 24 * 60 * 60 * 1000;
}

// URL-only hosts get their IP resolved automatically (and kept fresh by the monitor).
// An IP the user typed in - anything other than the current auto value - is kept as manual.
async function withAutoIp(host, existing = null) {
  // Partial updates that don't touch the IP (e.g. pause/resume) leave it as-is.
  if (existing && host.ip === undefined) return host;
  const ip = (host.ip || '').trim();
  const url = host.url !== undefined ? host.url : existing && existing.url;
  const keepsAutoIp = existing && existing.ipAuto && ip === existing.ip;
  if ((ip && !keepsAutoIp) || !url) return { ...host, ip, ipAuto: false };
  let hostname;
  try {
    hostname = new URL(url.trim()).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return { ...host, ip, ipAuto: false };
  }
  const resolved = await resolveHostIp(hostname);
  return { ...host, ip: resolved || ip, ipAuto: true };
}

function intSetting(value, min, max, name) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}

function validateSettings(partial) {
  const out = {};
  if ('retentionDays' in partial) out.retentionDays = intSetting(partial.retentionDays, 1, 365, 'Retention');
  if ('defaultIntervalMinutes' in partial) out.defaultIntervalMinutes = intSetting(partial.defaultIntervalMinutes, 1, 1440, 'Default interval');
  if ('sslWarnDays' in partial) out.sslWarnDays = intSetting(partial.sslWarnDays, 1, 365, 'SSL warning threshold');
  if ('sslCriticalDays' in partial) out.sslCriticalDays = intSetting(partial.sslCriticalDays, 1, 365, 'SSL critical threshold');
  if ('dnsServers' in partial) out.dnsServers = dnsConfig.parseServers(partial.dnsServers);
  if ('theme' in partial) {
    if (!['dark', 'light'].includes(partial.theme)) throw new Error('Invalid theme');
    out.theme = partial.theme;
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const EXPORTS = {
  'hosts-json': { title: 'Export hosts', file: 'devowatch-hosts.json', filters: [{ name: 'JSON', extensions: ['json'] }] },
  'hosts-csv': { title: 'Export hosts', file: 'devowatch-hosts.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] },
  'history-csv': { title: 'Export check history', file: 'devowatch-history.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] },
};

function registerIpcHandlers(getMainWindow) {
  const send = (channel, payload) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };
  monitor.setBroadcaster(send);

  handle('auth:needsSetup', () => auth.needsSetup());

  handle('auth:createFirstUser', async (_e, { username, password } = {}) => {
    const user = await auth.createFirstUser(username, password);
    currentUser = { username: user.username };
    monitor.startAll();
    monitor.startRetentionJob();
    return currentUser;
  });

  handle('auth:login', async (_e, { username, password } = {}) => {
    const user = await auth.login(username, password);
    currentUser = user;
    monitor.startAll();
    monitor.startRetentionJob();
    return currentUser;
  });

  handle('auth:logout', () => {
    if (currentUser) log.info(`User "${currentUser.username}" signed out`);
    currentUser = null;
    monitor.stopAll();
    return true;
  });

  handle('auth:currentUser', () => currentUser);

  handle('auth:changePassword', async (_e, { oldPassword, newPassword } = {}) => {
    requireAuth();
    return auth.changePassword(currentUser.username, oldPassword, newPassword);
  });

  // ---- hosts ----
  handle('hosts:list', () => {
    requireAuth();
    return config.getHosts();
  });

  handle('hosts:add', async (_e, host) => {
    requireAuth();
    const created = config.addHost(await withAutoIp(transfer.validateHostInput(host)));
    monitor.reschedule(created.id);
    log.info(`Host added: ${created.name}`);
    return created;
  });

  handle('hosts:update', async (_e, { id, patch } = {}) => {
    requireAuth();
    const existing = config.getHost(requireId(id));
    if (!existing) throw new Error('Host not found');
    const changes = await withAutoIp(transfer.validateHostInput(patch, { partial: true }), existing);
    const merged = { ...existing, ...changes };
    if (!merged.url && !merged.ip) throw new Error('Provide a URL or an IP address (or both)');
    const updated = config.updateHost(id, changes);
    monitor.reschedule(id);
    return updated;
  });

  handle('hosts:delete', (_e, id) => {
    requireAuth();
    const deleted = config.deleteHost(requireId(id));
    monitor.reschedule(id);
    db.deleteChecksForHost(id);
    return deleted;
  });

  handle('hosts:checkNow', async (_e, id) => {
    requireAuth();
    return monitor.runCheckNow(requireId(id));
  });

  // ---- settings ----
  handle('settings:get', () => {
    requireAuth();
    return config.getSettings();
  });

  handle('settings:update', (_e, partial) => {
    requireAuth();
    const updated = config.updateSettings(validateSettings(partial && typeof partial === 'object' ? partial : {}));
    db.pruneOlderThan(updated.retentionDays);
    return updated;
  });

  // ---- monitoring activity ----
  handle('monitor:activity', () => {
    requireAuth();
    return monitor.getActivity();
  });

  handle('monitor:checkAll', () => {
    requireAuth();
    return monitor.checkAll();
  });

  // ---- import / export ----
  handle('transfer:export', async (_e, kind) => {
    requireAuth();
    const spec = EXPORTS[kind];
    if (!spec) throw new Error('Unknown export type');
    const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
      title: spec.title,
      defaultPath: spec.file,
      filters: spec.filters,
    });
    if (canceled || !filePath) return { canceled: true };
    const result = kind === 'history-csv'
      ? transfer.exportHistory(db.getAllChecksSince(0, 1000000))
      : transfer.exportHosts(kind === 'hosts-csv' ? 'csv' : 'json');
    await fs.promises.writeFile(filePath, result.content, 'utf8');
    log.info(`Exported ${result.count} records (${kind}) to ${filePath}`);
    telemetry.count(`feature_export_${kind.replace('-', '_')}`);
    return { filePath, count: result.count };
  });

  handle('transfer:import', async () => {
    requireAuth();
    const { canceled, filePaths } = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Import hosts',
      properties: ['openFile'],
      filters: [
        { name: 'Host lists', extensions: ['json', 'csv', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    const filePath = filePaths[0];
    const { size } = await fs.promises.stat(filePath);
    if (size > transfer.MAX_IMPORT_BYTES) throw new Error('Import file is larger than 5 MB');
    const text = await fs.promises.readFile(filePath, 'utf8');
    const prepared = transfer.prepareImport(text, filePath);

    let done = 0;
    const total = prepared.hosts.length;
    send('transfer:progress', { phase: 'resolving', done, total });
    const hosts = await mapLimit(prepared.hosts, IMPORT_RESOLVE_CONCURRENCY, async (h) => {
      const withIp = await withAutoIp(h);
      done++;
      send('transfer:progress', { phase: 'resolving', done, total });
      return withIp;
    });
    send('transfer:progress', { phase: 'saving', done: total, total });
    const created = hosts.length ? config.addHosts(hosts) : [];
    created.forEach((h) => monitor.reschedule(h.id));
    send('transfer:progress', { phase: 'done', done: total, total });
    log.info(`Imported ${created.length} hosts from ${filePath} (${prepared.skipped} duplicates, ${prepared.invalid.length} invalid)`);
    telemetry.count('feature_import');
    return {
      filePath,
      added: created.length,
      skipped: prepared.skipped,
      invalid: prepared.invalid.slice(0, 50),
      invalidCount: prepared.invalid.length,
      total: prepared.total,
    };
  });

  // ---- dashboard / data ----
  handle('data:latestPerHost', () => {
    requireAuth();
    return db.getLatestCheckPerHost();
  });

  handle('data:recentChecks', (_e, { hostId, limit } = {}) => {
    requireAuth();
    return db.getRecentChecks(requireId(hostId), Math.min(Math.max(Number(limit) || 100, 1), 5000));
  });

  handle('data:history', (_e, { hostId, days } = {}) => {
    requireAuth();
    return db.getChecksSince(requireId(hostId), sinceDays(days));
  });

  handle('data:uptimeSummary', (_e, { hostId, days } = {}) => {
    requireAuth();
    return db.getUptimeSummary(requireId(hostId), sinceDays(days));
  });

  // ---- DNS tools ----
  handle('dns:servers', () => {
    requireAuth();
    return dnsTools.listServers();
  });

  handle('dns:lookup', (_e, { target, server } = {}) => {
    requireAuth();
    telemetry.count('feature_dns_lookup');
    return dnsTools.lookup(target, server);
  });

  // ---- support ----
  handle('app:openDataFolder', async () => {
    requireAuth();
    const err = await shell.openPath(getDataDir());
    if (err) throw new Error(err);
    return true;
  });

  handle('log:renderer', (_e, message) => {
    log.error(`[renderer] ${String(message).slice(0, 2000)}`);
    return true;
  });

  // Recolours the native window controls so they match the current light/dark theme.
  handle('app:setTitleBarTheme', (_e, { color, symbolColor, background } = {}) => {
    const hex = /^#[0-9a-f]{6}$/i;
    if (![color, symbolColor, background].every((c) => hex.test(String(c)))) throw new Error('Invalid colour');
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return false;
    if (typeof win.setTitleBarOverlay === 'function') win.setTitleBarOverlay({ color, symbolColor });
    win.setBackgroundColor(background);
    return true;
  });

  handle('app:info', () => ({ name: 'DevoWatch', version: app.getVersion(), homepage: HOMEPAGE, electron: process.versions.electron }));

  // Only the DevoWatch website may be opened from the UI (in the default browser).
  handle('app:openExternal', async (_e, url) => {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' || !['devolity.com', 'www.devolity.com'].includes(u.hostname)) throw new Error('Link not allowed');
    await shell.openExternal(u.toString());
    return true;
  });

  // ---- backup & sync ----
  handle('backup:status', () => {
    requireAuth();
    return backup.getStatus();
  });

  handle('backup:updateSettings', (_e, patch) => {
    requireAuth();
    backup.updateSettings(patch && typeof patch === 'object' ? patch : {});
    return backup.getStatus();
  });

  handle('backup:setProvider', (_e, { id, values } = {}) => {
    requireAuth();
    return backup.setProvider(String(id), values && typeof values === 'object' ? values : {});
  });

  handle('backup:connect', (_e, id) => {
    requireAuth();
    return backup.connect(String(id));
  });

  handle('backup:disconnect', (_e, id) => {
    requireAuth();
    return backup.disconnect(String(id));
  });

  handle('backup:test', () => {
    requireAuth();
    return backup.testConnection();
  });

  handle('backup:setPassphrase', (_e, passphrase) => {
    requireAuth();
    return backup.setPassphrase(passphrase);
  });

  handle('backup:runLocal', () => {
    requireAuth();
    telemetry.count('feature_backup_local');
    return backup.backupLocalNow();
  });

  handle('backup:runCloud', () => {
    requireAuth();
    telemetry.count('feature_backup_cloud');
    return backup.backupCloudNow('manual');
  });

  handle('backup:listCloud', () => {
    requireAuth();
    return backup.listCloud();
  });

  handle('backup:restore', (_e, { source, name } = {}) => {
    requireAuth();
    telemetry.count('feature_restore');
    return backup.restore({ source, name });
  });

  handle('backup:openFolder', async () => {
    requireAuth();
    const err = await shell.openPath(getBackupDir());
    if (err) throw new Error(err);
    return true;
  });

  // ---- telemetry ----
  handle('telemetry:status', () => {
    requireAuth();
    return telemetry.getStatus();
  });

  // Only the on/off switch is user-controlled; the endpoint is built in or set by policy.json.
  handle('telemetry:update', (_e, patch) => {
    requireAuth();
    return telemetry.update({ enabled: patch && patch.enabled === true });
  });

  return send;
}

module.exports = { registerIpcHandlers };
