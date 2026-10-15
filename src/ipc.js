// Registers all ipcMain handlers exposed to the renderer via preload's contextBridge.
const fs = require('fs');
const net = require('net');
const { app, ipcMain, dialog, shell, BrowserWindow } = require('electron');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const monitor = require('./monitor');
const dnsTools = require('./dns-tools');
const dnsConfig = require('./dns-config');
const transfer = require('./transfer');
const backup = require('./backup');
const report = require('./report');
const telnet = require('./telnet');
const telemetry = require('./telemetry');
const alerts = require('./alerts');
const notify = require('./notify');
const domains = require('./domains');
const log = require('./logger');
const { getDataDir, getBackupDir } = require('./paths');
const { resolveHostIp, checkPing, checkTcp, checkHttp } = require('./checks');
const { parsePorts } = require('./ports');

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;

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
  if ('domainWarnDays' in partial) out.domainWarnDays = intSetting(partial.domainWarnDays, 1, 365, 'Domain warning threshold');
  if ('domainCriticalDays' in partial) out.domainCriticalDays = intSetting(partial.domainCriticalDays, 1, 365, 'Domain critical threshold');
  if ('dnsServers' in partial) out.dnsServers = dnsConfig.parseServers(partial.dnsServers);
  if ('notifyEnabled' in partial) out.notifyEnabled = partial.notifyEnabled === true;
  if ('notifyRepeatMinutes' in partial) out.notifyRepeatMinutes = intSetting(partial.notifyRepeatMinutes, 15, 1440, 'Notification reminder interval');
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

// Ad-hoc connectivity test for an IP/hostname/URL: ping, HTTP (if a URL) and any listed TCP ports.
async function runConnectivityTest(rawTarget, rawPorts) {
  const target = String(rawTarget || '').trim();
  if (!target) throw new Error('Enter an IP address, hostname or URL');
  if (target.length > 2048) throw new Error('Target is too long');
  let url = null;
  let host = target;
  if (/^https?:\/\//i.test(target)) {
    url = target;
    try {
      host = new URL(target).hostname.replace(/^\[|\]$/g, '');
    } catch {
      throw new Error('Invalid URL');
    }
  }
  if (net.isIP(host) === 0 && !HOSTNAME_RE.test(host)) throw new Error(`Invalid target "${host}"`);
  const ports = parsePorts(rawPorts);
  const resolvedIp = net.isIP(host) ? host : await resolveHostIp(host);
  const pingTarget = resolvedIp || host;
  const [http, ping, portResults] = await Promise.all([
    url ? checkHttp(url, { followRedirects: true }) : Promise.resolve(null),
    checkPing(pingTarget),
    Promise.all(ports.map(async (p) => ({ port: p.port, service: p.service || null, ...(await checkTcp(pingTarget, p.port)) }))),
  ]);
  return { target, url, host, resolvedIp: resolvedIp || null, http, ping, ports: portResults };
}

// Renders a report HTML document to a PDF file using an offscreen window (no scripts).
async function writePdf(html, filePath) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    await fs.promises.writeFile(filePath, pdf);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

const EXPORTS = {
  'hosts-json': { title: 'Export hosts', file: 'devoping-hosts.json', filters: [{ name: 'JSON', extensions: ['json'] }] },
  'hosts-csv': { title: 'Export hosts', file: 'devoping-hosts.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] },
  'history-csv': { title: 'Export check history', file: 'devoping-history.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] },
};

function registerIpcHandlers(getMainWindow) {
  const send = (channel, payload) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };
  monitor.setBroadcaster(send);
  alerts.setBroadcaster(send);
  notify.init(getMainWindow);
  domains.setBroadcaster(send);
  telnet.init({ broadcast: send });

  const startSession = () => {
    monitor.startAll();
    monitor.startRetentionJob();
    domains.start();
  };

  // config.json replaced on disk (e.g. copied from another PC): apply it without a restart.
  config.onReload(() => {
    if (!currentUser) {
      send('config:reloaded', { signedIn: false });
      return;
    }
    monitor.stopAll();
    domains.stop();
    if (config.findUser(currentUser.username)) {
      startSession();
    } else {
      log.info(`User "${currentUser.username}" no longer exists in the reloaded config.json; signed out`);
      currentUser = null;
      telnet.stopAll();
    }
    send('config:reloaded', { signedIn: Boolean(currentUser) });
  });

  handle('auth:needsSetup', () => auth.needsSetup());

  handle('auth:createFirstUser', async (_e, { username, password, profile } = {}) => {
    const user = await auth.createFirstUser(username, password, profile);
    currentUser = { username: user.username };
    startSession();
    return user;
  });

  handle('auth:login', async (_e, { username, password } = {}) => {
    const user = await auth.login(username, password);
    currentUser = { username: user.username };
    startSession();
    return user;
  });

  handle('auth:loginPin', async (_e, { username, pin } = {}) => {
    const user = await auth.loginWithPin(username, pin);
    currentUser = { username: user.username };
    startSession();
    return user;
  });

  handle('auth:setPin', (_e, { password, pin } = {}) => {
    requireAuth();
    return auth.setPin(currentUser.username, password, pin);
  });

  handle('auth:removePin', () => {
    requireAuth();
    return auth.removePin(currentUser.username);
  });

  handle('auth:logout', () => {
    if (currentUser) log.info(`User "${currentUser.username}" signed out`);
    currentUser = null;
    monitor.stopAll();
    domains.stop();
    telnet.stopAll();
    return true;
  });

  handle('auth:currentUser', () => (currentUser ? auth.getProfile(currentUser.username) : null));

  handle('auth:changePassword', async (_e, { oldPassword, newPassword } = {}) => {
    requireAuth();
    return auth.changePassword(currentUser.username, oldPassword, newPassword);
  });

  handle('auth:updateProfile', (_e, patch) => {
    requireAuth();
    return auth.updateProfile(currentUser.username, patch);
  });

  // ---- alerts ----
  handle('alerts:list', () => {
    requireAuth();
    return alerts.list();
  });

  handle('alerts:markRead', () => {
    requireAuth();
    return alerts.markRead();
  });

  handle('alerts:clear', () => {
    requireAuth();
    return alerts.clear();
  });

  handle('notify:test', () => {
    requireAuth();
    return notify.test();
  });

  // ---- domains (WHOIS / expiry) ----
  handle('domains:list', () => {
    requireAuth();
    return domains.list();
  });

  handle('domains:lookup', (_e, target) => {
    requireAuth();
    telemetry.count('feature_whois');
    return domains.lookup(String(target || '').slice(0, 300));
  });

  handle('domains:add', (_e, name) => {
    requireAuth();
    telemetry.count('feature_domain_watch');
    return domains.add(String(name || '').slice(0, 300));
  });

  handle('domains:remove', (_e, id) => {
    requireAuth();
    return domains.remove(requireId(id));
  });

  handle('domains:check', (_e, id) => {
    requireAuth();
    return id === 'all' ? domains.checkAll() : domains.check(requireId(id));
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
    alerts.forgetHost(id);
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

  handle('dns:flush', async () => {
    requireAuth();
    telemetry.count('feature_dns_flush');
    const result = await dnsTools.flushCache();
    log.info('Flushed the Windows DNS resolver cache');
    return result;
  });

  // ---- connectivity test tool ----
  handle('tools:test', async (_e, { target, ports } = {}) => {
    requireAuth();
    telemetry.count('feature_connectivity_test');
    return runConnectivityTest(target, ports);
  });

  // ---- telnet console ----
  handle('telnet:connect', (_e, { target, port } = {}) => {
    requireAuth();
    telemetry.count('feature_telnet');
    return telnet.connect(target, port);
  });

  handle('telnet:send', (_e, { sessionId, data } = {}) => {
    requireAuth();
    return telnet.send(String(sessionId), data);
  });

  handle('telnet:disconnect', (_e, { sessionId } = {}) => {
    requireAuth();
    return telnet.disconnect(String(sessionId));
  });

  handle('telnet:history', () => {
    requireAuth();
    return telnet.readHistory();
  });

  handle('telnet:clearHistory', () => {
    requireAuth();
    return telnet.clearHistory();
  });

  // ---- reports ----
  handle('report:export', async (_e, { scope, format } = {}) => {
    requireAuth();
    const fmt = ['html', 'csv', 'pdf'].includes(format) ? format : 'html';
    const sc = scope && scope !== 'all' ? requireId(scope) : 'all';
    if (sc !== 'all' && !config.getHost(sc)) throw new Error('Host not found');
    const { retentionDays } = config.getSettings();
    const base = sc === 'all' ? 'devoping-report' : `devoping-report-${sc.slice(0, 8)}`;
    const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Export report',
      defaultPath: `${base}.${fmt}`,
      filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }],
    });
    if (canceled || !filePath) return { canceled: true };
    telemetry.count(`feature_report_${fmt}`);
    if (fmt === 'csv') {
      await fs.promises.writeFile(filePath, report.toCsv({ scope: sc, days: retentionDays }), 'utf8');
    } else {
      const html = report.toHtml({ scope: sc, days: retentionDays });
      if (fmt === 'html') await fs.promises.writeFile(filePath, html, 'utf8');
      else await writePdf(html, filePath);
    }
    log.info(`Exported ${fmt} report (${sc}) to ${filePath}`);
    return { filePath };
  });

  handle('report:saveImage', async (_e, { name, dataUrl } = {}) => {
    requireAuth();
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw new Error('Invalid image data');
    const buffer = Buffer.from(m[1], 'base64');
    if (buffer.length > 20 * 1024 * 1024) throw new Error('Image is too large');
    const safe = String(name || 'chart').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80) || 'chart';
    const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Save chart image',
      defaultPath: `${safe}.png`,
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    await fs.promises.writeFile(filePath, buffer);
    log.info(`Saved chart image to ${filePath}`);
    return { filePath };
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

  handle('app:info', () => ({ name: 'Devoping', version: app.getVersion(), homepage: HOMEPAGE, electron: process.versions.electron }));

  // Only the product website may be opened from the UI (in the default browser).
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

  handle('backup:setPassphrase', (_e, passphrase) => {
    requireAuth();
    return backup.setPassphrase(passphrase);
  });

  handle('backup:runLocal', () => {
    requireAuth();
    telemetry.count('feature_backup_local');
    return backup.backupLocalNow();
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
