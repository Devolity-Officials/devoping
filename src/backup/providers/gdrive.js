// Google Drive via OAuth 2.0 (desktop/installed-app client). Scope `drive.file` only lets
// DevoWatch see files it created itself - it cannot read the rest of the user's Drive.
const { authorize } = require('../oauth');
const { request, postForm } = require('../http');
const { google: BUILT_IN } = require('../oauth-clients');

const builtIn = Boolean(BUILT_IN.clientId);

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function clientSecret(ctx) {
  return builtIn && ctx.config.clientId === BUILT_IN.clientId ? BUILT_IN.clientSecret : ctx.getSecret('clientSecret') || '';
}

async function accessToken(ctx) {
  if (ctx.tokens.access && ctx.tokens.expiresAt > Date.now() + 60000) return ctx.tokens.access;
  const refreshToken = ctx.getSecret('refreshToken');
  if (!refreshToken) throw new Error('Google Drive is not connected. Click "Sign in" first.');
  const tok = await postForm(TOKEN_URL, {
    client_id: ctx.config.clientId,
    client_secret: clientSecret(ctx),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  ctx.tokens.access = tok.access_token;
  ctx.tokens.expiresAt = Date.now() + (tok.expires_in || 3600) * 1000;
  return tok.access_token;
}

async function api(ctx, url, opts = {}) {
  const token = await accessToken(ctx);
  return request(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
}

async function folderId(ctx) {
  if (ctx.tokens.folderId) return ctx.tokens.folderId;
  const name = ctx.config.folderName;
  const query = `name='${q(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const found = await api(ctx, `${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&spaces=drive`);
  ctx.tokens.folderId = found.files && found.files[0]
    ? found.files[0].id
    : (await api(ctx, `${API}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    })).id;
  return ctx.tokens.folderId;
}

async function fileId(ctx, name) {
  const query = `name='${q(name)}' and '${await folderId(ctx)}' in parents and trashed=false`;
  const res = await api(ctx, `${API}/files?q=${encodeURIComponent(query)}&fields=files(id)`);
  if (!res.files || !res.files[0]) throw new Error(`Backup "${name}" not found in Google Drive`);
  return res.files[0].id;
}

module.exports = {
  id: 'gdrive',
  label: 'Google Drive',
  description: builtIn
    ? 'Sign in with your Google account. Backups go to a "DevoWatch Backups" folder in your Drive; DevoWatch can only see files it created.'
    : 'Stores backups in a "DevoWatch Backups" folder in your Google Drive. Requires an OAuth client ID of type "Desktop app" from Google Cloud Console (see README).',
  oauth: true,
  signInLabel: builtIn ? 'Sign in with Google' : 'Connect',
  fields: [
    ...(builtIn ? [] : [
      { key: 'clientId', label: 'OAuth client ID', required: true, placeholder: '1234-abc.apps.googleusercontent.com' },
      { key: 'clientSecret', label: 'OAuth client secret', type: 'password', secret: true, required: true },
    ]),
    { key: 'folderName', label: 'Drive folder', default: 'DevoWatch Backups' },
  ],

  validate(cfg) {
    const out = {
      clientId: builtIn ? BUILT_IN.clientId : String(cfg.clientId || '').trim(),
      folderName: String(cfg.folderName || 'DevoWatch Backups').trim().slice(0, 100),
      account: cfg.account || null,
    };
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(out.clientId)) throw new Error('Invalid Google OAuth client ID');
    if (!out.folderName) throw new Error('Folder name is required');
    return out;
  },

  async connect(ctx) {
    const { code, verifier, redirectUri } = await authorize(AUTH_URL, {
      client_id: ctx.config.clientId, scope: SCOPE, access_type: 'offline', prompt: 'consent',
    });
    const tok = await postForm(TOKEN_URL, {
      client_id: ctx.config.clientId,
      client_secret: clientSecret(ctx),
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    if (!tok.refresh_token) throw new Error('Google did not return a refresh token; remove DevoWatch from your Google account permissions and sign in again.');
    ctx.setSecret('refreshToken', tok.refresh_token);
    Object.assign(ctx.tokens, { access: tok.access_token, expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 });
    const about = await api(ctx, `${API}/about?fields=user(emailAddress)`);
    return { account: about.user && about.user.emailAddress };
  },

  async test(ctx) {
    const items = await this.list(ctx);
    return { message: `Connected to Google Drive folder "${ctx.config.folderName}" (${items.length} backup${items.length === 1 ? '' : 's'})` };
  },

  async upload(ctx, name, buffer) {
    const parent = await folderId(ctx);
    const token = await accessToken(ctx);
    const init = await request(`${UPLOAD_API}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      expect: 'none',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/octet-stream',
        'X-Upload-Content-Length': String(buffer.length),
      },
      body: JSON.stringify({ name, parents: [parent] }),
    });
    const location = init.headers.get('location');
    if (!location || !location.startsWith(`${UPLOAD_API}/`)) throw new Error('Google Drive did not return an upload URL');
    await request(location, { method: 'PUT', expect: 'json', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer, timeoutMs: 10 * 60 * 1000 });
  },

  async list(ctx) {
    const query = `'${await folderId(ctx)}' in parents and trashed=false`;
    const items = [];
    let pageToken = '';
    do {
      const res = await api(ctx, `${API}/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(name,size,modifiedTime)&pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      (res.files || []).forEach((f) => items.push({ name: f.name, size: Number(f.size || 0), modified: f.modifiedTime }));
      pageToken = res.nextPageToken || '';
    } while (pageToken);
    return items;
  },

  async download(ctx, name) {
    return api(ctx, `${API}/files/${await fileId(ctx, name)}?alt=media`, { expect: 'buffer', timeoutMs: 10 * 60 * 1000 });
  },

  async remove(ctx, name) {
    await api(ctx, `${API}/files/${await fileId(ctx, name)}`, { method: 'DELETE', expect: 'none' });
  },
};
