'use strict';

const path = require('path');
const {
  VIEWER_LOAD_ERROR,
  allowFixtureQuery,
  cookieHeader,
  failClosed,
  isPhViewerAuthorized,
  passwordMatches,
  passwordRequired,
  viewerToken
} = require('./ph-view-gate');
const { getPleasantHillBoard } = require('./pleasant-hill');

function gatedPayload() {
  return {
    success: true,
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

function mountPleasantHill(app, options) {
  const publicDir = (options && options.publicDir) || path.join(__dirname, '..', 'public');
  const pagePath = path.join(publicDir, 'modules', 'pleasant-hill.html');

  app.post('/api/pleasant-hill/unlock', (req, res) => {
    if (!passwordRequired()) {
      return res.status(400).json({ success: false, source: 'auth', message: VIEWER_LOAD_ERROR });
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
        return res.json(gatedPayload());
      }
      if (passwordRequired() && !isPhViewerAuthorized(req)) {
        return res.status(401).json({
          success: false,
          source: 'auth',
          message: 'Passcode required.'
        });
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

module.exports = { gatedPayload, mountPleasantHill };
