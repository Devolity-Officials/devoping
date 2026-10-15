// Windows desktop notifications for alerts.
// New alerts are batched briefly so a burst (e.g. the network dropping) becomes one notification.
// Ongoing problems are re-announced only after a quiet period: settings.notifyRepeatMinutes for
// hosts that stay down, once a day for SSL/domain expiry warnings.
const path = require('path');
const { Notification, nativeImage } = require('electron');
const config = require('./config');
const log = require('./logger');

const BATCH_MS = 3000;
const MAX_BODY = 250;
const MAX_LINES = 4;
const EXPIRY_REPEAT_MS = 24 * 60 * 60 * 1000;
const ICON_PATH = path.join(__dirname, '..', 'renderer', 'img', 'icon.png');
let icon = null;

let getWindow = () => null;
let pending = [];
let batchTimer = null;
const lastShown = new Map(); // problem key -> time it was last notified
const live = new Set(); // keeps notifications referenced so their click handlers stay alive

function init(getMainWindow) {
  getWindow = getMainWindow;
}

function enabled() {
  return config.getSettings().notifyEnabled !== false && Notification.isSupported();
}

function repeatMs() {
  return (Number(config.getSettings().notifyRepeatMinutes) || 60) * 60 * 1000;
}

function focusWindow() {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function display({ title, body, urgent }) {
  if (!icon) icon = nativeImage.createFromPath(ICON_PATH);
  const n = new Notification({
    title: title.slice(0, 100),
    body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 1)}…` : body,
    icon,
    urgency: urgent ? 'critical' : 'normal',
  });
  live.add(n);
  const release = () => live.delete(n);
  n.on('click', () => {
    release();
    focusWindow();
  });
  n.on('close', release);
  n.on('failed', (_e, error) => {
    release();
    log.warn(`Desktop notification failed: ${error}`);
  });
  n.show();
}

function flushBatch() {
  batchTimer = null;
  const items = pending.splice(0);
  if (!items.length || !enabled()) return;
  const urgent = items.some((i) => i.severity === 'danger');
  if (items.length === 1) {
    display({ title: items[0].title, body: items[0].message || '', urgent });
    return;
  }
  const lines = items.slice(0, MAX_LINES).map((i) => i.title);
  if (items.length > MAX_LINES) lines.push(`+${items.length - MAX_LINES} more`);
  display({ title: `Devoping: ${items.length} alerts`, body: lines.join('\n'), urgent });
}

function enqueue(item) {
  if (!enabled()) return;
  pending.push(item);
  if (!batchTimer) batchTimer = setTimeout(flushBatch, BATCH_MS);
}

// A new alert. `key` identifies the underlying problem so reminders wait a full interval after it.
function show(alert, key = null) {
  if (key) lastShown.set(key, Date.now());
  enqueue(alert);
}

// Called on every check while a problem persists; notifies only if the last notice is old enough.
function remind(key, item, intervalMs = repeatMs()) {
  const last = lastShown.get(key) || 0;
  if (Date.now() - last < intervalMs) return;
  lastShown.set(key, Date.now());
  enqueue(item);
}

function resolve(key) {
  lastShown.delete(key);
}

function test() {
  if (!Notification.isSupported()) throw new Error('Desktop notifications are not supported on this system');
  display({ title: 'Devoping notifications are working', body: 'Alerts and warnings will appear like this.', urgent: false });
  return true;
}

module.exports = { init, show, remind, resolve, test, EXPIRY_REPEAT_MS };
