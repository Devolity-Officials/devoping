// Interactive telnet-style TCP console. Opens raw sockets to a host/port, streams data to the
// renderer, and appends every line to a persistent history log in the portable devoping_data folder.
const net = require('net');
const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./paths');
const log = require('./logger');

const MAX_SESSIONS = 8;
const CONNECT_TIMEOUT_MS = 10000;
const MAX_SEND_BYTES = 8 * 1024;
const HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const HISTORY_TRIM_TO = Math.floor(1.5 * 1024 * 1024);
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;

let broadcast = () => {};
const sessions = new Map(); // id -> { socket, target, port }
let counter = 0;

function init(options = {}) {
  broadcast = options.broadcast || broadcast;
}

function historyPath() {
  return path.join(getDataDir(), 'telnet-history.log');
}

function appendHistory(line) {
  try {
    fs.appendFileSync(historyPath(), `${line}\n`);
    const { size } = fs.statSync(historyPath());
    if (size > HISTORY_MAX_BYTES) {
      const buf = fs.readFileSync(historyPath());
      fs.writeFileSync(historyPath(), buf.subarray(buf.length - HISTORY_TRIM_TO));
    }
  } catch (err) {
    log.warn(`Telnet history write failed: ${err.message}`);
  }
}

// One formatted line, stored to the log file and streamed to the renderer identically.
function record(sessionId, type, text) {
  const line = `[${new Date().toISOString()}] [${type}] ${text}`;
  appendHistory(line);
  broadcast('telnet:line', { sessionId, type, line });
}

function validTarget(t) {
  return net.isIP(t) !== 0 || HOSTNAME_RE.test(t);
}

function connect(rawTarget, rawPort) {
  let target = String(rawTarget || '').trim();
  if (!target) throw new Error('Enter an IP address, hostname or URL');
  if (/^[a-z]+:\/\//i.test(target)) {
    try {
      target = new URL(target).hostname.replace(/^\[|\]$/g, '');
    } catch {
      throw new Error('Invalid URL');
    }
  }
  if (!validTarget(target)) throw new Error(`Invalid target "${target}"`);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  if (sessions.size >= MAX_SESSIONS) throw new Error(`Too many open telnet sessions (max ${MAX_SESSIONS})`);

  const id = `t${++counter}`;
  const startedAt = Date.now();
  const socket = net.connect({ host: target, port });
  socket.setTimeout(CONNECT_TIMEOUT_MS);
  sessions.set(id, { socket, target, port });
  record(id, 'status', `Connecting to ${target}:${port} …`);

  socket.on('connect', () => {
    socket.setTimeout(0);
    record(id, 'status', `Connected to ${target}:${port} (${Date.now() - startedAt} ms)`);
  });
  socket.on('data', (chunk) => {
    const text = chunk.toString('utf8').replace(/\r/g, '').replace(/\n+$/, '');
    if (text) record(id, 'recv', text);
  });
  socket.on('timeout', () => {
    record(id, 'error', 'Connection timed out');
    socket.destroy();
  });
  socket.on('error', (err) => record(id, 'error', err.message));
  socket.on('close', () => {
    record(id, 'status', `Disconnected from ${target}:${port}`);
    sessions.delete(id);
    broadcast('telnet:closed', { sessionId: id });
  });

  return { sessionId: id, target, port };
}

function send(sessionId, data) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Session is not connected');
  const text = String(data == null ? '' : data);
  if (Buffer.byteLength(text) > MAX_SEND_BYTES) throw new Error('Line is too long');
  s.socket.write(`${text}\r\n`);
  record(sessionId, 'sent', text);
  return true;
}

function disconnect(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.socket.destroy();
  return true;
}

function stopAll() {
  for (const { socket } of sessions.values()) {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }
  sessions.clear();
}

function readHistory() {
  try {
    return fs.readFileSync(historyPath(), 'utf8');
  } catch {
    return '';
  }
}

function clearHistory() {
  try {
    fs.writeFileSync(historyPath(), '');
  } catch (err) {
    throw new Error(`Could not clear telnet history: ${err.message}`);
  }
  return true;
}

module.exports = { init, connect, send, disconnect, stopAll, readHistory, clearHistory };
