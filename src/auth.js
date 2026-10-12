// Local login for the desktop app. Passwords are hashed with bcrypt and stored in config.json.
const bcrypt = require('bcryptjs');
const config = require('./config');
const log = require('./logger');

const SALT_ROUNDS = 10;
const MAX_FAILURES = 5;
const BASE_LOCK_MS = 30 * 1000;
const MAX_LOCK_MS = 15 * 60 * 1000;
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

// Everything about the account except the password hash.
function publicProfile(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return { role: 'Administrator', loginCount: 0, ...rest };
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
  return publicProfile(config.updateUser(user.username, {
    previousLoginAt: user.lastLoginAt || null,
    lastLoginAt: new Date().toISOString(),
    loginCount: (Number(user.loginCount) || 0) + 1,
  }));
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

module.exports = { needsSetup, createFirstUser, login, changePassword, getProfile, updateProfile };
