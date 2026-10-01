// Amazon S3 and S3-compatible storage (MinIO, Wasabi, Cloudflare R2, Backblaze B2, ...).
// Requests are signed with AWS Signature Version 4 using Node's crypto - no AWS SDK needed.
const crypto = require('crypto');
const { request } = require('../http');

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^[a-z0-9-]{2,32}$/;

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Pure SigV4 signer (exported for tests). headers must include `host`; returns the Authorization value.
function signV4({ method, canonicalUri, query = {}, headers, payloadHash, region, service = 's3', accessKeyId, secretAccessKey, amzDate }) {
  const date = amzDate.slice(0, 8);
  const canonicalQuery = Object.keys(query).sort().map((k) => `${rfc3986(k)}=${rfc3986(String(query[k]))}`).join('&');
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map((h) => `${h}:${lower[h]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
  return { authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, canonicalQuery };
}

function endpointFor(cfg) {
  return new URL(cfg.endpoint || `https://s3.${cfg.region}.amazonaws.com`);
}

function locate(cfg, key) {
  const ep = endpointFor(cfg);
  const keyPath = key ? key.split('/').map(rfc3986).join('/') : '';
  if (cfg.pathStyle) {
    return { origin: `${ep.protocol}//${ep.host}`, host: ep.host, canonicalUri: `/${cfg.bucket}${keyPath ? `/${keyPath}` : ''}` };
  }
  const host = `${cfg.bucket}.${ep.host}`;
  return { origin: `${ep.protocol}//${host}`, host, canonicalUri: `/${keyPath}` };
}

async function s3(ctx, { method, key = '', query = {}, body, expect = 'buffer', okStatuses }) {
  const cfg = ctx.config;
  const secretAccessKey = ctx.getSecret('secretAccessKey');
  if (!secretAccessKey) throw new Error('S3 secret access key is not set');
  const { origin, host, canonicalUri } = locate(cfg, key);
  const payloadHash = sha256hex(body || '');
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const { authorization, canonicalQuery } = signV4({
    method, canonicalUri, query, headers, payloadHash, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey, amzDate,
  });
  delete headers.host; // set by fetch itself
  return request(`${origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`, {
    method, body, expect, okStatuses, headers: { ...headers, authorization }, timeoutMs: 5 * 60 * 1000,
  });
}

const xmlDecode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const prefixOf = (cfg) => cfg.prefix || '';

module.exports = {
  id: 's3',
  label: 'Amazon S3 / S3-compatible',
  description: 'AWS S3 or any S3-compatible store (MinIO, Wasabi, Cloudflare R2, Backblaze B2). Uses an access key with s3:PutObject, s3:GetObject, s3:ListBucket and s3:DeleteObject on the bucket/prefix.',
  oauth: false,
  fields: [
    { key: 'bucket', label: 'Bucket', required: true, placeholder: 'my-devowatch-backups' },
    { key: 'region', label: 'Region', required: true, default: 'us-east-1', placeholder: 'us-east-1 (R2: auto)' },
    { key: 'prefix', label: 'Key prefix', default: 'devowatch/', placeholder: 'devowatch/' },
    { key: 'endpoint', label: 'Custom endpoint (S3-compatible only)', placeholder: 'https://s3.example.com' },
    { key: 'accessKeyId', label: 'Access key ID', required: true },
    { key: 'secretAccessKey', label: 'Secret access key', type: 'password', secret: true, required: true },
    { key: 'pathStyle', label: 'Path-style URLs (MinIO / dotted bucket names)', type: 'checkbox' },
  ],

  validate(cfg) {
    const out = {
      bucket: String(cfg.bucket || '').trim(),
      region: String(cfg.region || 'us-east-1').trim(),
      prefix: String(cfg.prefix ?? 'devowatch/').trim().replace(/^\/+/, ''),
      endpoint: String(cfg.endpoint || '').trim().replace(/\/+$/, ''),
      accessKeyId: String(cfg.accessKeyId || '').trim(),
      pathStyle: cfg.pathStyle === true,
    };
    if (!BUCKET_RE.test(out.bucket)) throw new Error('Invalid S3 bucket name');
    if (!REGION_RE.test(out.region)) throw new Error('Invalid region');
    if (!/^[A-Za-z0-9/+=._-]{8,128}$/.test(out.accessKeyId)) throw new Error('Invalid access key ID');
    if (out.prefix.length > 200 || /[\\\0]/.test(out.prefix)) throw new Error('Invalid key prefix');
    if (out.endpoint) {
      const u = new URL(out.endpoint);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('Endpoint must use https://');
      if (u.pathname !== '/' || u.search) throw new Error('Endpoint must not contain a path');
    }
    return out;
  },

  async test(ctx) {
    const items = await this.list(ctx);
    return { message: `Connected to bucket "${ctx.config.bucket}" (${items.length} DevoWatch backup${items.length === 1 ? '' : 's'})` };
  },

  async upload(ctx, name, buffer) {
    await s3(ctx, { method: 'PUT', key: prefixOf(ctx.config) + name, body: buffer, expect: 'none' });
  },

  async list(ctx) {
    const items = [];
    let token = null;
    do {
      const query = { 'list-type': '2', prefix: prefixOf(ctx.config), 'max-keys': '1000' };
      if (token) query['continuation-token'] = token;
      const xml = await s3(ctx, { method: 'GET', query, expect: 'text' });
      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
        const key = xmlDecode((block.match(/<Key>([\s\S]*?)<\/Key>/) || [])[1] || '');
        items.push({
          name: key.slice(prefixOf(ctx.config).length),
          size: Number((block.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0),
          modified: (block.match(/<LastModified>([^<]+)<\/LastModified>/) || [])[1] || null,
        });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlDecode((xml.match(/<NextContinuationToken>([^<]+)</) || [])[1] || '') : null;
    } while (token);
    return items.filter((i) => i.name && !i.name.includes('/'));
  },

  async download(ctx, name) {
    return s3(ctx, { method: 'GET', key: prefixOf(ctx.config) + name, expect: 'buffer' });
  },

  async remove(ctx, name) {
    await s3(ctx, { method: 'DELETE', key: prefixOf(ctx.config) + name, expect: 'none' });
  },

  signV4,
};
