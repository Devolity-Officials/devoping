// Local login for the desktop app. Passwords are hashed with bcrypt and stored in config.json.
const bcrypt = require('bcryptjs');
const config = require('./config');
const log = require('./logger');

const SALT_ROUNDS = 10;
const MAX_FAILURES = 5;
const BASE_LOCK_MS = 30 * 1000;
const MAX_LOCK_MS = 15 * 60 * 1000;
const PIN_RE = /^\d{4,8}$/;
// A PIN has little entropy: after this many wrong PINs (across restarts) it is removed and the password is required.
const MAX_PIN_FAILURES = 10;
// Compared against when the user doesn't exist, so response time doesn't reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('devoping-dummy-password', SALT_ROUNDS);

const failures = new Map(); // lower-cased username -> { count, lockMs, lockedUntil }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+0-9 ().-]*$/;
// Editable profile fields: max length and optional format check.
const PROFILE_FIELDS = {
  displayName: { label: 'Full name', max: 80 },
  email: { label: 'Email', max: 254, re: EMAIL_RE, msg: 'Enter a valid email address' },
  phone: { label: 'Phone', max: 40, re: PHONE_RE, msg: 'Phone may only contain digits, spaces and + ( ) - .' },
  organization: { label: 'Organization', max: 100 },
  jobTitle: { label: 'Job title', max: 100 },
  department: { label: 'Department', max: 100 },
  location: { label: 'Location', max: 100 },
};

function cleanProfile(patch = {}) {
  const out = {};
  for (const [key, rule] of Object.entries(PROFILE_FIELDS)) {
    if (!(key in patch)) continue;
    const value = typeof patch[key] === 'string' ? patch[key].trim() : '';
    if (value.length > rule.max) throw new Error(`${rule.label} is too long (max ${rule.max} characters)`);
    if (value && rule.re && !rule.re.test(value)) throw new Error(rule.msg);
    out[key] = value;
  }
  return out;
}

// Everything about the account except the password and PIN hashes.
function publicProfile(user) {
  if (!user) return null;
  const { passwordHash, pinHash, pinFailures, ...rest } = user;
  return { role: 'Administrator', loginCount: 0, ...rest, hasPin: Boolean(pinHash) };
}

function requireString(value, name, max) {
  if (typeof value !== 'string' || !value || value.length > max) {
    throw new Error(`${name} is required (max ${max} characters)`);
  }
  return value;
}

function assertNotLocked(key) {
  const f = failures.get(key);
  if (f && f.lockedUntil > Date.now()) {
    throw new Error(`Too many failed sign-in attempts. Try again in ${Math.ceil((f.lockedUntil - Date.now()) / 1000)}s.`);
  }
}

function recordFailure(key) {
  const f = failures.get(key) || { count: 0, lockMs: 0, lockedUntil: 0 };
  f.count++;
  if (f.count >= MAX_FAILURES) {
    f.lockMs = Math.min(f.lockMs ? f.lockMs * 2 : BASE_LOCK_MS, MAX_LOCK_MS);
    f.lockedUntil = Date.now() + f.lockMs;
    f.count = 0;
    log.warn(`Sign-in locked for "${key}" for ${f.lockMs / 1000}s after repeated failures`);
  }
  failures.set(key, f);
}

function needsSetup() {
  return !config.hasUsers();
}

async function createFirstUser(username, password, profile = {}) {
  if (config.hasUsers()) {
    throw new Error('Setup already completed');
  }
  username = requireString(typeof username === 'string' ? username.trim() : username, 'Username', 64);
  requireString(password, 'Password', 128);
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters');
  }
  const details = cleanProfile(profile);
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  log.info(`Administrator account "${username}" created`);
  const now = new Date().toISOString();
  return publicProfile(config.addUser({
    username, passwordHash, role: 'Administrator', ...details, createdAt: now, lastLoginAt: now, loginCount: 1,
  }));
}

async function login(username, password) {
  requireString(username, 'Username', 64);
  requireString(password, 'Password', 128);
  const key = username.toLowerCase();
  assertNotLocked(key);
  const user = config.findUser(username);
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) {
    recordFailure(key);
    log.warn(`Failed sign-in for "${username}"`);
    throw new Error('Invalid username or password');
  }
  failures.delete(key);
  log.info(`User "${user.username}" signed in`);
  return recordLogin(user);
}

function recordLogin(user, extra = {}) {
  return publicProfile(config.updateUser(user.username, {
    previousLoginAt: user.lastLoginAt || null,
    lastLoginAt: new Date().toISOString(),
    loginCount: (Number(user.loginCount) || 0) + 1,
    ...extra,
  }));
}

async function loginWithPin(username, pin) {
  requireString(username, 'Username', 64);
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) throw new Error('PIN must be 4-8 digits');
  const key = `pin|${username.toLowerCase()}`;
  assertNotLocked(key);
  const user = config.findUser(username);
  const ok = await bcrypt.compare(pin, user && user.pinHash ? user.pinHash : DUMMY_HASH);
  if (!user || !user.pinHash || !ok) {
    recordFailure(key);
    log.warn(`Failed PIN sign-in for "${username}"`);
    if (user && user.pinHash) {
      const count = (Number(user.pinFailures) || 0) + 1;
      if (count >= MAX_PIN_FAILURES) {
        config.updateUser(user.username, { pinHash: undefined, pinFailures: undefined });
        log.warn(`PIN sign-in disabled for "${user.username}" after ${count} wrong PINs`);
        throw new Error('Too many wrong PINs. PIN sign-in has been turned off - sign in with your password.');
      }
      config.updateUser(user.username, { pinFailures: count });
    }
    throw new Error('Invalid username or PIN');
  }
  failures.delete(key);
  log.info(`User "${user.username}" signed in with PIN`);
  return recordLogin(user, { pinFailures: undefined });
}

// Setting or changing the PIN requires the account password.
async function setPin(username, password, pin) {
  requireString(password, 'Password', 128);
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) throw new Error('PIN must be 4-8 digits');
  if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
    throw new Error('Choose a less predictable PIN (no repeated or sequential digits)');
  }
  const key = username.toLowerCase();
  assertNotLocked(key);
  const user = config.findUser(username);
  if (!user) throw new Error('User not found');
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    recordFailure(key);
    throw new Error('Password is incorrect');
  }
  const pinHash = await bcrypt.hash(pin, SALT_ROUNDS);
  log.info(`PIN sign-in ${user.pinHash ? 'changed' : 'enabled'} for "${user.username}"`);
  return publicProfile(config.updateUser(user.username, { pinHash, pinFailures: undefined, pinSetAt: new Date().toISOString() }));
}

function removePin(username) {
  const user = config.findUser(username);
  if (!user) throw new Error('User not found');
  log.info(`PIN sign-in removed for "${user.username}"`);
  return publicProfile(config.updateUser(user.username, { pinHash: undefined, pinFailures: undefined, pinSetAt: undefined }));
}

async function changePassword(username, oldPassword, newPassword) {
  requireString(oldPassword, 'Current password', 128);
  requireString(newPassword, 'New password', 128);
  const key = username.toLowerCase();
  assertNotLocked(key);
  const user = config.findUser(username);
  if (!user) throw new Error('User not found');
  const ok = await bcrypt.compare(oldPassword, user.passwordHash);
  if (!ok) {
    recordFailure(key);
    throw new Error('Current password is incorrect');
  }
  if (newPassword.length < 6) {
    throw new Error('New password must be at least 6 characters');
  }
  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  config.updateUser(username, { passwordHash, passwordChangedAt: new Date().toISOString() });
  log.info(`Password changed for "${user.username}"`);
  return true;
}

function getProfile(username) {
  return publicProfile(config.findUser(username));
}

function updateProfile(username, patch) {
  const details = cleanProfile(patch && typeof patch === 'object' ? patch : {});
  return publicProfile(config.updateUser(username, { ...details, profileUpdatedAt: new Date().toISOString() }));
}

module.exports = { needsSetup, createFirstUser, login, loginWithPin, setPin, removePin, changePassword, getProfile, updateProfile };
