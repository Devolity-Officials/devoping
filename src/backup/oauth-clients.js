// OAuth apps registered once by the DevoWatch publisher, so users only have to sign in.
// Desktop (installed-app) client IDs are public by design (RFC 8252), and Google documents that a
// "Desktop app" client secret is not confidential either. Leave a clientId empty to make users
// enter their own app registration in Backup & Sync instead.
module.exports = {
  google: { clientId: '', clientSecret: '' },
  microsoft: { clientId: '' },
};
