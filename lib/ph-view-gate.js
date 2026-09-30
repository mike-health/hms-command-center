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

function viewerToken(password) {
  const pw = password == null ? viewPassword() : String(password);
  if (!pw) return '';
  return crypto.createHmac('sha256', pw).update('pleasant-hill-viewer').digest('hex');
}

function tokensEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
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
  if (!pw || candidate == null) return false;
  return tokensEqual(candidate, pw);
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
  COOKIE_NAME,
  COOKIE_MAX_AGE,
  VIEWER_LOAD_ERROR,
  allowFixtureQuery,
  basicPassword,
  cookieHeader,
  failClosed,
  isPhViewerAuthorized,
  isProduction,
  linearKeySet,
  parseCookies,
  passwordMatches,
  passwordRequired,
  tokensEqual,
  viewerToken,
  viewPassword
};
