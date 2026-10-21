'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const {
  AUTH_MAX_TRIES,
  BASIC_REALM,
  COOKIE_NAME,
  MISSING_PASSWORD_ERROR,
  failClosed,
  passwordRequired,
  resetAuthAttempts,
  tokensEqual,
  viewerToken
} = require('../lib/planner-view-gate');
const { mountPlanner } = require('../lib/planner-routes');

const PLANNER_DIR = path.join(__dirname, '..', 'health-path-planner');
const TEST_PASS = 'test-pass';

function request(base, pathname, opts) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const req = http.request(url, {
      method: (opts && opts.method) || 'GET',
      headers: opts && opts.headers
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });
}

describe('planner gate compare', () => {
  it('uses HMAC timing-safe compare and does not short-circuit on length', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/planner-view-gate.js'), 'utf8');
    assert.equal(/left\.length\s*!==\s*right\.length/.test(src), false);
    assert.match(src, /timingSafeEqual\(hmacDigest/);
    assert.equal(tokensEqual('short', 'much-longer-secret'), false);
    assert.equal(tokensEqual('same-secret', 'same-secret'), true);
  });
});

describe('planner files stay off ungated static paths', () => {
  it('does not place planner assets under public/', () => {
    assert.equal(fs.existsSync(path.join(__dirname, '../public/health-path-planner')), false);
    assert.equal(fs.existsSync(path.join(__dirname, '../public/index.html')) &&
      fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8').includes('Health Path Planner'), false);
    const serverSrc = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.equal(serverSrc.includes("express.static(path.join(__dirname, 'health-path-planner'))"), false);
    assert.match(serverSrc, /mountPlanner/);
  });
});

describe('planner HTTP gate', { concurrency: false }, () => {
  let server;
  let base;
  const prev = {};

  before(async () => {
    prev.PLANNER_VIEW_PASSWORD = process.env.PLANNER_VIEW_PASSWORD;
    process.env.PLANNER_VIEW_PASSWORD = TEST_PASS;
    const app = express();
    app.use(express.json());
    app.use('/css', express.static(path.join(__dirname, '../public/css')));
    app.use('/js', express.static(path.join(__dirname, '../public/js')));
    mountPlanner(app, { plannerDir: PLANNER_DIR });
    app.get('*', (req, res) => {
      res.status(200).type('html').send('<html><body>command-center-fallback</body></html>');
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    base = 'http://127.0.0.1:' + port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (prev.PLANNER_VIEW_PASSWORD == null) delete process.env.PLANNER_VIEW_PASSWORD;
    else process.env.PLANNER_VIEW_PASSWORD = prev.PLANNER_VIEW_PASSWORD;
  });

  beforeEach(() => {
    resetAuthAttempts();
  });

  it('rejects anonymous HTML, CSS, and JS', async () => {
    const page = await request(base, '/health-path-planner/');
    assert.equal(page.status, 401);
    assert.equal(page.headers['www-authenticate'], BASIC_REALM);
    assert.equal(page.body.includes('Generate Path'), false);
    assert.equal(page.body.includes('type 2 diabetes'), false);
    assert.match(page.body, /Passcode/);

    const css = await request(base, '/health-path-planner/styles.css');
    assert.equal(css.status, 401);
    assert.equal(css.body.includes('--accent'), false);

    const js = await request(base, '/health-path-planner/app.js');
    assert.equal(js.status, 401);
    assert.equal(js.body.includes('SEED_PATH'), false);
  });

  it('unlocks with a passcode cookie and then serves html and assets', async () => {
    const unlock = await request(base, '/health-path-planner/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password: TEST_PASS })
    });
    assert.equal(unlock.status, 200);
    const setCookie = unlock.headers['set-cookie'] && unlock.headers['set-cookie'][0];
    assert.match(setCookie, new RegExp(COOKIE_NAME + '='));
    assert.match(setCookie, /HttpOnly/i);
    assert.equal(setCookie.toLowerCase().includes(TEST_PASS.toLowerCase()), false);
    const cookie = setCookie.split(';')[0];

    const page = await request(base, '/health-path-planner/', { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.match(page.body, /Generate Path/);
    assert.match(page.body, /\/health-path-planner\/app\.js/);

    const css = await request(base, '/health-path-planner/styles.css', { headers: { Cookie: cookie } });
    assert.equal(css.status, 200);
    assert.match(css.body, /--accent/);

    const js = await request(base, '/health-path-planner/app.js', { headers: { Cookie: cookie } });
    assert.equal(js.status, 200);
    assert.match(js.body, /SEED_PATH/);
  });

  it('accepts HTTP basic auth for the page and assets', async () => {
    const token = Buffer.from('view:' + TEST_PASS).toString('base64');
    const headers = { Authorization: 'Basic ' + token };
    const page = await request(base, '/health-path-planner/', { headers });
    assert.equal(page.status, 200);
    assert.match(page.body, /Health Path Planner/);
    const js = await request(base, '/health-path-planner/app.js', { headers });
    assert.equal(js.status, 200);
    assert.match(js.body, /SEED_PATH/);
  });

  it('does not treat the catch-all as an ungated planner copy', async () => {
    const res = await request(base, '/not-the-planner');
    assert.equal(res.status, 200);
    assert.match(res.body, /command-center-fallback/);
    assert.equal(res.body.includes('SEED_PATH'), false);
  });

  it('rejects path traversal and unknown files even when authorized', async () => {
    const token = Buffer.from('view:' + TEST_PASS).toString('base64');
    const headers = { Authorization: 'Basic ' + token };
    const traversal = await request(base, '/health-path-planner/' + encodeURIComponent('../server.js'), { headers });
    assert.equal(traversal.status, 404);
    assert.equal(traversal.body.includes('express'), false);
    const extra = await request(base, '/health-path-planner/package.json', { headers });
    assert.equal(extra.status, 404);
  });

  it('rate-limits unlock and Basic auth', async () => {
    const posts = [];
    for (let i = 0; i < AUTH_MAX_TRIES + 1; i += 1) {
      posts.push(await request(base, '/health-path-planner/unlock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Forwarded-For': '203.0.113.41'
        },
        body: JSON.stringify({ password: 'wrong' })
      }));
    }
    assert.equal(posts[AUTH_MAX_TRIES - 1].status, 401);
    assert.equal(posts[AUTH_MAX_TRIES].status, 429);
    resetAuthAttempts();
    const basic = Buffer.from('view:nope').toString('base64');
    let last;
    for (let i = 0; i < AUTH_MAX_TRIES + 1; i += 1) {
      last = await request(base, '/health-path-planner/', {
        headers: { Authorization: 'Basic ' + basic, 'X-Forwarded-For': '203.0.113.42' }
      });
    }
    assert.equal(last.status, 429);
    assert.ok(last.headers['retry-after']);
  });
});

describe('planner fail closed', { concurrency: false }, () => {
  it('returns 503 when PLANNER_VIEW_PASSWORD is unset', async () => {
    const prevPw = process.env.PLANNER_VIEW_PASSWORD;
    delete process.env.PLANNER_VIEW_PASSWORD;
    assert.equal(failClosed(), true);
    assert.equal(passwordRequired(), false);

    const app = express();
    app.use(express.json());
    mountPlanner(app, { plannerDir: PLANNER_DIR });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const base = 'http://127.0.0.1:' + port;

    const page = await request(base, '/health-path-planner/', {
      headers: { Accept: 'application/json' }
    });
    const asset = await request(base, '/health-path-planner/app.js');
    const unlock = await request(base, '/health-path-planner/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password: 'anything' })
    });

    try {
      assert.equal(page.status, 503);
      assert.match(page.body, new RegExp(MISSING_PASSWORD_ERROR));
      assert.equal(page.body.includes('SEED_PATH'), false);
      assert.equal(asset.status, 503);
      assert.equal(asset.body.includes('SEED_PATH'), false);
      assert.equal(unlock.status, 503);
      assert.equal(viewerToken(), '');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (prevPw == null) delete process.env.PLANNER_VIEW_PASSWORD;
      else process.env.PLANNER_VIEW_PASSWORD = prevPw;
    }
  });
});
