// Copies chart.js's bundled UMD build into renderer/js so the dashboard can load it
// with a plain <script> tag (no bundler, keeps CSP simple with script-src 'self').
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const destDir = path.join(__dirname, '..', 'renderer', 'js');
const dest = path.join(destDir, 'chart.umd.js');

if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

if (fs.existsSync(src)) {
  fs.copyFileSync(src, dest);
  console.log('Copied chart.umd.js into renderer/js');
} else {
  console.warn('chart.js not found in node_modules yet - run npm install first.');
}
