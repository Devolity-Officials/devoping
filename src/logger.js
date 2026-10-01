// Small rotating file logger (data/logs/devowatch.log, 2 MB x 3 files). Never log secrets.
const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_FILES = 3;

let file = null;
let size = 0;

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'devowatch.log');
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch (err) {
    file = null;
    console.error('Logger disabled:', err.message);
  }
}

function rotate() {
  const oldest = `${file}.${KEEP_FILES}`;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  for (let i = KEEP_FILES - 1; i >= 1; i--) {
    if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
  size = 0;
}

function write(level, args) {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${util.format(...args)}\n`;
  (level === 'error' ? console.error : console.log)(line.trimEnd());
  if (!file) return;
  try {
    if (size + line.length > MAX_BYTES && size > 0) rotate();
    fs.appendFileSync(file, line);
    size += Buffer.byteLength(line);
  } catch {
    // logging must never take the app down
  }
}

module.exports = {
  init,
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
};
