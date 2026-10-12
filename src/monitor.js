// Schedules recurring checks for every configured host, runs them through a bounded queue,
// persists/broadcasts results, and publishes live progress ("activity") to the renderer.
const { URL } = require('url');
const config = require('./config');
const db = require('./db');
const { checkHttp, checkPing, checkTcp, resolveHostIp } = require('./checks');
const log = require('./logger');
const telemetry = require('./telemetry');
const alerts = require('./alerts');

const MAX_CONCURRENT = 8;
const ACTIVITY_THROTTLE_MS = 120;
const JOB_TIMEOUT_MS = 90 * 1000;
// Tried when ICMP gets no reply and the host has no pingPort of its own.
const PING_FALLBACK_PORTS = [443, 80];

const timers = new Map(); // hostId -> { intervalId, intervalMs, nextRunAt }
const queue = []; // hostIds waiting to run
const running = new Map(); // hostId -> { name, stage, startedAt }
const waiters = new Map(); // hostId -> [resolve] for callers awaiting a specific check
let cycle = null; // { total, done, startedAt } while any work is queued/running
let lastSyncAt = null;
let broadcastFn = () => {};
let activityTimer = null;

function setBroadcaster(fn) {
  broadcastFn = fn;
}

function getActivity() {
  const nextRuns = {};
  for (const [hostId, t] of timers) nextRuns[hostId] = t.nextRunAt;
  return {
    running: [...running].map(([hostId, r]) => ({ hostId, ...r })),
    queued: [...queue],
    cycle: cycle ? { ...cycle } : null,
    lastSyncAt,
    nextRuns,
    maxConcurrent: MAX_CONCURRENT,
  };
}

function emitActivity() {
  if (activityTimer) return;
  activityTimer = setTimeout(() => {
    activityTimer = null;
    broadcastFn('monitor:activity', getActivity());
  }, ACTIVITY_THROTTLE_MS);
}

function setStage(hostId, stage) {
  const r = running.get(hostId);
  if (r) {
    r.stage = stage;
    emitActivity();
  }
}

async function runHostChecks(host) {
  const results = [];
  let hostname = null;

  if (host.url) {
    try {
      hostname = new URL(host.url).hostname.replace(/^\[|\]$/g, '');
    } catch {
      // invalid URL - checkHttp reports it
    }
    setStage(host.id, 'dns');
    const ipLookup = hostname ? await resolveHostIp(hostname) : null;
    setStage(host.id, 'http');
    const res = await checkHttp(host.url, {
      method: host.method,
      headers: host.headers,
      body: host.body,
      expectStatus: host.expectStatus,
      bodyMatch: host.bodyMatch,
      followRedirects: host.followRedirects !== false,
    });
    const row = {
      hostId: host.id,
      hostName: host.name,
      target: host.url,
      checkType: host.url.startsWith('https') ? 'https' : 'http',
      timestamp: Date.now(),
      isUp: res.ok,
      latencyMs: res.latencyMs ?? null,
      httpStatus: res.statusCode ?? null,
      resolvedIp: ipLookup,
      ssl: res.ssl || null,
      error: res.error || null,
    };
    results.push(db.insertCheck(row));

    if (host.ipAuto && ipLookup && ipLookup !== host.ip) {
      host = config.updateHost(host.id, { ip: ipLookup, ipAuto: true });
      broadcastFn('hosts:changed', { hostId: host.id });
    }
  }

  if (host.ip) {
    setStage(host.id, 'ping');
    let res = await checkPing(host.ip);
    let detail = null;
    if (!res.ok) {
      // Many servers drop ICMP; a completed TCP handshake still proves the host is reachable.
      const fallbackPorts = host.pingPort ? [host.pingPort] : PING_FALLBACK_PORTS;
      const tcp = await Promise.all(fallbackPorts.map((port) => checkTcp(host.ip, port)));
      const idx = tcp.findIndex((t) => t.ok);
      if (idx >= 0) {
        res = { ok: true, latencyMs: tcp[idx].latencyMs };
        detail = `TCP ${fallbackPorts[idx]}`;
      } else {
        res = { ...res, error: `${res.error || 'No ICMP reply'}; TCP ${fallbackPorts.join('/')} not reachable` };
      }
    }
    const row = {
      hostId: host.id,
      hostName: host.name,
      target: host.ip,
      checkType: 'ping',
      timestamp: Date.now(),
      isUp: res.ok,
      latencyMs: res.latencyMs ?? null,
      httpStatus: null,
      resolvedIp: host.ip,
      ssl: null,
      detail,
      error: res.error || null,
    };
    results.push(db.insertCheck(row));
  }

  // Custom TCP ports: checked against the IP (auto or manual), else the URL's hostname.
  const ports = Array.isArray(host.ports) ? host.ports : [];
  const tcpTarget = host.ip || hostname;
  if (ports.length && tcpTarget) {
    setStage(host.id, 'ports');
    const outcomes = await Promise.all(ports.map((p) => checkTcp(tcpTarget, p.port)));
    ports.forEach((p, i) => {
      const res = outcomes[i];
      results.push(db.insertCheck({
        hostId: host.id,
        hostName: host.name,
        target: `${tcpTarget}:${p.port}`,
        checkType: 'tcp',
        port: p.port,
        timestamp: Date.now(),
        isUp: res.ok,
        latencyMs: res.latencyMs ?? null,
        resolvedIp: host.ip || null,
        detail: res.banner || null,
        error: res.error || null,
      }));
    });
  }

  results.forEach((row) => {
    broadcastFn('monitor:result', row);
    telemetry.count(`check_${row.check_type}_${row.is_up ? 'ok' : 'fail'}`);
  });
  if (config.getHost(host.id)) alerts.recordHostResults(host, results);
  return results;
}

function settle(hostId, results) {
  const list = waiters.get(hostId);
  if (list) {
    waiters.delete(hostId);
    list.forEach((resolve) => resolve(results));
  }
}

function pump() {
  while (running.size < MAX_CONCURRENT && queue.length) {
    const hostId = queue.shift();
    const host = config.getHost(hostId);
    if (!host) {
      if (cycle) cycle.done++;
      settle(hostId, []);
      continue;
    }
    running.set(hostId, { name: host.name, stage: 'starting', startedAt: Date.now() });
    let watchdog;
    // A hung check must not hold a concurrency slot forever.
    Promise.race([
      runHostChecks(host),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error(`timed out after ${JOB_TIMEOUT_MS / 1000}s`)), JOB_TIMEOUT_MS);
      }),
    ])
      .catch((err) => {
        log.error(`Check failed for ${host.name}: ${err.stack || err.message}`);
        return [];
      })
      .then((results) => {
        clearTimeout(watchdog);
        running.delete(hostId);
        lastSyncAt = Date.now();
        if (cycle) cycle.done++;
        settle(hostId, results);
        if (!running.size && !queue.length) cycle = null;
        emitActivity();
        pump();
      });
  }
  emitActivity();
}

// Queues a check; a host that is already queued or running is not queued twice.
function enqueue(hostId) {
  const promise = new Promise((resolve) => {
    if (!waiters.has(hostId)) waiters.set(hostId, []);
    waiters.get(hostId).push(resolve);
  });
  if (!running.has(hostId) && !queue.includes(hostId)) {
    if (!cycle) cycle = { total: 0, done: 0, startedAt: Date.now() };
    cycle.total++;
    queue.push(hostId);
    pump();
  }
  return promise;
}

function clearHostTimers(hostId) {
  const existing = timers.get(hostId);
  if (existing) {
    clearInterval(existing.intervalId);
    timers.delete(hostId);
  }
  const idx = queue.indexOf(hostId);
  if (idx !== -1) {
    queue.splice(idx, 1);
    if (cycle) cycle.total--;
    if (cycle && !running.size && !queue.length) cycle = null;
    settle(hostId, []);
  }
}

function scheduleHost(host) {
  clearHostTimers(host.id);
  if (!host.enabled) {
    emitActivity();
    return;
  }
  const intervalMs = Math.max(1, Number(host.intervalMinutes) || 5) * 60 * 1000;
  const entry = { intervalMs, nextRunAt: Date.now() + intervalMs };
  entry.intervalId = setInterval(() => {
    entry.nextRunAt = Date.now() + intervalMs;
    const latest = config.getHost(host.id);
    if (latest && latest.enabled) enqueue(host.id);
  }, intervalMs);
  timers.set(host.id, entry);
  // Run once immediately, then on the configured interval.
  enqueue(host.id);
}

function reschedule(hostId) {
  const host = config.getHost(hostId);
  if (host) scheduleHost(host);
  else clearHostTimers(hostId);
}

function startAll() {
  config.getHosts().forEach(scheduleHost);
}

function stopAll() {
  for (const hostId of [...timers.keys()]) clearHostTimers(hostId);
  queue.splice(0).forEach((hostId) => settle(hostId, []));
  if (!running.size) cycle = null;
  emitActivity();
}

function checkAll() {
  const hosts = config.getHosts().filter((h) => h.enabled);
  hosts.forEach((h) => enqueue(h.id));
  return hosts.length;
}

function isActive() {
  return timers.size > 0;
}

let retentionTimer = null;
function startRetentionJob() {
  const runPrune = () => {
    try {
      const { retentionDays } = config.getSettings();
      const removed = db.pruneOlderThan(Math.max(1, Number(retentionDays) || 7));
      if (removed) log.info(`Retention: pruned ${removed} check results`);
    } catch (err) {
      log.error(`Retention prune failed: ${err.message}`);
    }
  };
  runPrune();
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = setInterval(runPrune, 6 * 60 * 60 * 1000); // every 6 hours
}

async function runCheckNow(hostId) {
  if (!config.getHost(hostId)) throw new Error('Host not found');
  return enqueue(hostId);
}

module.exports = {
  setBroadcaster,
  startAll,
  stopAll,
  reschedule,
  startRetentionJob,
  runCheckNow,
  checkAll,
  isActive,
  getActivity,
};
