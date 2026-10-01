// Registry of cloud backup providers. To add a provider, create a module in this folder that
// exports the interface below and add it to PROVIDERS.
//
// {
//   id, label, description,
//   oauth: boolean,                       // true -> UI shows Connect/Disconnect and calls connect()
//   fields: [{ key, label, required?, default?, placeholder?, type?: 'password'|'checkbox', secret? }],
//   validate(plainConfig) -> normalized non-secret config (throws on invalid input),
//   connect?(ctx) -> { account }          // OAuth sign-in; store tokens with ctx.setSecret()
//   test(ctx) -> { message },
//   upload(ctx, name, buffer), list(ctx) -> [{ name, size, modified }],
//   download(ctx, name) -> Buffer, remove(ctx, name)
// }
// ctx = { config, tokens (in-memory cache), getSecret(key), setSecret(key, value) }
// Secret fields are stored encrypted by the manager (secrets.js) and never land in config.json.
const PROVIDERS = [
  require('./s3'),
  require('./gdrive'),
  require('./onedrive'),
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

module.exports = {
  list: () => PROVIDERS,
  get: (id) => byId.get(id) || null,
};
