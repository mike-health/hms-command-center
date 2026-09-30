'use strict';

const path = require('path');
const {
  AUTH_WINDOW_MS,
  VIEWER_LOAD_ERROR,
  allowFixtureQuery,
  basicPassword,
  consumeAuthAttempt,
  cookieAuthorized,
  cookieHeader,
  failClosed,
  isAuthRateLimited,
  passwordMatches,
  passwordRequired,
  viewerToken
} = require('./ph-view-gate');
const { getPleasantHillBoard } = require('./pleasant-hill');

const BASIC_REALM = 'Basic realm="Pleasant Hill"';

function gatedPayload() {
  return {
    success: false,
    configured: true,
    source: 'gated',
    message: VIEWER_LOAD_ERROR,
    issues: [],
    phases: [],
    thisWeek: [],
    late: [],
    gates: []
  };
}

function sendUnauthorized(res) {
  res.setHeader('WWW-Authenticate', BASIC_REALM);
  return res.status(401).json({
    success: false,
    source: 'auth',
    message: 'Passcode required.'
  });
}

function sendRateLimited(res) {
  res.setHeader('Retry-After', String(Math.ceil(AUTH_WINDOW_MS / 1000)));
  return res.status(429).json({
    success: false,
    source: 'auth',
    message: 'Too many tries. Try again in a minute.'
  });
}

function hasBasicHeader(req) {
  const header = req && req.headers && (req.headers.authorization || req.headers.Authorization);
  return Boolean(header && /^Basic\s+/i.test(String(header)));
}

function mountPleasantHill(app, options) {
  const publicDir = (options && options.publicDir) || path.join(__dirname, '..', 'public');
  const pagePath = path.join(publicDir, 'modules', 'pleasant-hill.html');

  app.post('/api/pleasant-hill/unlock', (req, res) => {
    if (!passwordRequired()) {
      return res.status(400).json({ success: false, source: 'auth', message: VIEWER_LOAD_ERROR });
    }
    if (isAuthRateLimited(req) || !consumeAuthAttempt(req)) {
      return sendRateLimited(res);
    }
    const body = req.body || {};
    const candidate = body.password != null ? body.password : body.passcode;
    if (!passwordMatches(candidate)) {
      return res.status(401).json({ success: false, source: 'auth', message: 'Passcode incorrect.' });
    }
    res.setHeader('Set-Cookie', cookieHeader(viewerToken(), req));
    return res.json({ success: true, source: 'auth' });
  });

  app.get('/api/pleasant-hill', async (req, res) => {
    try {
      if (failClosed()) {
        console.error('PH_VIEW_PASSWORD missing; refusing live Linear');
        return res.status(503).json(gatedPayload());
      }
      if (passwordRequired()) {
        if (cookieAuthorized(req)) {
          /* remembered cookie */
        } else if (hasBasicHeader(req)) {
          if (isAuthRateLimited(req) || !consumeAuthAttempt(req)) {
            return sendRateLimited(res);
          }
          if (!passwordMatches(basicPassword(req))) {
            return sendUnauthorized(res);
          }
        } else {
          return sendUnauthorized(res);
        }
      }
      const fixtureRequested = req.query.fixture === '1' || req.query.fixture === 'true';
      const fixture = fixtureRequested && allowFixtureQuery();
      const now = req.query.now || undefined;
      const board = await getPleasantHillBoard({ fixture, now });
      res.json({ success: true, ...board });
    } catch (err) {
      console.error('Pleasant Hill fetch failed:', err && err.message);
      res.json({
        success: true,
        configured: Boolean(process.env.LINEAR_API_KEY),
        source: process.env.LINEAR_API_KEY ? 'error' : 'unconfigured',
        message: VIEWER_LOAD_ERROR,
        issues: [],
        phases: [],
        thisWeek: [],
        late: [],
        gates: []
      });
    }
  });

  app.get('/modules/pleasant-hill.html', (req, res) => {
    res.sendFile(pagePath);
  });
}

module.exports = { BASIC_REALM, gatedPayload, mountPleasantHill };
