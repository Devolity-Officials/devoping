// Microsoft OneDrive (personal) and OneDrive for Business via Microsoft Graph + OAuth 2.0 PKCE
// (public client - no client secret). Backups go to a folder in the user's OneDrive root.
const { authorize } = require('../oauth');
const { request, postForm } = require('../http');
const { microsoft: BUILT_IN } = require('../oauth-clients');

const builtIn = Boolean(BUILT_IN.clientId);

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'offline_access Files.ReadWrite User.Read';
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
const CHUNK = 10 * 327680; // Graph requires multiples of 320 KiB

const authority = (cfg) => `https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0`;
const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
const itemUrl = (cfg, name) => `${GRAPH}/me/drive/root:/${enc(cfg.folder)}/${encodeURIComponent(name)}`;

function storeTokens(ctx, tok) {
  // Microsoft rotates refresh tokens; always keep the newest one.
  if (tok.refresh_token) ctx.setSecret('refreshToken', tok.refresh_token);
  Object.assign(ctx.tokens, { access: tok.access_token, expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 });
}

async function accessToken(ctx) {
  if (ctx.tokens.access && ctx.tokens.expiresAt > Date.now() + 60000) return ctx.tokens.access;
  const refreshToken = ctx.getSecret('refreshToken');
  if (!refreshToken) throw new Error('OneDrive is not connected. Click "Sign in" first.');
  storeTokens(ctx, await postForm(`${authority(ctx.config)}/token`, {
    client_id: ctx.config.clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPE,
  }));
  return ctx.tokens.access;
}

async function api(ctx, url, opts = {}) {
  const token = await accessToken(ctx);
  return request(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
}

module.exports = {
  id: 'onedrive',
  label: 'Microsoft OneDrive',
  description: builtIn
    ? 'Sign in with your Microsoft account (personal or work/school). Backups go to a folder in your OneDrive.'
    : 'Stores backups in a OneDrive folder (personal or work/school account). Requires an Azure / Entra ID app registration (public client, redirect URI http://127.0.0.1 - see README).',
  oauth: true,
  signInLabel: builtIn ? 'Sign in with Microsoft' : 'Connect',
  fields: [
    ...(builtIn ? [] : [
      { key: 'clientId', label: 'Application (client) ID', required: true, placeholder: '00000000-0000-0000-0000-000000000000' },
      { key: 'tenant', label: 'Tenant', default: 'common', placeholder: 'common, organizations or your tenant ID' },
    ]),
    { key: 'folder', label: 'OneDrive folder', default: 'Apps/DevoWatch' },
  ],

  validate(cfg) {
    const out = {
      clientId: builtIn ? BUILT_IN.clientId : String(cfg.clientId || '').trim(),
      tenant: builtIn ? 'common' : String(cfg.tenant || 'common').trim(),
      folder: String(cfg.folder || 'Apps/DevoWatch').trim().replace(/^\/+|\/+$/g, ''),
      account: cfg.account || null,
    };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(out.clientId)) throw new Error('Invalid application (client) ID');
    if (!/^[a-z0-9.-]{1,100}$/i.test(out.tenant)) throw new Error('Invalid tenant');
    if (!out.folder || out.folder.length > 200 || /[\\:*?"<>|]|\.\./.test(out.folder)) throw new Error('Invalid folder');
    return out;
  },

  async connect(ctx) {
    const { code, verifier, redirectUri } = await authorize(`${authority(ctx.config)}/authorize`, {
      client_id: ctx.config.clientId, scope: SCOPE, prompt: 'select_account',
    });
    storeTokens(ctx, await postForm(`${authority(ctx.config)}/token`, {
      client_id: ctx.config.clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri, scope: SCOPE,
    }));
    const me = await api(ctx, `${GRAPH}/me?$select=userPrincipalName,mail`);
    return { account: me.mail || me.userPrincipalName };
  },

  async test(ctx) {
    const items = await this.list(ctx);
    return { message: `Connected to OneDrive folder "${ctx.config.folder}" (${items.length} backup${items.length === 1 ? '' : 's'})` };
  },

  async upload(ctx, name, buffer) {
    const url = itemUrl(ctx.config, name);
    if (buffer.length <= SIMPLE_UPLOAD_LIMIT) {
      await api(ctx, `${url}:/content`, { method: 'PUT', body: buffer, headers: { 'Content-Type': 'application/octet-stream' } });
      return;
    }
    const session = await api(ctx, `${url}:/createUploadSession`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    });
    // The upload URL is pre-authenticated; sending the bearer token to it is not allowed.
    for (let start = 0; start < buffer.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, buffer.length);
      await request(session.uploadUrl, {
        method: 'PUT',
        expect: 'none',
        body: buffer.subarray(start, end),
        headers: { 'Content-Range': `bytes ${start}-${end - 1}/${buffer.length}` },
        timeoutMs: 5 * 60 * 1000,
      });
    }
  },

  async list(ctx) {
    const items = [];
    let url = `${GRAPH}/me/drive/root:/${enc(ctx.config.folder)}:/children?$select=name,size,lastModifiedDateTime,file&$top=200`;
    while (url) {
      let res;
      try {
        res = await api(ctx, url);
      } catch (err) {
        if (err.status === 404) return []; // folder is created on first upload
        throw err;
      }
      (res.value || []).filter((i) => i.file).forEach((i) => items.push({ name: i.name, size: i.size, modified: i.lastModifiedDateTime }));
      url = res['@odata.nextLink'] || null;
    }
    return items;
  },

  async download(ctx, name) {
    return api(ctx, `${itemUrl(ctx.config, name)}:/content`, { expect: 'buffer', timeoutMs: 10 * 60 * 1000 });
  },

  async remove(ctx, name) {
    await api(ctx, itemUrl(ctx.config, name), { method: 'DELETE', expect: 'none' });
  },
};
