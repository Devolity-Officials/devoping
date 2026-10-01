// Portable, file-based SQLite database using sql.js (WebAssembly SQLite - no native
// compilation required, so it works reliably across machines/Electron versions).
// Stores time-series monitoring results ("checks"). The DB lives in memory; changes are
// flushed to disk atomically in batches (at most FLUSH_DELAY_MS after a write) and on exit.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { getDbPath } = require('./paths');
const { writeFileAtomic, quarantine } = require('./fsutil');
const log = require('./logger');

const FLUSH_DELAY_MS = 2000;

let SQL = null;
let db = null;
let dbPath = null;
let flushTimer = null;
let dirty = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id TEXT NOT NULL,
  host_name TEXT,
  target TEXT,
  check_type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  is_up INTEGER NOT NULL,
  latency_ms REAL,
  http_status INTEGER,
  resolved_ip TEXT,
  ssl_valid INTEGER,
  ssl_issuer TEXT,
  ssl_valid_from TEXT,
  ssl_valid_to TEXT,
  ssl_days_remaining INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_host_ts ON checks(host_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(timestamp);
`;

// Columns added after the first release; older databases are upgraded in place.
const ADDED_COLUMNS = { port: 'INTEGER', detail: 'TEXT' };

function migrate(database) {
  database.run(SCHEMA);
  const [info] = database.exec('PRAGMA table_info(checks)');
  const existing = new Set(info ? info.values.map((v) => v[1]) : []);
  for (const [name, type] of Object.entries(ADDED_COLUMNS)) {
    if (!existing.has(name)) database.run(`ALTER TABLE checks ADD COLUMN ${name} ${type}`);
  }
}

function openExisting(buffer) {
  const candidate = new SQL.Database(buffer);
  const [result] = candidate.exec('PRAGMA quick_check');
  const status = result && result.values[0] && result.values[0][0];
  if (status !== 'ok') {
    candidate.close();
    throw new Error(`integrity check failed: ${status}`);
  }
  return candidate;
}

async function initDb() {
  if (db) return db;
  const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
  SQL = await initSqlJs({
    locateFile: (file) => path.join(wasmDir, file),
  });
  dbPath = getDbPath();
  if (fs.existsSync(dbPath)) {
    try {
      db = openExisting(fs.readFileSync(dbPath));
    } catch (err) {
      // History is non-critical: keep the damaged file for diagnosis and start a fresh DB.
      log.error(`Monitoring database is damaged (${err.message}); moved to ${quarantine(dbPath)}`);
      db = null;
    }
  }
  if (!db) db = new SQL.Database();
  migrate(db);
  flush();
  return db;
}

function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!db) return;
  try {
    writeFileAtomic(dbPath, Buffer.from(db.export()));
    dirty = false;
  } catch (err) {
    log.error(`Failed to save monitoring database: ${err.message}`);
    schedulePersist();
  }
}

function schedulePersist() {
  dirty = true;
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

function close() {
  if (dirty) flush();
}

function exportBuffer() {
  return Buffer.from(db.export());
}

// Swaps in a database from a backup after validating it; the old one is discarded.
function replaceFrom(buffer) {
  const next = openExisting(buffer);
  migrate(next);
  db.close();
  db = next;
  flush();
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  schedulePersist();
}

function insertCheck(row) {
  const values = {
    host_id: row.hostId,
    host_name: row.hostName || null,
    target: row.target || null,
    check_type: row.checkType,
    timestamp: row.timestamp,
    is_up: row.isUp ? 1 : 0,
    latency_ms: row.latencyMs ?? null,
    http_status: row.httpStatus ?? null,
    resolved_ip: row.resolvedIp ?? null,
    ssl_valid: row.ssl ? (row.ssl.valid ? 1 : 0) : null,
    ssl_issuer: row.ssl ? row.ssl.issuer ?? null : null,
    ssl_valid_from: row.ssl ? row.ssl.validFrom ?? null : null,
    ssl_valid_to: row.ssl ? row.ssl.validTo ?? null : null,
    ssl_days_remaining: row.ssl ? row.ssl.daysRemaining ?? null : null,
    port: row.port ?? null,
    detail: row.detail || null,
    error: row.error || null,
  };
  const columns = Object.keys(values);
  run(
    `INSERT INTO checks (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    Object.values(values)
  );
  // Same shape as rows read back from the table (what the renderer consumes).
  return values;
}

function getRecentChecks(hostId, limit = 100) {
  return queryAll(
    `SELECT * FROM checks WHERE host_id = ? ORDER BY timestamp DESC LIMIT ?`,
    [hostId, limit]
  );
}

function getChecksSince(hostId, sinceTs) {
  return queryAll(
    `SELECT * FROM checks WHERE host_id = ? AND timestamp >= ? ORDER BY timestamp ASC`,
    [hostId, sinceTs]
  );
}

function getAllChecksSince(sinceTs, limit = 5000) {
  return queryAll(
    `SELECT * FROM checks WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?`,
    [sinceTs, limit]
  );
}

// Newest row per host and check type (and per port for TCP checks; `IS` matches NULL ports).
function getLatestCheckPerHost() {
  return queryAll(`
    SELECT c.* FROM checks c
    INNER JOIN (
      SELECT host_id, check_type, port, MAX(timestamp) AS max_ts
      FROM checks GROUP BY host_id, check_type, port
    ) latest ON c.host_id = latest.host_id
      AND c.check_type = latest.check_type
      AND c.port IS latest.port
      AND c.timestamp = latest.max_ts
  `);
}

function getUptimeSummary(hostId, sinceTs) {
  const rows = queryAll(
    `SELECT check_type, port,
            COUNT(*) AS total,
            SUM(is_up) AS up_count,
            AVG(latency_ms) AS avg_latency
     FROM checks WHERE host_id = ? AND timestamp >= ?
     GROUP BY check_type, port
     ORDER BY check_type, port`,
    [hostId, sinceTs]
  );
  return rows;
}

function pruneOlderThan(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  db.run(`DELETE FROM checks WHERE timestamp < ?`, [cutoff]);
  const removed = db.getRowsModified();
  // Reclaim freed pages so the exported file (and every flush) doesn't keep growing.
  if (removed > 0) db.run('VACUUM');
  schedulePersist();
  return removed;
}

function deleteChecksForHost(hostId) {
  run(`DELETE FROM checks WHERE host_id = ?`, [hostId]);
}

module.exports = {
  initDb,
  flush,
  close,
  exportBuffer,
  replaceFrom,
  insertCheck,
  getRecentChecks,
  getChecksSince,
  getAllChecksSince,
  getLatestCheckPerHost,
  getUptimeSummary,
  pruneOlderThan,
  deleteChecksForHost,
};
