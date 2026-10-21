'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'planner_view';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const COMPARE_HMAC_KEY = 'health-path-planner-hmac-compare';
const VIEWER_LABEL = 'health-path-planner-viewer';
const AUTH_WINDOW_MS = 60 * 1000;
const AUTH_MAX_TRIES = 5;
const BASIC_REALM = 'Basic realm="Health Path Planner"';
const MISSING_PASSWORD_ERROR = 'Planner view is not configured.';
const PASSCODE_REQUIRED = 'Passcode required.';
const PASSCODE_INCORRECT = 'Passcode incorrect.';
const RATE_LIMIT_ERROR = 'Too many tries. Try again in a minute.';

const authAttempts = new Map();
let authNow = () => Date.now();

function viewPassword() {
  const raw = process.env.PLANNER_VIEW_PASSWORD;
  return raw == null || String(raw).trim() === '' ? '' : String(raw);
}

function passwordRequired() {
  return Boolean(viewPassword());
}

function failClosed() {
  return !passwordRequired();
}

function hmacDigest(value) {
  return crypto.createHmac('sha256', COMPARE_HMAC_KEY).update(String(value || '')).digest();
}

function tokensEqual(a, b) {
  return crypto.timingSafeEqual(hmacDigest(a), hmacDigest(b));
}

function viewerToken(password) {
  const pw = password == null ? viewPassword() : String(password);
  if (!pw) return '';
  return crypto.createHmac('sha256', pw).update(VIEWER_LABEL).digest('hex');
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
  return pruneAttempts(clientIp(req), authNow()).length >= AUTH_MAX_TRIES;
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
    let val = part.slice(idx + 1).trim();
    if (!key) return;
    try {
      val = decodeURIComponent(val);
    } catch {
      /* keep raw */
    }
    out[key] = val;
  });
  return out;
}

function cookieHeader(token, req) {
  const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || '');
  const secure = Boolean(req && req.secure) || proto.split(',')[0].trim() === 'https';
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/health-path-planner',
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

function hasBasicHeader(req) {
  const header = req && req.headers && (req.headers.authorization || req.headers.Authorization);
  return Boolean(header && /^Basic\s+/i.test(String(header)));
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

function isPlannerViewerAuthorized(req) {
  if (failClosed()) return false;
  if (cookieAuthorized(req)) return true;
  return passwordMatches(basicPassword(req));
}

module.exports = {
  AUTH_MAX_TRIES,
  AUTH_WINDOW_MS,
  BASIC_REALM,
  COOKIE_MAX_AGE,
  COOKIE_NAME,
  MISSING_PASSWORD_ERROR,
  PASSCODE_INCORRECT,
  PASSCODE_REQUIRED,
  RATE_LIMIT_ERROR,
  basicPassword,
  clientIp,
  consumeAuthAttempt,
  cookieAuthorized,
  cookieHeader,
  failClosed,
  hasBasicHeader,
  hmacDigest,
  isAuthRateLimited,
  isPlannerViewerAuthorized,
  parseCookies,
  passwordMatches,
  passwordRequired,
  resetAuthAttempts,
  setAuthNow,
  tokensEqual,
  viewerToken,
  viewPassword
};
