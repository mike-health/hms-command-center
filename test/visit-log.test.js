'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { createHmac } = require('node:crypto');
const {
  SITE,
  createVisitStore,
  createVisitLogHandler,
  hashIp
} = require('../lib/visit-log');

const HTML_PAGES = [
  path.join(__dirname, '../public/index.html'),
  ...fs.readdirSync(path.join(__dirname, '../public/modules'))
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(__dirname, '../public/modules', f))
];

async function withServer(handler, fn) {
  const app = express();
  app.use(express.json());
  app.all('/api/visit-log', handler);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function postVisit(base, body, headers = {}) {
  const res = await fetch(`${base}/api/visit-log`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

describe('visit-log client snippet', () => {
  it('is included on every live HTML page', () => {
    assert.ok(HTML_PAGES.length >= 9);
    HTML_PAGES.forEach((file) => {
      const html = fs.readFileSync(file, 'utf8');
      assert.match(html, /src="\/js\/visit-log\.js"/, file);
    });
  });

  it('POSTs keepalive fingerprint fields and swallows errors', () => {
    const src = fs.readFileSync(path.join(__dirname, '../public/js/visit-log.js'), 'utf8');
    assert.match(src, /hms_visit_fp_v1/);
    assert.match(src, /keepalive:\s*true/);
    assert.match(src, /\/api\/visit-log/);
    assert.match(src, /navigator\.userAgent/);
    assert.match(src, /screen\.width/);
    assert.match(src, /timeZone/);
    assert.match(src, /navigator\.language/);
    assert.match(src, /location\.pathname/);
    assert.match(src, /\.catch\(function\s*\(\)\s*\{\}\)/);
    assert.match(src, /catch\s*\(e\)\s*\{\}/);
  });
});

describe('POST /api/visit-log', () => {
  it('returns 204 and stores nothing when HMAC and ingest env are missing', async () => {
    const store = createVisitStore();
    const logs = [];
    const fetches = [];
    const handler = createVisitLogHandler({
      store,
      env: {},
      fetchImpl: async (url, init) => { fetches.push({ url, init }); },
      log: (line) => logs.push(line)
    });
    await withServer(handler, async (base) => {
      const res = await postVisit(base, { fp: 'abcdefghijklmnop', path: '/' });
      assert.equal(res.status, 204);
    });
    assert.equal(store.size, 0);
    assert.equal(fetches.length, 0);
    assert.equal(logs.length, 0);
  });

  it('hashes IP with HMAC, never stores the raw IP, and counts hits', async () => {
    const store = createVisitStore();
    const secret = 'unit-test-hmac-secret';
    const handler = createVisitLogHandler({
      store,
      env: { VISIT_HMAC_SECRET: secret },
      fetchImpl: async () => { throw new Error('ingest should not be required'); },
      log: () => {}
    });
    await withServer(handler, async (base) => {
      const first = await postVisit(base, {
        fp: 'fp-test-aaaa',
        ua: 'Mozilla/5.0 test',
        screen: '1440x900',
        tz: 'America/Los_Angeles',
        lang: 'en-US',
        path: '/modules/map.html'
      }, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' });
      assert.equal(first.status, 200);
      assert.equal(first.json.ok, true);
      assert.equal(first.json.hits, 1);
      assert.equal(first.json.whitelist, false);

      const second = await postVisit(base, {
        fp: 'fp-test-aaaa',
        path: '/modules/map.html'
      }, { 'x-forwarded-for': '203.0.113.9' });
      assert.equal(second.json.hits, 2);
    });

    const rec = [...store.values()][0];
    assert.equal(rec.site, 'hms-command-center');
    assert.equal(rec.site, SITE);
    assert.equal(rec.fp, 'fp-test-aaaa');
    assert.equal(rec.hits, 2);
    assert.equal(rec.ip_hash, hashIp('203.0.113.9', secret));
    assert.equal(rec.ip_hash, createHmac('sha256', secret).update('ip:203.0.113.9').digest('hex').slice(0, 32));
    assert.equal(JSON.stringify(rec).includes('203.0.113.9'), false);
    assert.equal(rec.whitelist, false);
    assert.equal(rec.kind, 'fingerprint');
  });

  it('forwards a partner-visits.db compatible ingest payload', async () => {
    const fetches = [];
    const handler = createVisitLogHandler({
      store: createVisitStore(),
      env: {
        VISIT_HMAC_SECRET: 'unit-test-hmac-secret',
        VISIT_INGEST_URL: 'https://ingest.example.test/visits',
        VISIT_INGEST_AUTH: 'token-abc'
      },
      now: () => '2026-11-10T18:00:00.000Z',
      fetchImpl: async (url, init) => {
        fetches.push({ url, init });
        return { ok: true };
      }
    });
    await withServer(handler, async (base) => {
      const res = await postVisit(base, {
        fp: 'fp-ingest-01',
        ua: 'Mozilla/5.0 test-agent',
        screen: '800x600',
        tz: 'UTC',
        lang: 'en',
        path: '/'
      });
      assert.equal(res.status, 200);
    });
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].url, 'https://ingest.example.test/visits');
    assert.equal(fetches[0].init.headers.authorization, 'Bearer token-abc');
    const payload = JSON.parse(fetches[0].init.body);
    assert.equal(payload.need, 'partner_visit_log');
    assert.equal(payload.urgency, 'low');
    assert.equal(payload.pointer, '/workspace/ops/security/partner-visits.db');
    assert.equal(payload.visit.site, 'hms-command-center');
    assert.equal(payload.visit.fp, 'fp-ingest-01');
    assert.equal(payload.visit.path, '/');
    assert.equal(payload.visit.hits, 1);
    assert.equal(payload.visit.screen, '800x600');
    assert.equal(payload.visit.tz, 'UTC');
    assert.equal(payload.visit.lang, 'en');
    assert.ok(!JSON.stringify(payload).includes('203.0.113'));
  });

  it('still returns 200 when ingest fails', async () => {
    const logs = [];
    const handler = createVisitLogHandler({
      store: createVisitStore(),
      env: {
        VISIT_HMAC_SECRET: 'unit-test-hmac-secret',
        VISIT_INGEST_URL: 'https://ingest.example.test/down'
      },
      fetchImpl: async () => { throw new Error('network'); },
      log: (line) => logs.push(line)
    });
    await withServer(handler, async (base) => {
      const res = await postVisit(base, { fp: 'fp-fallback1', path: '/' });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
    });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^visit-log /);
  });

  it('rejects a short fingerprint', async () => {
    const handler = createVisitLogHandler({
      env: { VISIT_HMAC_SECRET: 'unit-test-hmac-secret' },
      log: () => {}
    });
    await withServer(handler, async (base) => {
      const res = await postVisit(base, { fp: 'short' });
      assert.equal(res.status, 400);
      assert.equal(res.text, 'fp');
    });
  });
});
