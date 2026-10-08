// Builds shareable summary reports (HTML / CSV) from monitored hosts and their check history.
// PDF is produced by the main process by printing the HTML (see ipc.js).
const config = require('./config');
const db = require('./db');

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function clampDays(days) {
  return Math.min(Math.max(Number(days) || 7, 1), 365);
}

function fmtMs(v) {
  return v == null ? '-' : `${Math.round(v)} ms`;
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString() : '-';
}

function checkLabel(row) {
  if (row.check_type === 'tcp') return `TCP ${row.port}`;
  return String(row.check_type || '').toUpperCase();
}

// Collects per-host status, uptime summary and latency history for the report.
function collect(scope, days) {
  const since = Date.now() - clampDays(days) * 86400000;
  const hosts = scope === 'all' ? config.getHosts() : [config.getHost(scope)].filter(Boolean);
  const latest = db.getLatestCheckPerHost();
  const latestByHost = new Map();
  for (const r of latest) {
    if (!latestByHost.has(r.host_id)) latestByHost.set(r.host_id, []);
    latestByHost.get(r.host_id).push(r);
  }
  return hosts.map((host) => ({
    host,
    summary: db.getUptimeSummary(host.id, since),
    latest: (latestByHost.get(host.id) || []).sort((a, b) => a.check_type.localeCompare(b.check_type) || (a.port || 0) - (b.port || 0)),
    history: db.getChecksSince(host.id, since),
  }));
}

function overall(data) {
  let up = 0;
  let down = 0;
  for (const d of data) {
    const anyDown = d.latest.some((r) => !r.is_up);
    const anyUp = d.latest.some((r) => r.is_up);
    if (anyDown) down++;
    else if (anyUp) up++;
  }
  return { hosts: data.length, up, down, unknown: data.length - up - down };
}

function sparkline(history, predicate, color) {
  const pts = history.filter((r) => predicate(r) && r.latency_ms != null).map((r) => ({ x: r.timestamp, y: r.latency_ms }));
  if (pts.length < 2) return '';
  const w = 640;
  const h = 70;
  const pad = 4;
  const xs = pts.map((p) => p.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...pts.map((p) => p.y), 1);
  const sx = (x) => pad + ((x - minX) / (maxX - minX || 1)) * (w - 2 * pad);
  const sy = (y) => h - pad - (y / maxY) * (h - 2 * pad);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  return `<svg class="spark" width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`
    + `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
}

function statusCell(row) {
  const cls = row.is_up ? 'up' : 'down';
  let text = row.is_up ? 'Up' : 'Down';
  if ((row.check_type === 'http' || row.check_type === 'https') && row.http_status) text += ` (${row.http_status})`;
  if (row.check_type === 'tcp') text = row.is_up ? 'Open' : 'Closed';
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function hostSection(d, days) {
  const h = d.host;
  const uptime = d.summary.map((s) => {
    const pct = s.total ? ((s.up_count / s.total) * 100).toFixed(1) : '0.0';
    return `<tr><td>${esc(checkLabel(s))}</td><td>${pct}%</td><td>${s.up_count || 0}/${s.total || 0}</td><td>${fmtMs(s.avg_latency)}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="muted">No checks recorded in this period.</td></tr>';

  const latest = d.latest.map((r) => `<tr>
    <td>${esc(checkLabel(r))}</td>
    <td class="mono">${esc(r.target || '-')}</td>
    <td>${statusCell(r)}</td>
    <td>${fmtMs(r.latency_ms)}</td>
    <td class="mono small">${esc(r.detail || r.error || '')}</td>
    <td>${esc(fmtTime(r.timestamp))}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No results yet.</td></tr>';

  const ssl = d.latest.find((r) => r.ssl_valid_to);
  const sslLine = ssl
    ? `<p class="small">TLS certificate: ${esc(ssl.ssl_issuer || 'Unknown')} &middot; expires ${esc(fmtTime(Date.parse(ssl.ssl_valid_to)))} (${ssl.ssl_days_remaining} days left)</p>`
    : '';

  const httpSpark = sparkline(d.history, (r) => r.check_type === 'http' || r.check_type === 'https', '#2563eb');
  const pingSpark = sparkline(d.history, (r) => r.check_type === 'ping', '#16a34a');

  return `<section class="host">
    <h2>${esc(h.name)}</h2>
    <p class="small">${esc(h.url || '')} ${h.ip ? `&middot; ${esc(h.ip)}` : ''} &middot; every ${esc(h.intervalMinutes)} min &middot; ${h.enabled ? 'enabled' : 'paused'}</p>
    ${sslLine}
    <h3>Uptime (${days} days)</h3>
    <table><thead><tr><th>Check</th><th>Uptime</th><th>Up/Total</th><th>Avg latency</th></tr></thead><tbody>${uptime}</tbody></table>
    <h3>Latest results</h3>
    <table><thead><tr><th>Check</th><th>Target</th><th>Status</th><th>Latency</th><th>Detail</th><th>Checked</th></tr></thead><tbody>${latest}</tbody></table>
    ${httpSpark ? `<h3>HTTP latency</h3>${httpSpark}` : ''}
    ${pingSpark ? `<h3>Ping latency</h3>${pingSpark}` : ''}
  </section>`;
}

function toHtml({ scope = 'all', days = 7 } = {}) {
  const data = collect(scope, days);
  const ov = overall(data);
  const title = scope === 'all' ? 'Devoping monitoring report' : `Devoping report - ${data[0] ? data[0].host.name : 'host'}`;
  const sections = data.map((d) => hostSection(d, clampDays(days))).join('') || '<p class="muted">No hosts to report.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; color: #0f172a; margin: 32px; background: #fff; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 24px 0 2px; }
  h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; margin: 16px 0 6px; }
  .meta { color: #64748b; font-size: 12px; margin-bottom: 16px; }
  .cards { display: flex; gap: 12px; margin: 12px 0 8px; flex-wrap: wrap; }
  .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 16px; min-width: 110px; }
  .card .n { font-size: 22px; font-weight: 700; }
  .card .l { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eef2f7; vertical-align: top; }
  th { color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
  .mono { font-family: ui-monospace, Consolas, monospace; }
  .small { font-size: 12px; color: #475569; }
  .muted { color: #94a3b8; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge.up { background: #dcfce7; color: #166534; }
  .badge.down { background: #fee2e2; color: #991b1b; }
  .spark { display: block; border: 1px solid #eef2f7; border-radius: 6px; background: #f8fafc; margin-bottom: 8px; }
  section.host { page-break-inside: avoid; border-top: 2px solid #e2e8f0; padding-top: 8px; margin-top: 20px; }
</style></head>
<body>
  <h1>${esc(title)}</h1>
  <div class="meta">Generated ${esc(new Date().toLocaleString())} &middot; period: last ${clampDays(days)} days</div>
  <div class="cards">
    <div class="card"><div class="n">${ov.hosts}</div><div class="l">Hosts</div></div>
    <div class="card"><div class="n">${ov.up}</div><div class="l">Up</div></div>
    <div class="card"><div class="n">${ov.down}</div><div class="l">Down</div></div>
    <div class="card"><div class="n">${ov.unknown}</div><div class="l">Unknown</div></div>
  </div>
  ${sections}
</body></html>`;
}

function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv({ scope = 'all', days = 7 } = {}) {
  const data = collect(scope, days);
  const fields = ['host', 'url', 'ip', 'check', 'uptime_pct', 'up', 'total', 'avg_latency_ms', 'last_status', 'last_checked'];
  const rows = [];
  for (const d of data) {
    const h = d.host;
    const latestByKey = new Map();
    for (const r of d.latest) latestByKey.set(`${r.check_type}:${r.port ?? ''}`, r);
    if (!d.summary.length) {
      rows.push([h.name, h.url, h.ip, '', '', '', '', '', '', '']);
      continue;
    }
    for (const s of d.summary) {
      const pct = s.total ? ((s.up_count / s.total) * 100).toFixed(1) : '0.0';
      const last = latestByKey.get(`${s.check_type}:${s.port ?? ''}`);
      rows.push([
        h.name, h.url, h.ip, checkLabel(s), pct, s.up_count || 0, s.total || 0,
        s.avg_latency == null ? '' : Math.round(s.avg_latency),
        last ? (last.is_up ? 'up' : 'down') : '',
        last ? new Date(last.timestamp).toISOString() : '',
      ]);
    }
  }
  const lines = [fields.join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = { toHtml, toCsv };
