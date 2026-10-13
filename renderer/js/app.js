(() => {
  const STAGE_LABELS = { starting: 'Starting', dns: 'DNS', http: 'HTTP', ping: 'Ping', ports: 'Ports' };
  const PAGE_META = {
    dashboard: ['Dashboard', 'Live status of every monitored host'],
    hosts: ['Host / URLs', 'Add, edit, import and export monitored targets'],
    telnet: ['Telnet', 'Telnet-style TCP console with persistent history logs'],
    domains: ['Domain WHOIS', 'WHOIS / RDAP lookups and domain expiry tracking'],
    backup: ['Backup', 'Automatic local backups in the portable devoping_data folder'],
    settings: ['Settings', 'Profile, monitoring, global DNS, data and account preferences'],
  };
  const TELNET_MAX_CHARS = 200000;
  const PROFILE_INPUTS = {
    'profile-display-name': 'displayName',
    'profile-email': 'email',
    'profile-phone': 'phone',
    'profile-job-title': 'jobTitle',
    'profile-organization': 'organization',
    'profile-department': 'department',
    'profile-location': 'location',
  };

  const state = {
    hosts: [],
    hostsById: new Map(),
    latestByHost: new Map(), // hostId -> { http|https|ping|tcp:<port>: row }
    settings: null,
    activity: null,
    editingHostId: null,
    detailHostId: null,
    telnetSessionId: null,
    telnetLoaded: false,
    detailChart: null,
    uiWired: false,
    unsubscribers: [],
    search: '',
    statusFilter: 'all',
    renderQueued: false,
    profile: null,
    alerts: [],
    alertsHtml: '',
    pendingAlerts: [],
    alertToastTimer: null,
    domains: [],
    whoisLast: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));
  const icon = (name, cls = 'icon') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;

  // Unexpected UI errors go to devoping_data/logs/devoping.log (capped to avoid log floods).
  let reportedErrors = 0;
  function reportError(message) {
    if (reportedErrors++ < 20) window.api.logError(message).catch(() => {});
  }
  window.addEventListener('error', (e) => reportError(`${e.message} at ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => reportError(`Unhandled rejection: ${(e.reason && e.reason.stack) || e.reason}`));

  function show(id) {
    ['view-loading', 'view-setup', 'view-login', 'view-app'].forEach((v) => {
      $(`#${v}`).classList.toggle('hidden', v !== id);
    });
    // The page breadcrumb is only meaningful inside the app; sign-in/setup show just the app name.
    const inApp = id === 'view-app';
    $('.titlebar-sep').classList.toggle('hidden', !inApp);
    $('#titlebar-page').classList.toggle('hidden', !inApp);
    $('#titlebar-status').classList.toggle('hidden', !inApp);
  }

  window.addEventListener('blur', () => document.documentElement.classList.add('window-inactive'));
  window.addEventListener('focus', () => document.documentElement.classList.remove('window-inactive'));

  // ipcRenderer.invoke wraps main-process errors as "Error invoking remote method '<ch>': Error: <msg>".
  function errMsg(err) {
    return (err.message || String(err)).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtTime(ts) {
    return ts ? new Date(ts).toLocaleString() : '-';
  }

  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  }

  function fmtAgo(ts) {
    if (!ts) return 'Never';
    const diff = Date.now() - ts;
    return diff < 60000 ? 'just now' : `${fmtDuration(diff)} ago`;
  }

  function fmtUntil(ts) {
    const diff = ts - Date.now();
    return diff < 60000 ? '<1m' : fmtDuration(diff);
  }

  // Replaces only rows whose markup changed, so live updates don't swallow clicks on unchanged rows.
  function patchRows(tbody, rows) {
    const current = Array.from(tbody.children);
    const sameShape = current.length === rows.length && current.every((tr, i) => tr.dataset.host === rows[i].key);
    if (!sameShape) {
      tbody.innerHTML = rows.map((r) => r.html).join('');
      Array.from(tbody.children).forEach((tr, i) => { tr._html = rows[i].html; });
      return;
    }
    rows.forEach((r, i) => {
      if (current[i]._html === r.html) return;
      const tmp = document.createElement('tbody');
      tmp.innerHTML = r.html;
      const tr = tmp.firstElementChild;
      tr._html = r.html;
      current[i].replaceWith(tr);
    });
  }

  function fmtLatency(ms) {
    return ms === null || ms === undefined ? '' : `${Math.round(ms)} ms`;
  }

  function toast(message, type = 'info', ms = 4500) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `${icon(type === 'error' ? 'down' : type === 'success' ? 'check' : 'activity')}<div>${escapeHtml(message)}</div>`;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  // ---------------- THEME ----------------
  function rgbToHex(rgb) {
    const [r, g, b] = (rgb.match(/\d+/g) || [0, 0, 0]).map(Number);
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }

  // `persist` saves the choice in config.json so it is part of backups.
  function applyTheme(theme, persist = true) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('devoping-theme', theme);
    if (persist && state.settings && state.settings.theme !== theme) {
      window.api.updateSettings({ theme }).then((s) => { state.settings = s; }).catch(() => {});
    }
    $('#theme-icon').setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
    $all('#theme-select button').forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
    const bar = getComputedStyle($('#titlebar'));
    window.api.setTitleBarTheme({
      color: rgbToHex(bar.backgroundColor),
      symbolColor: rgbToHex(bar.color),
      background: rgbToHex(getComputedStyle(document.body).backgroundColor),
    }).catch(() => {});
  }

  // ---------------- BOOTSTRAP / AUTH ----------------
  async function bootstrap() {
    applyTheme(document.documentElement.dataset.theme || 'dark', false);
    show('view-loading');
    const needsSetup = await window.api.needsSetup();
    if (needsSetup) {
      show('view-setup');
      return;
    }
    const user = await window.api.currentUser();
    if (user) await initApp(user);
    else show('view-login');
  }

  $('#form-setup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#setup-username').value.trim();
    const p1 = $('#setup-password').value;
    const p2 = $('#setup-password2').value;
    const errEl = $('#setup-error');
    errEl.textContent = '';
    if (p1 !== p2) {
      errEl.textContent = 'Passwords do not match';
      return;
    }
    try {
      await initApp(await window.api.createFirstUser(username, p1, {
        displayName: $('#setup-display-name').value,
        email: $('#setup-email').value,
      }));
    } catch (err) {
      errEl.textContent = errMsg(err);
    }
  });

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#login-error');
    errEl.textContent = '';
    try {
      await initApp(await window.api.login($('#login-username').value.trim(), $('#login-password').value));
    } catch (err) {
      errEl.textContent = errMsg(err);
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    state.unsubscribers.splice(0).forEach((off) => off());
    await window.api.logout();
    show('view-login');
    $('#login-username').value = '';
    $('#login-password').value = '';
  });

  // ---------------- MAIN APP INIT ----------------
  async function initApp(user) {
    setProfile(user);
    show('view-app');
    const firstInit = !state.uiWired;
    if (firstInit) {
      wireNavigation();
      wireDashboard();
      wireHosts();
      wireTransfer();
      wireSettings();
      wireProfile();
      wireAlerts();
      wireDomains();
      wireBackup();
      wireTelemetry();
      wireModal();
      wireDnsModal();
      wireTools();
      wireTelnet();
      state.uiWired = true;
    }

    state.settings = await window.api.getSettings();
    if (state.settings.theme) applyTheme(state.settings.theme, false);
    fillSettingsForm(state.settings);
    await Promise.all([refreshHosts(), refreshLatest(), refreshActivity(), refreshAlerts(), refreshDomains(), refreshBackup(), refreshTelemetry(), loadAbout()]);
    renderAll();

    state.unsubscribers.splice(0).forEach((off) => off());
    state.unsubscribers.push(
      window.api.onMonitorResult((row) => {
        applyLatestRow(row);
        scheduleRender();
      }),
      window.api.onActivity((activity) => {
        state.activity = activity;
        scheduleRender();
      }),
      window.api.onHostsChanged(async () => {
        await refreshHosts();
        scheduleRender();
      }),
      window.api.onAlert(onAlert),
      window.api.onDomainsChanged(() => refreshDomains()),
      window.api.onTransferProgress(renderImportProgress),
      window.api.onBackupChanged(() => refreshBackup()),
    );

    if (firstInit) {
      // Keeps relative times fresh and re-syncs in case a push was missed; idle while minimised/hidden.
      setInterval(async () => {
        if (!state.unsubscribers.length || document.hidden) return;
        await refreshLatest();
        scheduleRender();
      }, 30000);
      setInterval(() => {
        if (state.unsubscribers.length && !document.hidden) scheduleRender();
      }, 10000);
      document.addEventListener('visibilitychange', async () => {
        if (document.hidden || !state.unsubscribers.length) return;
        await refreshLatest();
        scheduleRender();
      });
    }
  }

  function wireNavigation() {
    $all('.nav-item').forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));
    $('#search').addEventListener('input', (e) => {
      state.search = e.target.value.trim().toLowerCase();
      renderAll();
    });
    $('#btn-check-all').addEventListener('click', async () => {
      const count = await window.api.checkAll();
      toast(count ? `Checking ${count} host${count === 1 ? '' : 's'}` : 'No enabled hosts to check');
    });
    $('#btn-theme').addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
  }

  function setTab(tab) {
    $all('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $all('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
    const [title, sub] = PAGE_META[tab];
    $('#page-title').textContent = title;
    $('#page-sub').textContent = sub;
    $('#titlebar-page').textContent = title;
    if (tab === 'backup') refreshBackup();
    if (tab === 'settings') refreshTelemetry();
    if (tab === 'domains') refreshDomains();
    if (tab === 'telnet') {
      refreshTelnetHosts();
      loadTelnetHistoryOnce();
    }
  }

  // ---------------- DATA ----------------
  async function refreshHosts() {
    state.hosts = await window.api.listHosts();
    state.hostsById = new Map(state.hosts.map((h) => [h.id, h]));
  }

  async function refreshLatest() {
    const rows = await window.api.getLatestPerHost();
    state.latestByHost = new Map();
    rows.forEach(applyLatestRow);
  }

  async function refreshActivity() {
    state.activity = await window.api.getActivity();
  }

  function applyLatestRow(row) {
    const existing = state.latestByHost.get(row.host_id) || {};
    existing[row.check_type === 'tcp' ? `tcp:${row.port}` : row.check_type] = row;
    state.latestByHost.set(row.host_id, existing);
  }

  function scheduleRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      renderAll();
    });
  }

  function renderAll() {
    renderDashboard();
    renderHostsTable();
    renderActivity();
    renderAlerts();
    renderDomains();
    $('#nav-count-hosts').textContent = state.hosts.length;
  }

  function matchesSearch(host) {
    if (!state.search) return true;
    return [host.name, host.url, host.ip, portsText(host)].some((v) => (v || '').toLowerCase().includes(state.search));
  }

  // ---------------- PORTS ----------------
  const hostPorts = (host) => (Array.isArray(host.ports) ? host.ports : []);
  const portsText = (host) => hostPorts(host).map((p) => (p.custom ? `${p.port}:${p.service}` : String(p.port))).join(', ');

  // Latest result for each configured port (null = not checked yet).
  function portResults(host, latest) {
    return hostPorts(host).map((p) => ({ ...p, row: latest[`tcp:${p.port}`] || null }));
  }

  function portTitle(p) {
    const name = `TCP ${p.port}${p.service ? ` (${p.service})` : ''}`;
    if (!p.row) return `${name} - not checked yet`;
    const status = p.row.is_up ? `open, ${fmtLatency(p.row.latency_ms)}` : `closed - ${p.row.error || 'no response'}`;
    return `${name}: ${status}${p.row.detail ? `\n${p.row.detail}` : ''}`;
  }

  function portChips(ports, withState = true) {
    if (!ports.length) return '<span class="muted-small">-</span>';
    return `<div class="port-chips">${ports.map((p) => {
      const cls = !withState ? 'neutral' : !p.row ? 'pending' : p.row.is_up ? 'up' : 'down';
      return `<span class="port-chip ${cls}" title="${escapeHtml(withState ? portTitle(p) : `TCP ${p.port}${p.service ? ` (${p.service})` : ''}`)}">${p.port}${p.service ? `<small>${escapeHtml(p.service)}</small>` : ''}</span>`;
    }).join('')}</div>`;
  }

  // ---------------- STATUS HELPERS ----------------
  function baseStatus(host, web, ping, ports = []) {
    if (!host.enabled) return { cls: 'disabled', label: 'Paused' };
    const checks = [web, ping, ...ports.map((p) => p.row)].filter(Boolean);
    if (!checks.length) return { cls: 'pending', label: 'Pending' };
    const up = checks.filter((r) => r.is_up).length;
    if (up === checks.length) return { cls: 'up', label: 'Up' };
    if (up === 0) return { cls: 'down', label: 'Down' };
    return { cls: 'partial', label: 'Partial' };
  }

  function liveStatus(host, base) {
    const a = state.activity;
    const run = a && a.running.find((r) => r.hostId === host.id);
    if (run) return { cls: 'checking', label: `${STAGE_LABELS[run.stage] || 'Checking'}…`, busy: true };
    if (a && a.queued.includes(host.id)) return { cls: 'checking', label: 'Queued', busy: true };
    return base;
  }

  function sslBadge(row) {
    if (!row || row.ssl_days_remaining === null || row.ssl_days_remaining === undefined) {
      return '<span class="badge badge-muted">N/A</span>';
    }
    const days = row.ssl_days_remaining;
    const warn = state.settings?.sslWarnDays ?? 30;
    const crit = state.settings?.sslCriticalDays ?? 7;
    if (days <= 0) return '<span class="badge badge-down">Expired</span>';
    if (days <= crit) return `<span class="badge badge-down">${days}d left</span>`;
    if (days <= warn) return `<span class="badge badge-warn">${days}d left</span>`;
    return `<span class="badge badge-up">${days}d left</span>`;
  }

  function checkCell(row, label) {
    if (!row) return '<span class="muted-small">-</span>';
    const cls = row.is_up ? 'badge-up' : 'badge-down';
    const tip = row.error || (row.check_type === 'ping' && row.detail ? `No ICMP reply (blocked by firewall?) - host answered on ${row.detail}` : '');
    const title = tip ? ` title="${escapeHtml(tip)}"` : '';
    return `<span class="badge ${cls}"${title}>${escapeHtml(label(row))}</span><span class="latency">${fmtLatency(row.latency_ms)}</span>`;
  }

  // ---------------- DASHBOARD ----------------
  function wireDashboard() {
    $all('#status-filter button').forEach((btn) => btn.addEventListener('click', () => {
      state.statusFilter = btn.dataset.filter;
      $all('#status-filter button').forEach((b) => b.classList.toggle('active', b === btn));
      renderDashboard();
    }));
    $('#dashboard-tbody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-host]');
      if (!tr) return;
      const host = state.hostsById.get(tr.dataset.host);
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'check') {
        window.api.checkHostNow(host.id).catch((err) => toast(errMsg(err), 'error'));
      } else if (action === 'dns') {
        openDnsLookup(host.url || host.ip);
      } else {
        openHostDetail(host.id);
      }
    });
  }

  function renderDashboard() {
    let up = 0;
    let down = 0;
    let partial = 0;
    let sslWarn = 0;
    const warnDays = state.settings?.sslWarnDays ?? 30;
    const nextRuns = state.activity?.nextRuns || {};
    const html = [];

    state.hosts.forEach((host) => {
      const latest = state.latestByHost.get(host.id) || {};
      const web = latest.https || latest.http;
      const ping = latest.ping;
      const ports = portResults(host, latest);
      const base = baseStatus(host, web, ping, ports);
      if (base.cls === 'up') up++;
      else if (base.cls === 'down') down++;
      else if (base.cls === 'partial') partial++;
      if (web && web.ssl_days_remaining !== null && web.ssl_days_remaining !== undefined && web.ssl_days_remaining <= warnDays) sslWarn++;

      if (!matchesSearch(host)) return;
      if (state.statusFilter === 'up' && base.cls !== 'up') return;
      if (state.statusFilter === 'issues' && base.cls !== 'down' && base.cls !== 'partial') return;

      const status = liveStatus(host, base);
      const lastTs = Math.max(web?.timestamp || 0, ping?.timestamp || 0, ...ports.map((p) => p.row?.timestamp || 0)) || null;
      const next = nextRuns[host.id];
      const isHttps = (host.url || '').startsWith('https');
      html.push({ key: host.id, html: `
        <tr data-host="${escapeHtml(host.id)}">
          <td><span class="status ${status.cls}">${status.busy ? '<span class="spinner-xs"></span>' : '<span class="status-dot"></span>'}${escapeHtml(status.label)}</span></td>
          <td><div class="cell-main">${escapeHtml(host.name)}</div><div class="cell-sub mono">${escapeHtml(host.url || '')}</div></td>
          <td class="mono nowrap">${escapeHtml(host.ip || '-')}${host.ipAuto ? '<span class="tag" title="Resolved automatically from the URL">auto</span>' : ''}</td>
          <td class="nowrap">${host.url ? checkCell(web, (r) => r.http_status || 'ERR') : '<span class="muted-small">-</span>'}</td>
          <td class="nowrap">${host.ip ? checkCell(ping, (r) => (r.is_up ? r.detail || 'Reply' : 'No reply')) : '<span class="muted-small">-</span>'}</td>
          <td class="ports-cell">${portChips(ports)}</td>
          <td>${isHttps ? sslBadge(web) : '<span class="muted-small">-</span>'}</td>
          <td class="nowrap"><div title="${escapeHtml(fmtTime(lastTs))}">${fmtAgo(lastTs)}</div>
            <div class="cell-sub">${host.enabled && next ? `next in ${fmtUntil(next)}` : ''}</div></td>
          <td class="actions-cell">
            <button class="icon-btn" data-action="check" title="Check now">${icon('refresh')}</button>
            <button class="btn btn-ghost btn-sm" data-action="details">${icon('activity')}Details</button>
            <button class="btn btn-ghost btn-sm" data-action="dns">${icon('globe')}DNS</button>
          </td>
        </tr>`.trim() });
    });

    patchRows($('#dashboard-tbody'), html);
    $('#dashboard-empty').classList.toggle('hidden', html.length > 0);
    $('#dashboard-empty p').innerHTML = state.hosts.length
      ? 'No hosts match the current search/filter.'
      : 'No hosts yet. Add one on the <strong>Hosts</strong> page or import a list.';

    const stat = (tone, ic, num, label) => `
      <div class="stat tone-${tone}"><div class="stat-icon">${icon(ic)}</div>
        <div><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div></div>`;
    $('#summary-cards').innerHTML = [
      stat('primary', 'server', state.hosts.length, 'Hosts monitored'),
      stat('success', 'check', up, 'Up'),
      stat('danger', 'down', down, partial ? `Down &middot; ${partial} partial` : 'Down'),
      stat('warning', 'shield', sslWarn, 'SSL warnings'),
    ].join('');
  }

  // ---------------- MONITORING ACTIVITY ----------------
  function renderActivity() {
    const a = state.activity;
    if (!a) return;
    const busy = a.running.length > 0 || a.queued.length > 0;
    const card = $('#sync-card');
    card.classList.toggle('busy', busy);
    const pct = a.cycle && a.cycle.total ? Math.round((a.cycle.done / a.cycle.total) * 100) : busy ? 0 : 100;

    $('#sync-title').textContent = busy ? 'Checking hosts' : 'Up to date';
    $('#sync-count').textContent = a.cycle ? `${a.cycle.done}/${a.cycle.total}` : '';
    $('#sync-progress').style.width = `${a.lastSyncAt || busy ? pct : 0}%`;
    $('#sync-progress').style.background = busy ? '' : 'hsl(var(--success))';

    const shown = a.running.slice(0, 4).map((r) => `<div><span class="stage">${escapeHtml(STAGE_LABELS[r.stage] || r.stage)}</span><span class="name">${escapeHtml(r.name)}</span></div>`);
    const more = a.running.length - shown.length + a.queued.length;
    if (more > 0) shown.push(`<div>+${more} queued</div>`);
    $('#sync-running').innerHTML = shown.join('');

    const nexts = Object.values(a.nextRuns || {});
    const nextIn = nexts.length ? Math.min(...nexts) - Date.now() : null;
    $('#sync-meta').textContent = a.lastSyncAt
      ? `Last sync ${new Date(a.lastSyncAt).toLocaleTimeString()}${!busy && nextIn !== null ? ` · next in ${fmtDuration(nextIn)}` : ''}`
      : busy ? 'Running first checks…' : 'Waiting for first check';

    const bar = $('#topline-bar');
    bar.classList.toggle('active', busy);
    bar.style.width = busy ? `${Math.max(pct, 4)}%` : '100%';

    $('#titlebar-status').classList.toggle('busy', busy);
    $('#titlebar-status-text').textContent = busy
      ? `Checking${a.cycle ? ` ${a.cycle.done}/${a.cycle.total}` : '…'}`
      : a.lastSyncAt ? `Up to date · ${new Date(a.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Idle';
  }

  // ---------------- HOSTS ----------------
  function wireHosts() {
    $('#btn-add-host').addEventListener('click', () => openHostForm(null));
    $('#host-cancel-btn').addEventListener('click', closeHostForm);
    $('#host-ports').addEventListener('input', markPortPresets);
    $('#port-presets').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-port]');
      if (chip) toggleFormPort(chip);
    });
    $('#form-host').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('#host-error');
      errEl.textContent = '';
      const payload = {
        name: $('#host-name').value.trim(),
        url: $('#host-url').value.trim(),
        ip: $('#host-ip').value.trim(),
        ports: $('#host-ports').value.trim(),
        pingPort: $('#host-ping-port').value.trim(),
        method: $('#host-method').value,
        expectStatus: $('#host-expect-status').value.trim(),
        bodyMatch: $('#host-body-match').value.trim(),
        followRedirects: $('#host-follow-redirects').checked,
        headers: $('#host-headers').value,
        body: $('#host-body').value,
        intervalMinutes: Number($('#host-interval').value) || 5,
        enabled: $('#host-enabled').checked,
      };
      if (!payload.url && !payload.ip) {
        errEl.textContent = 'Provide a URL or an IP address (or both).';
        return;
      }
      const btn = $('#host-submit-btn');
      btn.disabled = true;
      try {
        if (state.editingHostId) await window.api.updateHost(state.editingHostId, payload);
        else await window.api.addHost(payload);
        closeHostForm();
        await refreshHosts();
        renderAll();
      } catch (err) {
        errEl.textContent = errMsg(err);
      } finally {
        btn.disabled = false;
      }
    });

    $('#hosts-tbody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-host]');
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!tr || !action) return;
      if (action === 'edit') openHostForm(tr.dataset.host);
      if (action === 'delete') deleteHost(tr.dataset.host);
    });
    $('#hosts-tbody').addEventListener('change', async (e) => {
      if (!e.target.matches('[data-action="toggle"]')) return;
      const id = e.target.closest('tr').dataset.host;
      try {
        await window.api.updateHost(id, { enabled: e.target.checked });
        await refreshHosts();
        renderAll();
      } catch (err) {
        toast(errMsg(err), 'error');
      }
    });
  }

  function openHostForm(id) {
    const host = id ? state.hostsById.get(id) : null;
    state.editingHostId = host ? host.id : null;
    $('#form-host').reset();
    $('#host-error').textContent = '';
    $('#host-form-title').textContent = host ? `Edit ${host.name}` : 'Add host';
    $('#host-submit-btn').textContent = host ? 'Save changes' : 'Add host';
    $('#host-name').value = host ? host.name : '';
    $('#host-url').value = host ? host.url || '' : '';
    $('#host-ip').value = host ? host.ip || '' : '';
    $('#host-ports').value = host ? portsText(host) : '';
    $('#host-ping-port').value = host && host.pingPort ? host.pingPort : '';
    $('#host-method').value = host && host.method ? host.method : 'GET';
    $('#host-expect-status').value = host ? host.expectStatus || '' : '';
    $('#host-body-match').value = host ? host.bodyMatch || '' : '';
    $('#host-follow-redirects').checked = host ? host.followRedirects !== false : true;
    $('#host-headers').value = host && Array.isArray(host.headers) ? host.headers.map((h) => `${h.name}: ${h.value}`).join('\n') : '';
    $('#host-body').value = host ? host.body || '' : '';
    markPortPresets();
    $('#host-interval').value = host ? host.intervalMinutes : state.settings?.defaultIntervalMinutes || 5;
    $('#host-enabled').checked = host ? host.enabled : true;
    $('#form-host').classList.remove('hidden');
    setTab('hosts');
    $('#host-name').focus();
  }

  function closeHostForm() {
    state.editingHostId = null;
    $('#form-host').classList.add('hidden');
  }

  function formPortTokens() {
    return $('#host-ports').value.split(/[\s,;]+/).filter(Boolean);
  }

  const tokenMatches = (token, chip) => {
    const t = token.toLowerCase();
    return t === chip.dataset.name || t.split(/[:/]/)[0] === chip.dataset.port;
  };

  function markPortPresets() {
    const tokens = formPortTokens();
    $all('#port-presets [data-port]').forEach((chip) => chip.classList.toggle('active', tokens.some((t) => tokenMatches(t, chip))));
  }

  function toggleFormPort(chip) {
    const tokens = formPortTokens();
    const kept = tokens.filter((t) => !tokenMatches(t, chip));
    if (kept.length === tokens.length) kept.push(chip.dataset.port);
    $('#host-ports').value = kept.join(', ');
    markPortPresets();
  }

  function renderHostsTable() {
    const rows = state.hosts.filter(matchesSearch).map((host) => ({ key: host.id, html: `
      <tr data-host="${escapeHtml(host.id)}">
        <td class="cell-main">${escapeHtml(host.name)}</td>
        <td class="mono">${escapeHtml(host.url || '-')}</td>
        <td class="mono nowrap">${escapeHtml(host.ip || '-')}${host.ipAuto ? '<span class="tag" title="Resolved automatically from the URL">auto</span>' : ''}</td>
        <td class="ports-cell">${portChips(hostPorts(host), false)}</td>
        <td class="nowrap">${host.intervalMinutes} min</td>
        <td><label class="switch-label" title="${host.enabled ? 'Pause monitoring' : 'Resume monitoring'}">
          <input type="checkbox" data-action="toggle" ${host.enabled ? 'checked' : ''} /><span class="switch"></span></label></td>
        <td class="actions-cell">
          <button class="icon-btn" data-action="edit" title="Edit">${icon('edit')}</button>
          <button class="icon-btn danger" data-action="delete" title="Delete">${icon('trash')}</button>
        </td>
      </tr>`.trim() }));
    patchRows($('#hosts-tbody'), rows);
    $('#hosts-empty').classList.toggle('hidden', rows.length > 0);
  }

  async function deleteHost(id) {
    const host = state.hostsById.get(id);
    if (!host || !confirm(`Delete "${host.name}" and its history? This cannot be undone.`)) return;
    await window.api.deleteHost(id);
    state.latestByHost.delete(id);
    if (state.editingHostId === id) closeHostForm();
    await refreshHosts();
    renderAll();
  }

  // ---------------- IMPORT / EXPORT ----------------
  function wireTransfer() {
    $('#btn-import').addEventListener('click', doImport);
    $('#btn-import-2').addEventListener('click', doImport);
    $all('[data-export]').forEach((btn) => btn.addEventListener('click', () => doExport(btn.dataset.export, btn)));
    $('#btn-open-data').addEventListener('click', () => window.api.openDataFolder().catch((err) => toast(errMsg(err), 'error')));
  }

  async function doExport(kind, btn) {
    btn.disabled = true;
    try {
      const res = await window.api.exportData(kind);
      if (res.canceled) return;
      const what = kind === 'history-csv' ? 'check results' : 'hosts';
      toast(`Exported ${res.count} ${what} to ${res.filePath}`, 'success', 6000);
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      btn.disabled = false;
    }
  }

  function renderImportProgress(p) {
    const card = $('#import-card');
    card.classList.remove('hidden');
    const bar = $('#import-progress');
    bar.parentElement.classList.remove('indeterminate');
    bar.style.width = `${p.total ? Math.round((p.done / p.total) * 100) : 100}%`;
    $('#import-status').textContent = p.phase === 'resolving'
      ? `Resolving IP addresses ${p.done}/${p.total}`
      : p.phase === 'saving' ? 'Saving hosts…' : 'Done';
  }

  async function doImport() {
    const card = $('#import-card');
    const bar = $('#import-progress');
    setTab('hosts');
    card.classList.remove('hidden');
    bar.style.width = '0%';
    bar.parentElement.classList.add('indeterminate');
    $('#import-status').textContent = 'Choose a file…';
    $('#import-result').innerHTML = '';
    try {
      const res = await window.api.importHosts();
      if (res.canceled) {
        card.classList.add('hidden');
        return;
      }
      bar.parentElement.classList.remove('indeterminate');
      bar.style.width = '100%';
      $('#import-status').textContent = 'Done';
      const invalid = res.invalid.map((i) => `<li>Entry ${i.index}: ${escapeHtml(i.reason)}</li>`).join('');
      $('#import-result').innerHTML = `
        <div><strong>${res.added}</strong> added &middot; ${res.skipped} duplicate${res.skipped === 1 ? '' : 's'} skipped
          &middot; ${res.invalidCount} invalid &middot; ${res.total} entries in <span class="mono">${escapeHtml(res.filePath)}</span></div>
        ${invalid ? `<ul>${invalid}${res.invalidCount > res.invalid.length ? `<li>…and ${res.invalidCount - res.invalid.length} more</li>` : ''}</ul>` : ''}`;
      toast(`Imported ${res.added} host${res.added === 1 ? '' : 's'}`, res.added ? 'success' : 'info');
      await refreshHosts();
      renderAll();
    } catch (err) {
      bar.parentElement.classList.remove('indeterminate');
      $('#import-status').textContent = 'Failed';
      $('#import-result').innerHTML = `<span class="error-text">${escapeHtml(errMsg(err))}</span>`;
    }
  }

  // ---------------- SETTINGS ----------------
  function fillSettingsForm(settings) {
    $('#settings-retention').value = settings.retentionDays;
    $('#settings-interval').value = settings.defaultIntervalMinutes;
    $('#settings-ssl-warn').value = settings.sslWarnDays;
    $('#settings-ssl-critical').value = settings.sslCriticalDays;
    $('#settings-domain-warn').value = settings.domainWarnDays ?? 30;
    $('#settings-domain-critical').value = settings.domainCriticalDays ?? 7;
    $('#settings-dns').value = (settings.dnsServers || []).join(', ');
    markDnsPreset();
  }

  function markDnsPreset() {
    const value = $('#settings-dns').value.replace(/\s+/g, '');
    $all('#dns-presets .chip').forEach((c) => c.classList.toggle('active', c.dataset.dns.replace(/\s+/g, '') === value));
  }

  function flash(el, text) {
    el.textContent = text;
    setTimeout(() => { el.textContent = ''; }, 3000);
  }

  function wireSettings() {
    $('#form-settings').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#settings-error').textContent = '';
      try {
        state.settings = await window.api.updateSettings({
          retentionDays: $('#settings-retention').value,
          defaultIntervalMinutes: $('#settings-interval').value,
          sslWarnDays: $('#settings-ssl-warn').value,
          sslCriticalDays: $('#settings-ssl-critical').value,
          domainWarnDays: $('#settings-domain-warn').value,
          domainCriticalDays: $('#settings-domain-critical').value,
        });
        flash($('#settings-success'), 'Saved');
        renderDashboard();
        renderDomains();
      } catch (err) {
        $('#settings-error').textContent = errMsg(err);
      }
    });

    $('#settings-dns').addEventListener('input', markDnsPreset);
    $all('#dns-presets .chip').forEach((chip) => chip.addEventListener('click', () => {
      $('#settings-dns').value = chip.dataset.dns;
      markDnsPreset();
    }));
    $('#form-dns-settings').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#dns-settings-error').textContent = '';
      try {
        state.settings = await window.api.updateSettings({ dnsServers: $('#settings-dns').value });
        fillSettingsForm(state.settings);
        $('#dns-server').innerHTML = ''; // reload server list so "Global" appears/disappears
        flash($('#dns-settings-success'), state.settings.dnsServers.length ? 'Saved - checks now use these servers' : 'Saved - using system resolver');
      } catch (err) {
        $('#dns-settings-error').textContent = errMsg(err);
      }
    });

    $all('#theme-select button').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.theme)));

    $('#form-password').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('#pw-error');
      errEl.textContent = '';
      try {
        await window.api.changePassword($('#pw-current').value, $('#pw-new').value);
        $('#form-password').reset();
        flash($('#pw-success'), 'Password updated');
        setProfile(await window.api.currentUser());
      } catch (err) {
        errEl.textContent = errMsg(err);
      }
    });
  }

  // ---------------- PROFILE ----------------
  function initials(user) {
    const parts = (user.displayName || user.username || '?').trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?').slice(0, 1)).toUpperCase();
  }

  const fmtIso = (iso) => fmtTime(Date.parse(iso));

  function setProfile(user) {
    if (!user) return;
    state.profile = user;
    $('#current-username').textContent = user.displayName || user.username;
    $('#current-user-sub').textContent = user.jobTitle || user.email || user.role || '';
    $('#user-avatar').textContent = initials(user);
    $('#profile-avatar').textContent = initials(user);
    $('#profile-name').textContent = user.displayName || user.username;
    $('#profile-sub').textContent = [`@${user.username}`, user.role, user.jobTitle, user.organization].filter(Boolean).join(' · ');
    Object.entries(PROFILE_INPUTS).forEach(([id, key]) => {
      const el = $(`#${id}`);
      if (document.activeElement !== el) el.value = user[key] || '';
    });
    const fact = (k, v) => `<div class="detail-row"><span>${k}</span><span>${escapeHtml(v)}</span></div>`;
    $('#profile-facts').innerHTML = [
      fact('Username', user.username),
      fact('Role', user.role || 'Administrator'),
      fact('Account created', fmtIso(user.createdAt)),
      fact('Current sign-in', fmtIso(user.lastLoginAt)),
      fact('Previous sign-in', user.previousLoginAt ? fmtIso(user.previousLoginAt) : 'First sign-in'),
      fact('Total sign-ins', String(user.loginCount || 0)),
      fact('Password changed', user.passwordChangedAt ? fmtIso(user.passwordChangedAt) : 'Never'),
      fact('Profile updated', user.profileUpdatedAt ? fmtIso(user.profileUpdatedAt) : 'Never'),
    ].join('');
  }

  function wireProfile() {
    $('#form-profile').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#profile-error').textContent = '';
      const patch = Object.fromEntries(Object.entries(PROFILE_INPUTS).map(([id, key]) => [key, $(`#${id}`).value]));
      try {
        setProfile(await window.api.updateProfile(patch));
        flash($('#profile-success'), 'Profile saved');
      } catch (err) {
        $('#profile-error').textContent = errMsg(err);
      }
    });
    $('#user-chip').addEventListener('click', () => {
      setTab('settings');
      $('#form-profile').scrollIntoView({ block: 'start' });
    });
  }

  // ---------------- ALERTS ----------------
  async function refreshAlerts() {
    try {
      state.alerts = await window.api.listAlerts();
    } catch {
      return;
    }
    renderAlerts();
  }

  function renderAlerts() {
    const unread = state.alerts.filter((a) => !a.read).length;
    $('#alert-unread').textContent = unread > 99 ? '99+' : String(unread);
    $('#alert-unread').classList.toggle('hidden', !unread);
    const ago = (ts) => (Date.now() - ts < 60000 ? 'now' : fmtDuration(Date.now() - ts));
    const html = state.alerts.length
      ? state.alerts.slice(0, 20).map((a) => `
        <button type="button" class="alert-item sev-${escapeHtml(a.severity)}${a.read ? '' : ' unread'}" data-alert="${escapeHtml(a.id)}"
          title="${escapeHtml(`${a.title}\n${a.message || ''}\n${fmtTime(a.ts)}`)}">
          <span class="alert-text"><span class="alert-title">${escapeHtml(a.title)}</span><span class="alert-msg">${escapeHtml(a.message || '')}</span></span>
          <span class="alert-time">${ago(a.ts)}</span>
        </button>`).join('')
      : '<div class="alert-empty">No alerts. Hosts going down or recovering, and expiring SSL certificates or domains, show up here.</div>';
    if (html === state.alertsHtml) return;
    state.alertsHtml = html;
    $('#alert-list').innerHTML = html;
  }

  async function markAlertsRead() {
    if (!state.alerts.some((a) => !a.read)) return;
    try {
      state.alerts = await window.api.markAlertsRead();
    } catch {
      return;
    }
    renderAlerts();
  }

  // Bursts (e.g. the network dropping) become a single toast instead of dozens.
  function onAlert(alert) {
    state.alerts = [alert, ...state.alerts.filter((a) => a.id !== alert.id)].slice(0, 50);
    renderAlerts();
    state.pendingAlerts.push(alert);
    if (state.alertToastTimer) return;
    state.alertToastTimer = setTimeout(() => {
      state.alertToastTimer = null;
      const list = state.pendingAlerts.splice(0);
      if (!list.length) return;
      const type = list.some((a) => a.severity === 'danger') ? 'error' : list.every((a) => a.severity === 'success') ? 'success' : 'info';
      const first = list[0];
      toast(list.length === 1 ? `${first.title}${first.message ? ` - ${first.message}` : ''}` : `${list.length} new alerts - latest: ${first.title}`, type, 8000);
    }, 1500);
  }

  function wireAlerts() {
    $('#alert-list').addEventListener('click', (e) => {
      const item = e.target.closest('[data-alert]');
      const alert = item && state.alerts.find((a) => a.id === item.dataset.alert);
      if (!alert) return;
      if (alert.hostId && state.hostsById.has(alert.hostId)) {
        setTab('dashboard');
        openHostDetail(alert.hostId);
      } else if (alert.domainId) {
        setTab('domains');
      }
      markAlertsRead();
    });
    $('#btn-alerts-read').addEventListener('click', markAlertsRead);
    $('#btn-alerts-clear').addEventListener('click', async () => {
      try {
        state.alerts = await window.api.clearAlerts();
        renderAlerts();
      } catch (err) {
        toast(errMsg(err), 'error');
      }
    });
  }

  // ---------------- DOMAINS (WHOIS / EXPIRY) ----------------
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString() : '-');

  function expiryBadge(daysLeft) {
    if (daysLeft === null || daysLeft === undefined) return '<span class="badge badge-muted">Unknown</span>';
    const warn = state.settings?.domainWarnDays ?? 30;
    const crit = state.settings?.domainCriticalDays ?? 7;
    if (daysLeft <= 0) return '<span class="badge badge-down">Expired</span>';
    if (daysLeft <= crit) return `<span class="badge badge-down">${daysLeft}d left</span>`;
    if (daysLeft <= warn) return `<span class="badge badge-warn">${daysLeft}d left</span>`;
    return `<span class="badge badge-up">${daysLeft}d left</span>`;
  }

  async function refreshDomains() {
    try {
      state.domains = await window.api.listDomains();
    } catch {
      return;
    }
    renderDomains();
  }

  function domainStatusCell(d) {
    if (d.checking) return '<span class="status checking"><span class="spinner-xs"></span>Checking…</span>';
    if (d.error && !d.lastCheckedAt) return `<span class="badge badge-down" title="${escapeHtml(d.error)}">Lookup failed</span>`;
    if (!d.lastCheckedAt) return '<span class="badge badge-muted">Pending</span>';
    const stale = d.error ? ` <span class="tag" title="${escapeHtml(`Last attempt failed: ${d.error}`)}">stale</span>` : '';
    return expiryBadge(d.daysLeft) + stale;
  }

  function renderDomains() {
    $('#nav-count-domains').textContent = state.domains.length;
    const q = state.search;
    const rows = state.domains
      .filter((d) => !q || [d.name, d.registrar].some((v) => (v || '').toLowerCase().includes(q)))
      .map((d) => ({ key: d.id, html: `
        <tr data-host="${escapeHtml(d.id)}">
          <td><div class="cell-main">${escapeHtml(d.name)}</div>${d.registeredName && d.registeredName !== d.name ? `<div class="cell-sub mono">${escapeHtml(d.registeredName)}</div>` : ''}</td>
          <td>${escapeHtml(d.registrar || '-')}</td>
          <td class="nowrap">${fmtDate(d.createdAt)}</td>
          <td class="nowrap">${fmtDate(d.expiresAt)}</td>
          <td class="nowrap">${domainStatusCell(d)}</td>
          <td class="nowrap" title="${escapeHtml(fmtIso(d.lastCheckedAt))}">${d.lastCheckedAt ? fmtAgo(Date.parse(d.lastCheckedAt)) : 'Never'}</td>
          <td class="actions-cell">
            <button class="icon-btn" data-action="check" title="Check now"${d.checking ? ' disabled' : ''}>${icon('refresh')}</button>
            <button class="btn btn-ghost btn-sm" data-action="whois">${icon('globe')}WHOIS</button>
            <button class="icon-btn danger" data-action="delete" title="Remove from watch list">${icon('trash')}</button>
          </td>
        </tr>`.trim() }));
    patchRows($('#domains-tbody'), rows);
    $('#domains-empty').classList.toggle('hidden', rows.length > 0);
    $('#domains-empty p').textContent = state.domains.length
      ? 'No domains match the current search.'
      : 'No domains watched yet. Add one above to track its expiry date.';
  }

  async function addWatchedDomain(name, errEl) {
    errEl.textContent = '';
    try {
      const created = await window.api.addDomain(name);
      await refreshDomains();
      toast(`Watching ${created.name} - checking expiry date…`, 'success');
      return true;
    } catch (err) {
      errEl.textContent = errMsg(err);
      return false;
    }
  }

  async function runWhois(target) {
    if (!target) return;
    const errEl = $('#whois-error');
    const out = $('#whois-results');
    const btn = $('#whois-submit-btn');
    $('#whois-target').value = target;
    errEl.textContent = '';
    out.innerHTML = '<div class="spinner spinner-small"></div>';
    btn.disabled = true;
    $('#whois-watch-btn').disabled = true;
    try {
      const res = await window.api.whoisLookup(target);
      state.whoisLast = res;
      out.innerHTML = renderWhois(res);
      $('#whois-watch-btn').disabled = !res.found || state.domains.some((d) => d.name === res.domain);
    } catch (err) {
      out.innerHTML = '';
      errEl.textContent = errMsg(err);
    } finally {
      btn.disabled = false;
    }
  }

  function renderWhois(res) {
    const raw = res.raw
      ? `<details class="dns-raw whois-raw"><summary>Raw WHOIS${res.whoisServer ? ` (${escapeHtml(res.whoisServer)})` : ''}</summary><pre>${escapeHtml(res.raw)}</pre></details>`
      : '';
    const errors = res.errors.length ? `<p class="muted-small">${escapeHtml(res.errors.join(' · '))}</p>` : '';
    if (!res.found) {
      return `<p class="muted">No registration data found for <strong>${escapeHtml(res.domain)}</strong>. It may be unregistered, or its registry
        doesn't publish RDAP/WHOIS data.</p>${errors}${raw}`;
    }
    const item = (k, v) => `<div class="detail-item"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    const dnssec = res.dnssec === null ? '-' : res.dnssec ? 'Signed' : 'Unsigned';
    return `
      <div class="detail-grid">
        ${item('Domain', `<span class="mono">${escapeHtml(res.domain)}</span>`)}
        ${item('Registrar', `${escapeHtml(res.registrar || '-')}${res.registrarIanaId ? ` <span class="muted-small">IANA ${escapeHtml(res.registrarIanaId)}</span>` : ''}`)}
        ${item('Registered', escapeHtml(fmtDate(res.createdAt)))}
        ${item('Expires', `${escapeHtml(fmtDate(res.expiresAt))} ${expiryBadge(res.daysLeft)}`)}
        ${item('Last updated', escapeHtml(fmtDate(res.updatedAt)))}
        ${item('Source / DNSSEC', `${escapeHtml(res.source || '-')} &middot; ${dnssec}`)}
      </div>
      ${res.nameservers.length ? `<div class="detail-row"><span>Name servers</span><span class="mono">${res.nameservers.map(escapeHtml).join('<br>')}</span></div>` : ''}
      ${res.status.length ? `<div class="detail-row"><span>Status</span><span class="whois-status">${res.status.map((s) => `<span class="badge badge-muted">${escapeHtml(s)}</span>`).join('')}</span></div>` : ''}
      <div class="detail-row"><span>Checked</span><span>${escapeHtml(fmtIso(res.checkedAt))}</span></div>
      ${errors}${raw}`;
  }

  function wireDomains() {
    $('#form-whois').addEventListener('submit', (e) => {
      e.preventDefault();
      runWhois($('#whois-target').value.trim());
    });
    $('#whois-watch-btn').addEventListener('click', async (e) => {
      if (!state.whoisLast) return;
      if (await addWatchedDomain(state.whoisLast.domain, $('#whois-error'))) e.currentTarget.disabled = true;
    });
    $('#form-domain-add').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (await addWatchedDomain($('#domain-add-name').value.trim(), $('#domain-add-error'))) $('#domain-add-name').value = '';
    });
    $('#btn-domains-check-all').addEventListener('click', async () => {
      try {
        const count = await window.api.checkDomain('all');
        toast(count ? `Checking ${count} domain${count === 1 ? '' : 's'}` : 'No domains to check');
      } catch (err) {
        toast(errMsg(err), 'error');
      }
    });
    $('#domains-tbody').addEventListener('click', async (e) => {
      const tr = e.target.closest('tr[data-host]');
      const action = e.target.closest('[data-action]')?.dataset.action;
      const domain = tr && state.domains.find((d) => d.id === tr.dataset.host);
      if (!domain || !action) return;
      if (action === 'whois') {
        runWhois(domain.name);
        $('#whois-target').scrollIntoView({ block: 'center' });
      } else if (action === 'check') {
        window.api.checkDomain(domain.id).catch((err) => toast(`${domain.name}: ${errMsg(err)}`, 'error'));
      } else if (action === 'delete' && confirm(`Stop watching "${domain.name}"?`)) {
        try {
          await window.api.removeDomain(domain.id);
          await refreshDomains();
        } catch (err) {
          toast(errMsg(err), 'error');
        }
      }
    });
  }

  // ---------------- BACKUP & SYNC ----------------
  function fmtBytes(n) {
    if (!n && n !== 0) return '-';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  }

  async function guarded(btn, fn) {
    if (btn) btn.disabled = true;
    try {
      return await fn();
    } catch (err) {
      toast(errMsg(err), 'error', 7000);
      return null;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function refreshBackup(status) {
    try {
      state.backup = status || await window.api.backupStatus();
    } catch {
      return;
    }
    renderBackup();
  }

  function renderBackup() {
    const b = state.backup;
    if (!b) return;
    $('#backup-local-enabled').checked = b.local.enabled;
    if (document.activeElement !== $('#backup-local-keep')) $('#backup-local-keep').value = b.local.keep;
    if (document.activeElement !== $('#backup-history')) $('#backup-history').checked = b.local.includeHistory;
    $('#backup-dir').textContent = b.local.dir;
    $('#backup-passphrase').placeholder = b.passphraseSet ? '•••••••• (set - full backups are encrypted)' : 'Not set - backups are compressed but not encrypted';
    $('#backup-local-tbody').innerHTML = b.local.backups.length
      ? b.local.backups.map((x) => `
        <tr><td class="mono">${escapeHtml(x.name)}</td>
          <td><span class="badge ${x.kind === 'full' ? 'badge-up' : 'badge-muted'}">${x.kind === 'full' ? 'Full' : 'Config'}</span>${x.encrypted ? ` <span class="tag">${icon('lock')}encrypted</span>` : ''}</td>
          <td class="nowrap">${fmtBytes(x.size)}</td><td class="nowrap">${escapeHtml(fmtTime(Date.parse(x.modified)))}</td>
          <td class="actions-cell"><button class="btn btn-ghost btn-sm" data-restore-local="${escapeHtml(x.name)}">Restore</button></td></tr>`).join('')
      : '<tr><td colspan="5" class="muted-small">No local backups yet.</td></tr>';
  }

  async function restoreBackup(source, name) {
    const full = /(?:devoping|devowatch)-backup-/.test(name);
    if (!confirm(`Restore "${name}"?\n\nThis replaces all hosts, user accounts and settings (monitoring, DNS, theme, usage data)${full ? ', plus check history if the backup contains it' : ''}.\nA safety backup of the current configuration is saved first.`)) return;
    const res = await guarded(null, () => window.api.backupRestore(source, name));
    if (!res) return;
    toast(`Restored ${res.kind} backup from ${new Date(res.createdAt).toLocaleString()} (${res.hosts} hosts${res.history ? ', with history' : ''})`, 'success', 7000);
    state.settings = await window.api.getSettings();
    if (state.settings.theme) applyTheme(state.settings.theme, false);
    fillSettingsForm(state.settings);
    await Promise.all([refreshHosts(), refreshLatest(), refreshBackup()]);
    renderAll();
  }

  function wireBackup() {
    $('#backup-local-enabled').addEventListener('change', (e) => guarded(null, async () => {
      await refreshBackup(await window.api.backupUpdateSettings({ localEnabled: e.target.checked }));
      toast(e.target.checked ? 'Automatic local backup enabled' : 'Automatic local backup disabled');
    }));
    $('#btn-backup-local-save').addEventListener('click', (e) => guarded(e.currentTarget, async () => {
      await refreshBackup(await window.api.backupUpdateSettings({ localKeep: $('#backup-local-keep').value, includeHistory: $('#backup-history').checked }));
      toast('Saved', 'success');
    }));
    $('#btn-backup-open').addEventListener('click', () => window.api.backupOpenFolder().catch((err) => toast(errMsg(err), 'error')));
    $('#btn-backup-local-now').addEventListener('click', (e) => guarded(e.currentTarget, async () => {
      const res = await window.api.backupRunLocal();
      toast(`Saved ${res.name} (${fmtBytes(res.size)})`, 'success', 6000);
      await refreshBackup();
    }));
    $('#backup-local-tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-restore-local]');
      if (btn) restoreBackup('local', btn.dataset.restoreLocal);
    });
    $('#btn-passphrase-save').addEventListener('click', (e) => guarded(e.currentTarget, async () => {
      await refreshBackup(await window.api.backupSetPassphrase($('#backup-passphrase').value));
      $('#backup-passphrase').value = '';
      toast('Backup passphrase set - new full backups are encrypted', 'success');
    }));
    $('#btn-passphrase-clear').addEventListener('click', (e) => guarded(e.currentTarget, async () => {
      if (!confirm('Clear the passphrase? New backups will not be encrypted, and existing encrypted backups can no longer be restored on this PC until it is set again.')) return;
      await refreshBackup(await window.api.backupSetPassphrase(null));
      toast('Backup passphrase cleared');
    }));
  }

  // ---------------- TELEMETRY / ABOUT ----------------
  async function refreshTelemetry() {
    let t;
    try {
      t = await window.api.telemetryStatus();
    } catch {
      return;
    }
    $('#telemetry-enabled').checked = t.enabled;
    $('#telemetry-enabled').disabled = t.locked;
    const parts = [];
    if (t.locked) parts.push(`Managed by your administrator (${t.lockedReason}).`);
    if (t.enabled) {
      parts.push(`Auto-submitted every ${t.intervalMinutes} minutes.`);
      if (t.lastSentAt) parts.push(`Last sent ${fmtTime(Date.parse(t.lastSentAt))}.`);
      if (t.lastResult && /failed/i.test(t.lastResult)) parts.push(t.lastResult);
    }
    $('#telemetry-status').textContent = parts.join(' ');
  }

  function wireTelemetry() {
    $('#telemetry-enabled').addEventListener('change', async (e) => {
      try {
        await window.api.telemetryUpdate({ enabled: e.target.checked });
        toast(e.target.checked ? 'Anonymous usage data enabled' : 'Usage data disabled');
      } catch (err) {
        toast(errMsg(err), 'error');
      }
      await refreshTelemetry();
    });
  }

  async function loadAbout() {
    const info = await window.api.appInfo();
    $('#about-version').textContent = info.version;
    $('#about-electron').textContent = info.electron;
    $('#about-year').textContent = new Date().getFullYear();
  }

  // ---------------- HOST DETAIL MODAL ----------------
  function wireModal() {
    $('#modal-close-btn').addEventListener('click', closeModal);
    $('#modal-detail').addEventListener('click', (e) => {
      if (e.target.id === 'modal-detail') closeModal();
    });
    $('#modal-report-html').addEventListener('click', () => exportReport(state.detailHostId, 'html'));
    $('#modal-report-csv').addEventListener('click', () => exportReport(state.detailHostId, 'csv'));
    $('#modal-report-pdf').addEventListener('click', () => exportReport(state.detailHostId, 'pdf'));
    $('#modal-chart-png').addEventListener('click', downloadChartPng);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closeModal();
      $('#modal-dns').classList.add('hidden');
      $('#modal-tools').classList.add('hidden');
    });
  }

  function closeModal() {
    $('#modal-detail').classList.add('hidden');
    if (state.detailChart) {
      state.detailChart.destroy();
      state.detailChart = null;
    }
  }

  async function openHostDetail(hostId) {
    const host = state.hostsById.get(hostId);
    if (!host) return;
    state.detailHostId = hostId;
    $('#modal-title').textContent = host.name;
    $('#modal-detail').classList.remove('hidden');

    const days = state.settings?.retentionDays || 7;
    const [history, summary] = await Promise.all([
      window.api.getHistory(hostId, days),
      window.api.getUptimeSummary(hostId, days),
    ]);
    const latest = state.latestByHost.get(hostId) || {};
    const web = latest.https || latest.http;
    const ports = portResults(host, latest);
    const base = baseStatus(host, web, latest.ping, ports);
    const item = (k, v) => `<div class="detail-item"><div class="k">${k}</div><div class="v">${v}</div></div>`;

    const uptime = summary.map((s) => {
      const pct = s.total ? ((s.up_count / s.total) * 100).toFixed(1) : '0.0';
      const svc = s.check_type === 'tcp' ? ports.find((p) => p.port === s.port)?.service : null;
      const name = s.check_type === 'tcp' ? `TCP ${s.port}${svc ? ` ${svc}` : ''}` : s.check_type.toUpperCase();
      return `<div class="detail-row"><span>${escapeHtml(name)} uptime (${days}d)</span>
        <span>${pct}% &middot; ${s.up_count}/${s.total} checks &middot; avg ${Math.round(s.avg_latency || 0)} ms</span></div>`;
    }).join('');
    const portTable = ports.length ? `
      <h3>Ports</h3>
      <table class="data-table port-table"><thead><tr><th>Port</th><th>Service</th><th>State</th><th>Latency</th><th>Banner / error</th></tr></thead><tbody>
        ${ports.map((p) => `<tr>
          <td class="mono">${p.port}</td><td>${escapeHtml(p.service || '-')}</td>
          <td>${!p.row ? '<span class="badge badge-muted">Pending</span>' : p.row.is_up ? '<span class="badge badge-up">Open</span>' : '<span class="badge badge-down">Closed</span>'}</td>
          <td class="nowrap">${p.row && p.row.is_up ? fmtLatency(p.row.latency_ms) : '-'}</td>
          <td class="mono port-detail">${escapeHtml(p.row ? p.row.detail || p.row.error || '' : '')}</td></tr>`).join('')}
      </tbody></table>` : '';
    const ssl = latest.https && latest.https.ssl_valid_to
      ? `<div class="detail-row"><span>SSL certificate</span><span>${escapeHtml(latest.https.ssl_issuer)} &middot; expires
          ${new Date(latest.https.ssl_valid_to).toLocaleDateString()} (${latest.https.ssl_days_remaining}d)</span></div>`
      : '';

    $('#modal-body').innerHTML = `
      <div class="detail-grid">
        ${item('Status', `<span class="status ${base.cls}"><span class="status-dot"></span>${base.label}</span>`)}
        ${item('Check interval', `${host.intervalMinutes} min`)}
        ${item('URL', `<span class="mono">${escapeHtml(host.url || '-')}</span>`)}
        ${item('IP address', `<span class="mono">${escapeHtml(host.ip || '-')}</span>${host.ipAuto ? '<span class="tag">auto</span>' : ''}`)}
      </div>
      ${uptime}${ssl}${portTable}
      <h3>Latency (${days} days)</h3>`;
    try {
      await loadChartLib();
      renderDetailChart(history, ports);
    } catch (err) {
      reportError(`Chart library failed to load: ${err.message}`);
    }
  }

  // Chart.js is only needed for the host-detail graph, so it is loaded on first use (not at startup).
  let chartLibPromise = null;
  function loadChartLib() {
    if (typeof Chart !== 'undefined') return Promise.resolve();
    if (!chartLibPromise) {
      chartLibPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'js/chart.umd.js';
        s.onload = () => resolve();
        s.onerror = () => { chartLibPromise = null; reject(new Error('could not load js/chart.umd.js')); };
        document.head.appendChild(s);
      });
    }
    return chartLibPromise;
  }

  function cssColor(name, alpha = 1) {
    const hsl = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim().split(/\s+/).join(', ');
    return `hsla(${hsl}, ${alpha})`;
  }

  function renderDetailChart(history, ports = []) {
    const series = (match) => history
      .filter((r) => match(r) && r.latency_ms !== null)
      .map((r) => ({ x: r.timestamp, y: r.latency_ms }));
    const dataset = (label, data, color) => ({
      label,
      data,
      borderColor: cssColor(color),
      backgroundColor: cssColor(color, 0.12),
      borderWidth: 2,
      tension: 0.3,
      pointRadius: 0,
      fill: true,
    });
    if (state.detailChart) state.detailChart.destroy();
    state.detailChart = new Chart($('#modal-chart').getContext('2d'), {
      type: 'line',
      data: {
        datasets: [
          dataset('HTTP latency (ms)', series((r) => r.check_type === 'http' || r.check_type === 'https'), 'primary'),
          dataset('Ping latency (ms)', series((r) => r.check_type === 'ping'), 'success'),
          // First three ports with latency data, to keep the chart readable.
          ...ports
            .map((p) => ({ p, data: series((r) => r.check_type === 'tcp' && r.port === p.port) }))
            .filter((x) => x.data.length)
            .slice(0, 3)
            .map(({ p, data }, i) => dataset(`TCP ${p.port}${p.service ? ` ${p.service}` : ''} (ms)`, data, ['warning', 'muted-foreground', 'foreground'][i])),
        ].filter((d) => d.data.length),
      },
      options: {
        responsive: true,
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: { type: 'linear', display: false },
          y: { beginAtZero: true, ticks: { color: cssColor('muted-foreground') }, grid: { color: cssColor('border', 0.6) } },
        },
        plugins: {
          legend: { labels: { color: cssColor('foreground'), boxWidth: 12 } },
          tooltip: { callbacks: { title: (items) => new Date(items[0].parsed.x).toLocaleString() } },
        },
      },
    });
  }

  // ---------------- REPORTS & CONNECTIVITY TEST ----------------
  async function exportReport(scope, format) {
    try {
      const res = await window.api.exportReport(scope || 'all', format);
      if (res && res.filePath) toast(`Report saved: ${res.filePath}`, 'success', 6000);
    } catch (err) {
      toast(errMsg(err), 'error', 7000);
    }
  }

  async function downloadChartPng() {
    if (!state.detailChart) return toast('No chart to export yet', 'error');
    const name = `devoping-${(state.hostsById.get(state.detailHostId)?.name || 'host').replace(/[^a-z0-9_-]+/gi, '_')}-latency`;
    try {
      const res = await window.api.saveChartPng(name, state.detailChart.toBase64Image('image/png', 1));
      if (res && res.filePath) toast(`Image saved: ${res.filePath}`, 'success', 6000);
    } catch (err) {
      toast(errMsg(err), 'error', 7000);
    }
  }

  function wireTools() {
    $('#btn-tools').addEventListener('click', openTools);
    $('#tools-close-btn').addEventListener('click', () => $('#modal-tools').classList.add('hidden'));
    $('#modal-tools').addEventListener('click', (e) => {
      if (e.target.id === 'modal-tools') $('#modal-tools').classList.add('hidden');
    });
    $('#form-tools').addEventListener('submit', (e) => {
      e.preventDefault();
      runTools();
    });
    $('#status-filter').parentElement.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-report-all]');
      if (btn) exportReport('all', btn.dataset.reportAll);
    });
  }

  function openTools() {
    $('#tools-error').textContent = '';
    $('#tools-results').innerHTML = '';
    $('#modal-tools').classList.remove('hidden');
    $('#tools-target').focus();
  }

  async function runTools() {
    const errEl = $('#tools-error');
    const out = $('#tools-results');
    const btn = $('#tools-submit-btn');
    errEl.textContent = '';
    out.innerHTML = '<div class="spinner spinner-small"></div>';
    btn.disabled = true;
    try {
      const res = await window.api.testConnectivity($('#tools-target').value.trim(), $('#tools-ports').value.trim());
      out.innerHTML = renderToolsResult(res);
    } catch (err) {
      out.innerHTML = '';
      errEl.textContent = errMsg(err);
    } finally {
      btn.disabled = false;
    }
  }

  function toolBadge(ok, text) {
    return `<span class="badge ${ok ? 'badge-up' : 'badge-down'}">${escapeHtml(text)}</span>`;
  }

  function renderToolsResult(res) {
    const ms = (v) => (v == null ? '' : `${Math.round(v)} ms`);
    const rows = [];
    rows.push(`<div class="detail-row"><span>Target</span><span class="mono">${escapeHtml(res.host)}${res.resolvedIp && res.resolvedIp !== res.host ? ` &rarr; ${escapeHtml(res.resolvedIp)}` : ''}</span></div>`);
    if (res.http) {
      rows.push(`<div class="detail-row"><span>HTTP</span><span>${res.http.ok ? toolBadge(true, String(res.http.statusCode || 'OK')) : toolBadge(false, res.http.error || 'Failed')} ${escapeHtml(ms(res.http.latencyMs))}</span></div>`);
      if (res.http.ssl) rows.push(`<div class="detail-row"><span>SSL</span><span>${escapeHtml(res.http.ssl.issuer || '')} &middot; ${res.http.ssl.daysRemaining}d left</span></div>`);
    }
    const ping = res.ping || {};
    rows.push(`<div class="detail-row"><span>Ping</span><span>${ping.ok ? `${toolBadge(true, 'Reply')} ${escapeHtml(ms(ping.latencyMs))}` : toolBadge(false, ping.error || 'No reply')}</span></div>`);
    let portTable = '';
    if (res.ports && res.ports.length) {
      portTable = `<h3>Ports</h3><table class="data-table port-table"><thead><tr><th>Port</th><th>Service</th><th>State</th><th>Latency</th><th>Banner / error</th></tr></thead><tbody>${res.ports.map((p) => `<tr>
        <td class="mono">${p.port}</td><td>${escapeHtml(p.service || '-')}</td>
        <td>${p.ok ? toolBadge(true, 'Open') : toolBadge(false, 'Closed')}</td>
        <td class="nowrap">${p.ok ? escapeHtml(ms(p.latencyMs)) : '-'}</td>
        <td class="mono port-detail">${escapeHtml(p.banner || p.error || '')}</td></tr>`).join('')}</tbody></table>`;
    }
    return `<div class="detail-grid">${rows.join('')}</div>${portTable}`;
  }

  // ---------------- TELNET CONSOLE ----------------
  function refreshTelnetHosts() {
    const sel = $('#telnet-host');
    const prev = sel.value;
    sel.innerHTML = ['<option value="">— custom —</option>']
      .concat(state.hosts.map((h) => `<option value="${escapeHtml(h.id)}">${escapeHtml(h.name)}${h.url || h.ip ? ` — ${escapeHtml(h.url || h.ip)}` : ''}</option>`))
      .join('');
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  function telnetTargetFromHost(host) {
    if (!host) return '';
    if (host.ip) return host.ip;
    if (host.url) {
      try { return new URL(host.url).hostname; } catch { return host.url; }
    }
    return '';
  }

  function renderTelnetPresets(host) {
    const ports = [];
    if (host && Array.isArray(host.ports)) host.ports.forEach((p) => ports.push(p.port));
    if (host && host.pingPort) ports.push(host.pingPort);
    [23, 22, 80, 443, 3389].forEach((p) => { if (!ports.includes(p)) ports.push(p); });
    $('#telnet-port-presets').innerHTML = ports.map((p) => `<button type="button" class="chip" data-telnet-port="${p}">${p}</button>`).join('');
  }

  function appendTelnet(line) {
    const out = $('#telnet-output');
    const text = out.textContent + (out.textContent ? '\n' : '') + line;
    // Bounded so a long-running session doesn't grow the DOM (and memory) without limit.
    out.textContent = text.length > TELNET_MAX_CHARS ? text.slice(-TELNET_MAX_CHARS) : text;
    out.scrollTop = out.scrollHeight;
  }

  function setTelnetConnected(connected) {
    $('#telnet-connect-btn').disabled = connected;
    $('#telnet-disconnect-btn').disabled = !connected;
    $('#telnet-input').disabled = !connected;
    $('#telnet-send-btn').disabled = !connected;
  }

  async function loadTelnetHistoryOnce() {
    if (state.telnetLoaded) return;
    state.telnetLoaded = true;
    try {
      const text = await window.api.telnetHistory();
      if (text) {
        const out = $('#telnet-output');
        out.textContent = text.replace(/\n$/, '').slice(-TELNET_MAX_CHARS);
        out.scrollTop = out.scrollHeight;
      }
    } catch {
      // ignore
    }
  }

  function wireTelnet() {
    $('#telnet-host').addEventListener('change', (e) => {
      const host = state.hostsById.get(e.target.value);
      $('#telnet-target').value = telnetTargetFromHost(host);
      renderTelnetPresets(host);
    });
    $('#telnet-port-presets').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-telnet-port]');
      if (chip) $('#telnet-port').value = chip.dataset.telnetPort;
    });
    $('#form-telnet').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#telnet-error').textContent = '';
      try {
        const res = await window.api.telnetConnect($('#telnet-target').value.trim(), Number($('#telnet-port').value));
        state.telnetSessionId = res.sessionId;
        setTelnetConnected(true);
        $('#telnet-input').focus();
      } catch (err) {
        $('#telnet-error').textContent = errMsg(err);
      }
    });
    $('#telnet-disconnect-btn').addEventListener('click', () => {
      if (state.telnetSessionId) window.api.telnetDisconnect(state.telnetSessionId).catch(() => {});
    });
    $('#form-telnet-send').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#telnet-input');
      if (!state.telnetSessionId || !input.value) return;
      try {
        await window.api.telnetSend(state.telnetSessionId, input.value);
        input.value = '';
      } catch (err) {
        $('#telnet-error').textContent = errMsg(err);
      }
    });
    $('#btn-telnet-clear').addEventListener('click', async () => {
      if (!confirm('Clear the telnet history log? This permanently deletes the saved console history.')) return;
      try {
        await window.api.telnetClearHistory();
        $('#telnet-output').textContent = '';
        toast('Telnet history cleared');
      } catch (err) {
        toast(errMsg(err), 'error');
      }
    });
    $('#btn-telnet-log').addEventListener('click', () => window.api.openDataFolder().catch((err) => toast(errMsg(err), 'error')));

    window.api.onTelnetLine((entry) => { if (entry && entry.line) appendTelnet(entry.line); });
    window.api.onTelnetClosed((info) => {
      if (info && info.sessionId === state.telnetSessionId) {
        state.telnetSessionId = null;
        setTelnetConnected(false);
      }
    });
  }

  // ---------------- DNS LOOKUP MODAL ----------------
  function wireDnsModal() {
    $('#dns-close-btn').addEventListener('click', () => $('#modal-dns').classList.add('hidden'));
    $('#modal-dns').addEventListener('click', (e) => {
      if (e.target.id === 'modal-dns') $('#modal-dns').classList.add('hidden');
    });
    $('#form-dns').addEventListener('submit', (e) => {
      e.preventDefault();
      runDnsLookup();
    });
  }

  async function openDnsLookup(target) {
    const select = $('#dns-server');
    if (!select.options.length) {
      const servers = await window.api.dnsServers();
      select.innerHTML = servers
        .map((s) => `<option value="${escapeHtml(s.key)}"${s.isDefault ? ' selected' : ''}>${escapeHtml(s.label)}</option>`)
        .join('');
    }
    $('#dns-target').value = target || '';
    $('#modal-dns').classList.remove('hidden');
    if (target) runDnsLookup();
  }

  async function runDnsLookup() {
    const errEl = $('#dns-error');
    const out = $('#dns-results');
    const btn = $('#dns-submit-btn');
    errEl.textContent = '';
    out.innerHTML = '<div class="spinner spinner-small"></div>';
    btn.disabled = true;
    try {
      const res = await window.api.dnsLookup($('#dns-target').value.trim(), $('#dns-server').value);
      out.innerHTML = renderDnsResult(res);
    } catch (err) {
      out.innerHTML = '';
      errEl.textContent = errMsg(err);
    } finally {
      btn.disabled = false;
    }
  }

  function renderDnsResult(res) {
    const rows = res.sections.map((s) => {
      const status = s.error
        ? `<span class="badge badge-down">${escapeHtml(s.error)}</span>`
        : `<span class="muted-small">${escapeHtml(s.note || '')}</span>`;
      const values = s.records.length
        ? s.records.map((r) => `<div class="dns-value">${escapeHtml(r.value)}${r.ttl !== undefined ? ` <span class="muted-small">TTL ${r.ttl}</span>` : ''}</div>`).join('')
        : status;
      return `<tr><td><span class="badge badge-muted">${escapeHtml(s.type)}</span></td>
        <td class="dns-name">${escapeHtml(s.name)}</td><td>${values}</td><td class="muted-small dns-time">${s.ms} ms</td></tr>`;
    }).join('');

    const sys = res.system;
    const systemHtml = sys ? `
      <h3>OS resolver &amp; hosts file</h3>
      <div class="detail-row"><span>System lookup</span><span>${sys.addresses.length ? escapeHtml(sys.addresses.join(', ')) : escapeHtml(sys.error || '-')}</span></div>
      <div class="detail-row"><span>hosts file entries</span><span>${sys.hostsFile.length ? escapeHtml(sys.hostsFile.join(', ')) : 'None'}</span></div>` : '';

    const raw = res.raw;
    const rawHtml = raw.output !== undefined
      ? `<details class="dns-raw"><summary>Raw output (${escapeHtml(raw.tool)})</summary>
          <div class="muted-small">$ ${escapeHtml(raw.command)}</div><pre>${escapeHtml(raw.output)}</pre></details>`
      : `<p class="muted-small">Raw tool output unavailable: ${escapeHtml(raw.error)}</p>`;

    return `
      <div class="muted-small dns-meta">${escapeHtml(res.query)}${res.zone ? ` &middot; zone ${escapeHtml(res.zone)}` : ''}
        &middot; ${escapeHtml(res.server)} &middot; ${res.durationMs} ms</div>
      <table class="data-table dns-table"><thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Time</th></tr></thead>
        <tbody>${rows}</tbody></table>
      ${systemHtml}
      ${rawHtml}`;
  }

  // config.json was replaced on disk (e.g. copied from another PC) and reloaded by the main process.
  window.api.onConfigReloaded(async ({ signedIn } = {}) => {
    try {
      if (!signedIn) {
        state.unsubscribers.splice(0).forEach((off) => off());
        await bootstrap();
      } else {
        state.settings = await window.api.getSettings();
        if (state.settings.theme) applyTheme(state.settings.theme, false);
        fillSettingsForm(state.settings);
        setProfile(await window.api.currentUser());
        await Promise.all([refreshHosts(), refreshLatest(), refreshDomains()]);
        renderAll();
      }
      toast('Configuration reloaded from config.json', 'success', 6000);
    } catch (err) {
      reportError(`Config reload failed: ${err.stack || err}`);
    }
  });

  bootstrap().catch((err) => {
    reportError(`Startup failed: ${err.stack || err}`);
    $('#view-loading').innerHTML = `<div class="auth-card"><h1>Something went wrong</h1>
      <p class="muted">${escapeHtml(errMsg(err))}</p><p class="muted-small">Details were written to devoping_data/logs/devoping.log.</p></div>`;
  });
})();
