'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'ph_view';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const VIEWER_LOAD_ERROR = 'The schedule could not be loaded. Try again later.';

function viewPassword() {
  const raw = process.env.PH_VIEW_PASSWORD;
  return raw == null || String(raw).trim() === '' ? '' : String(raw);
}

function linearKeySet() {
  return Boolean(process.env.LINEAR_API_KEY);
}

function isProduction(options) {
  if (options && options.production !== undefined) return Boolean(options.production);
  return process.env.NODE_ENV === 'production';
}

function failClosed() {
  return linearKeySet() && !viewPassword();
}

function passwordRequired() {
  return Boolean(viewPassword());
}

const COMPARE_HMAC_KEY = 'pleasant-hill-hmac-compare';
const AUTH_WINDOW_MS = 60 * 1000;
const AUTH_MAX_TRIES = 5;
const authAttempts = new Map();
let authNow = () => Date.now();

function viewerToken(password) {
  const pw = password == null ? viewPassword() : String(password);
  if (!pw) return '';
  return crypto.createHmac('sha256', pw).update('pleasant-hill-viewer').digest('hex');
}

function hmacDigest(value) {
  return crypto.createHmac('sha256', COMPARE_HMAC_KEY).update(String(value || '')).digest();
}

function tokensEqual(a, b) {
  return crypto.timingSafeEqual(hmacDigest(a), hmacDigest(b));
}

function clientIp(req) {
  const xf = req && req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']);
  if (xf) return String(xf).split(',')[0].trim() || 'unknown';
  const addr = req && req.socket && req.socket.remoteAddress;
  return addr || 'unknown';
}

function pruneAttempts(ip, now) {
  const list = (authAttempts.get(ip) || []).filter((t) => now - t < AUTH_WINDOW_MS);
  authAttempts.set(ip, list);
  return list;
}

function isAuthRateLimited(req) {
  const list = pruneAttempts(clientIp(req), authNow());
  return list.length >= AUTH_MAX_TRIES;
}

function consumeAuthAttempt(req) {
  const ip = clientIp(req);
  const now = authNow();
  const list = pruneAttempts(ip, now);
  if (list.length >= AUTH_MAX_TRIES) return false;
  list.push(now);
  authAttempts.set(ip, list);
  return true;
}

function resetAuthAttempts() {
  authAttempts.clear();
}

function setAuthNow(fn) {
  authNow = typeof fn === 'function' ? fn : () => Date.now();
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function cookieHeader(token, req) {
  const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || '');
  const secure = Boolean(req && req.secure) || proto.split(',')[0].trim() === 'https';
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE}`,
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function basicPassword(req) {
  const header = req && req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!header || !/^Basic\s+/i.test(String(header))) return '';
  try {
    const decoded = Buffer.from(String(header).replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    return idx === -1 ? decoded : decoded.slice(idx + 1);
  } catch {
    return '';
  }
}

function cookieAuthorized(req) {
  const token = parseCookies(req && req.headers && req.headers.cookie)[COOKIE_NAME];
  const expected = viewerToken();
  return Boolean(expected && tokensEqual(token, expected));
}

function passwordMatches(candidate) {
  const pw = viewPassword();
  if (!pw) return false;
  return tokensEqual(candidate == null ? '' : candidate, pw);
}

function isPhViewerAuthorized(req) {
  if (!passwordRequired()) return !failClosed();
  if (cookieAuthorized(req)) return true;
  return passwordMatches(basicPassword(req));
}

function allowFixtureQuery(options) {
  return !isProduction(options);
}

module.exports = {
  AUTH_MAX_TRIES,
  AUTH_WINDOW_MS,
  COOKIE_NAME,
  COOKIE_MAX_AGE,
  VIEWER_LOAD_ERROR,
  allowFixtureQuery,
  basicPassword,
  clientIp,
  consumeAuthAttempt,
  cookieAuthorized,
  cookieHeader,
  failClosed,
  hmacDigest,
  isAuthRateLimited,
  isPhViewerAuthorized,
  isProduction,
  linearKeySet,
  parseCookies,
  passwordMatches,
  passwordRequired,
  resetAuthAttempts,
  setAuthNow,
  tokensEqual,
  viewerToken,
  viewPassword
};
