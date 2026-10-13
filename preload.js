const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // auth
  needsSetup: () => ipcRenderer.invoke('auth:needsSetup'),
  createFirstUser: (username, password, profile) => ipcRenderer.invoke('auth:createFirstUser', { username, password, profile }),
  login: (username, password) => ipcRenderer.invoke('auth:login', { username, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  currentUser: () => ipcRenderer.invoke('auth:currentUser'),
  changePassword: (oldPassword, newPassword) => ipcRenderer.invoke('auth:changePassword', { oldPassword, newPassword }),
  updateProfile: (patch) => ipcRenderer.invoke('auth:updateProfile', patch),

  // alerts
  listAlerts: () => ipcRenderer.invoke('alerts:list'),
  markAlertsRead: () => ipcRenderer.invoke('alerts:markRead'),
  clearAlerts: () => ipcRenderer.invoke('alerts:clear'),

  // domains (WHOIS / expiry)
  listDomains: () => ipcRenderer.invoke('domains:list'),
  whoisLookup: (target) => ipcRenderer.invoke('domains:lookup', target),
  addDomain: (name) => ipcRenderer.invoke('domains:add', name),
  removeDomain: (id) => ipcRenderer.invoke('domains:remove', id),
  checkDomain: (id) => ipcRenderer.invoke('domains:check', id),

  // hosts
  listHosts: () => ipcRenderer.invoke('hosts:list'),
  addHost: (host) => ipcRenderer.invoke('hosts:add', host),
  updateHost: (id, patch) => ipcRenderer.invoke('hosts:update', { id, patch }),
  deleteHost: (id) => ipcRenderer.invoke('hosts:delete', id),
  checkHostNow: (id) => ipcRenderer.invoke('hosts:checkNow', id),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),

  // dashboard data
  getLatestPerHost: () => ipcRenderer.invoke('data:latestPerHost'),
  getRecentChecks: (hostId, limit) => ipcRenderer.invoke('data:recentChecks', { hostId, limit }),
  getHistory: (hostId, days) => ipcRenderer.invoke('data:history', { hostId, days }),
  getUptimeSummary: (hostId, days) => ipcRenderer.invoke('data:uptimeSummary', { hostId, days }),

  // DNS tools
  dnsServers: () => ipcRenderer.invoke('dns:servers'),
  dnsLookup: (target, server) => ipcRenderer.invoke('dns:lookup', { target, server }),
  dnsFlush: () => ipcRenderer.invoke('dns:flush'),

  // connectivity test + reports
  testConnectivity: (target, ports) => ipcRenderer.invoke('tools:test', { target, ports }),
  exportReport: (scope, format) => ipcRenderer.invoke('report:export', { scope, format }),
  saveChartPng: (name, dataUrl) => ipcRenderer.invoke('report:saveImage', { name, dataUrl }),

  // telnet console
  telnetConnect: (target, port) => ipcRenderer.invoke('telnet:connect', { target, port }),
  telnetSend: (sessionId, data) => ipcRenderer.invoke('telnet:send', { sessionId, data }),
  telnetDisconnect: (sessionId) => ipcRenderer.invoke('telnet:disconnect', { sessionId }),
  telnetHistory: () => ipcRenderer.invoke('telnet:history'),
  telnetClearHistory: () => ipcRenderer.invoke('telnet:clearHistory'),
  onTelnetLine: (callback) => subscribe('telnet:line', callback),
  onTelnetClosed: (callback) => subscribe('telnet:closed', callback),

  // monitoring activity
  getActivity: () => ipcRenderer.invoke('monitor:activity'),
  checkAll: () => ipcRenderer.invoke('monitor:checkAll'),

  // import / export
  exportData: (kind) => ipcRenderer.invoke('transfer:export', kind),
  importHosts: () => ipcRenderer.invoke('transfer:import'),

  // support
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
  logError: (message) => ipcRenderer.invoke('log:renderer', String(message)),
  setTitleBarTheme: (colors) => ipcRenderer.invoke('app:setTitleBarTheme', colors),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // backup (local, stored in the portable appdata folder)
  backupStatus: () => ipcRenderer.invoke('backup:status'),
  backupUpdateSettings: (patch) => ipcRenderer.invoke('backup:updateSettings', patch),
  backupSetPassphrase: (passphrase) => ipcRenderer.invoke('backup:setPassphrase', passphrase),
  backupRunLocal: () => ipcRenderer.invoke('backup:runLocal'),
  backupRestore: (source, name) => ipcRenderer.invoke('backup:restore', { source, name }),
  backupOpenFolder: () => ipcRenderer.invoke('backup:openFolder'),

  // telemetry (opt-in)
  telemetryStatus: () => ipcRenderer.invoke('telemetry:status'),
  telemetryUpdate: (patch) => ipcRenderer.invoke('telemetry:update', patch),

  // live updates
  onMonitorResult: (callback) => subscribe('monitor:result', callback),
  onActivity: (callback) => subscribe('monitor:activity', callback),
  onHostsChanged: (callback) => subscribe('hosts:changed', callback),
  onTransferProgress: (callback) => subscribe('transfer:progress', callback),
  onBackupProgress: (callback) => subscribe('backup:progress', callback),
  onBackupChanged: (callback) => subscribe('backup:changed', callback),
  onAlert: (callback) => subscribe('alerts:new', callback),
  onDomainsChanged: (callback) => subscribe('domains:changed', callback),
  onConfigReloaded: (callback) => subscribe('config:reloaded', callback),
});

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
