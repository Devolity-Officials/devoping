// Minimal HTTPS helper for backup providers (built-in fetch, timeouts, readable errors).
const DEFAULT_TIMEOUT_MS = 60 * 1000;

async function request(url, { method = 'GET', headers = {}, body, expect = 'json', timeoutMs = DEFAULT_TIMEOUT_MS, okStatuses = [] } = {}) {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok && !okStatuses.includes(res.status)) {
    const text = await res.text().catch(() => '');
    const detail = (text.match(/<Message>([^<]+)<\/Message>/) || [])[1]
      || safeJson(text)?.error?.message || safeJson(text)?.error_description || safeJson(text)?.error
      || text.slice(0, 200);
    const err = new Error(`${method} ${new URL(url).host} failed: HTTP ${res.status}${detail ? ` - ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  if (expect === 'none') return { status: res.status, headers: res.headers };
  if (expect === 'buffer') return Buffer.from(await res.arrayBuffer());
  if (expect === 'text') return res.text();
  if (expect === 'response') return res;
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function postForm(url, params) {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

module.exports = { request, postForm };
