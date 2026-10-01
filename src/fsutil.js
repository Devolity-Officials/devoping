// Crash-safe file writes: write to a temp file, fsync, then rename over the target, so a crash or
// power loss leaves either the old or the new file - never a half-written one.
const fs = require('fs');

const RETRIES = 5;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Antivirus/indexers on Windows can briefly lock the target; retry the rename.
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      if (attempt >= RETRIES || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw err;
      }
      sleepSync(50 * attempt);
    }
  }
}

// Moves a damaged file aside (kept for diagnosis) and returns the new name.
function quarantine(filePath) {
  const target = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.renameSync(filePath, target);
  return target;
}

module.exports = { writeFileAtomic, quarantine };
