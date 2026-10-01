// OAuth 2.0 authorization-code flow for desktop apps (RFC 8252): opens the system browser and
// receives the redirect on a one-shot listener bound to 127.0.0.1 only, protected by PKCE + state.
const http = require('http');
const crypto = require('crypto');
const { shell } = require('electron');

const TIMEOUT_MS = 5 * 60 * 1000;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function page(title, message) {
  return `<!doctype html><meta charset="utf-8"><title>DevoWatch</title>
<body style="font-family:Segoe UI,system-ui,sans-serif;background:#0f1115;color:#eef0f4;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>${title}</h2><p style="color:#949aa8">${message}</p></div></body>`;
}

// Returns { code, verifier, redirectUri } after the user signs in.
async function authorize(authUrl, params) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}`;

  const url = new URL(authUrl);
  Object.entries({
    ...params,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).forEach(([k, v]) => url.searchParams.set(k, v));

  const codePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sign-in timed out')), TIMEOUT_MS);
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get('code');
      const ok = code && u.searchParams.get('state') === state;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(ok
        ? page('Signed in to DevoWatch', 'You can close this tab and return to the app.')
        : page('Sign-in failed', 'Return to DevoWatch and try again.'));
      clearTimeout(timer);
      if (ok) resolve(code);
      else reject(new Error(u.searchParams.get('error_description') || u.searchParams.get('error') || 'Invalid sign-in response'));
    });
  });

  try {
    await shell.openExternal(url.toString());
    return { code: await codePromise, verifier, redirectUri };
  } finally {
    server.close();
  }
}

module.exports = { authorize };
