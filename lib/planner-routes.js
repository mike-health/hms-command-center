'use strict';

const path = require('path');
const express = require('express');
const {
  AUTH_WINDOW_MS,
  BASIC_REALM,
  MISSING_PASSWORD_ERROR,
  PASSCODE_INCORRECT,
  PASSCODE_REQUIRED,
  RATE_LIMIT_ERROR,
  basicPassword,
  consumeAuthAttempt,
  cookieAuthorized,
  cookieHeader,
  failClosed,
  hasBasicHeader,
  isAuthRateLimited,
  passwordMatches,
  viewerToken
} = require('./planner-view-gate');

const ALLOWED_FILES = new Set(['index.html', 'styles.css', 'app.js']);
const NO_STORE = 'private, no-store';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loginPage(message) {
  const note = escapeHtml(message || PASSCODE_REQUIRED);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Health Path Planner</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 28rem; color: #2b2f2c; }
    form { display: grid; gap: 0.75rem; }
    input, button { font: inherit; padding: 0.55rem 0.7rem; }
    button { background: #2f6f62; color: #fff; border: 0; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Health Path Planner</h1>
  <p role="status">${note}</p>
  <form method="post" action="/health-path-planner/unlock" autocomplete="on">
    <label>Passcode
      <input type="password" name="password" required autocomplete="current-password">
    </label>
    <button type="submit">Unlock</button>
  </form>
</body>
</html>`;
}

function wantsJson(req) {
  const accept = String((req.headers && (req.headers.accept || req.headers.Accept)) || '');
  const type = String((req.headers && (req.headers['content-type'] || req.headers['Content-Type'])) || '');
  return accept.includes('application/json') || type.includes('application/json');
}

function sendClosed(res, req) {
  console.error('PLANNER_VIEW_PASSWORD missing; refusing Health Path Planner');
  res.setHeader('Cache-Control', NO_STORE);
  if (wantsJson(req)) {
    return res.status(503).json({ success: false, source: 'gated', message: MISSING_PASSWORD_ERROR });
  }
  return res.status(503).type('html').send(loginPage(MISSING_PASSWORD_ERROR));
}

function sendUnauthorized(res, req, message) {
  res.setHeader('Cache-Control', NO_STORE);
  res.setHeader('WWW-Authenticate', BASIC_REALM);
  const text = message || PASSCODE_REQUIRED;
  if (wantsJson(req)) {
    return res.status(401).json({ success: false, source: 'auth', message: text });
  }
  return res.status(401).type('html').send(loginPage(text));
}

function sendRateLimited(res, req) {
  res.setHeader('Cache-Control', NO_STORE);
  res.setHeader('Retry-After', String(Math.ceil(AUTH_WINDOW_MS / 1000)));
  if (wantsJson(req)) {
    return res.status(429).json({ success: false, source: 'auth', message: RATE_LIMIT_ERROR });
  }
  return res.status(429).type('html').send(loginPage(RATE_LIMIT_ERROR));
}

function authorizeRequest(req, res) {
  if (failClosed()) {
    sendClosed(res, req);
    return false;
  }
  if (cookieAuthorized(req)) return true;
  if (hasBasicHeader(req)) {
    if (isAuthRateLimited(req) || !consumeAuthAttempt(req)) {
      sendRateLimited(res, req);
      return false;
    }
    if (!passwordMatches(basicPassword(req))) {
      sendUnauthorized(res, req, PASSCODE_INCORRECT);
      return false;
    }
    res.setHeader('Set-Cookie', cookieHeader(viewerToken(), req));
    return true;
  }
  sendUnauthorized(res, req, PASSCODE_REQUIRED);
  return false;
}

function resolvePlannerFile(plannerDir, name) {
  const base = path.basename(String(name || ''));
  if (!ALLOWED_FILES.has(base)) return null;
  const resolvedDir = path.resolve(plannerDir);
  const filePath = path.resolve(resolvedDir, base);
  if (filePath !== path.join(resolvedDir, base)) return null;
  return filePath;
}

function sendPlannerFile(res, filePath) {
  res.setHeader('Cache-Control', NO_STORE);
  return res.sendFile(filePath);
}

function mountPlanner(app, options) {
  const plannerDir = path.resolve((options && options.plannerDir) || path.join(__dirname, '..', 'health-path-planner'));

  app.post(
    '/health-path-planner/unlock',
    express.urlencoded({ extended: false }),
    (req, res) => {
      if (failClosed()) return sendClosed(res, req);
      if (isAuthRateLimited(req) || !consumeAuthAttempt(req)) {
        return sendRateLimited(res, req);
      }
      const body = req.body || {};
      const candidate = body.password != null ? body.password : body.passcode;
      if (!passwordMatches(candidate)) {
        return sendUnauthorized(res, req, PASSCODE_INCORRECT);
      }
      res.setHeader('Set-Cookie', cookieHeader(viewerToken(), req));
      if (wantsJson(req)) {
        return res.json({ success: true, source: 'auth' });
      }
      return res.redirect(303, '/health-path-planner/');
    }
  );

  app.get(['/health-path-planner', '/health-path-planner/'], (req, res) => {
    if (!authorizeRequest(req, res)) return;
    const filePath = resolvePlannerFile(plannerDir, 'index.html');
    return sendPlannerFile(res, filePath);
  });

  app.get('/health-path-planner/:file', (req, res) => {
    if (!authorizeRequest(req, res)) return;
    const filePath = resolvePlannerFile(plannerDir, req.params.file);
    if (!filePath) {
      res.setHeader('Cache-Control', NO_STORE);
      return res.status(404).type('text').send('Not found');
    }
    return sendPlannerFile(res, filePath);
  });
}

module.exports = {
  ALLOWED_FILES,
  loginPage,
  mountPlanner,
  resolvePlannerFile
};
