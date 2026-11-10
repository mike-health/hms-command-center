'use strict';

const { createHmac } = require('node:crypto');

const SITE = 'hms-command-center';

/** Process-local hit counts. Render disk is ephemeral; durable copy is the ingest URL. */
function createVisitStore() {
  return new Map();
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return (req.ip || req.socket && req.socket.remoteAddress || '').trim();
}

function hashIp(ip, secret) {
  if (!ip || !secret) return 'unknown';
  return createHmac('sha256', secret).update('ip:' + ip).digest('hex').slice(0, 32);
}

function ingestBody(rec) {
  return {
    need: 'partner_visit_log',
    urgency: 'low',
    pointer: '/workspace/ops/security/partner-visits.db',
    visit: {
      fp: rec.fp,
      ip_hash: rec.ip_hash,
      hits: rec.hits,
      first_seen: rec.first_seen,
      last_seen: rec.last_seen,
      site: rec.site,
      path: rec.path,
      ua: rec.ua.slice(0, 80),
      screen: rec.screen,
      tz: rec.tz,
      lang: rec.lang
    }
  };
}

function authHeader(auth) {
  if (!auth) return {};
  const value = auth.startsWith('Bearer') || auth.includes(' ') ? auth : `Bearer ${auth}`;
  return { authorization: value };
}

function createVisitLogHandler(opts = {}) {
  const store = opts.store || createVisitStore();
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || fetch;
  const nowFn = opts.now || (() => new Date().toISOString());
  const logFn = opts.log || ((line) => console.log(line));

  return async function visitLog(req, res) {
    res.set({
      'access-control-allow-origin': req.headers.origin || '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store'
    });

    try {
      if (req.method === 'OPTIONS') return res.status(204).end();
      if (req.method !== 'POST') return res.status(405).send('method');

      const secret = String(env.VISIT_HMAC_SECRET || '').trim();
      const ingest = String(env.VISIT_INGEST_URL || '').trim();
      const auth = String(env.VISIT_INGEST_AUTH || '').trim();

      if (!secret && !ingest) {
        return res.status(204).end();
      }

      const body = req.body && typeof req.body === 'object' ? req.body : null;
      if (!body) return res.status(400).send('bad json');

      const fp = String(body.fp || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
      if (!fp || fp.length < 8) return res.status(400).send('fp');

      const ua = String(body.ua || '').slice(0, 240);
      const screen = String(body.screen || '').slice(0, 40);
      const tz = String(body.tz || '').slice(0, 64);
      const lang = String(body.lang || '').slice(0, 32);
      const path = String(body.path || '/').slice(0, 120);
      const now = nowFn();
      const ipHash = hashIp(clientIp(req), secret);

      const key = `fp:${SITE}:${fp}`;
      const prev = store.get(key);
      const rec = {
        kind: 'fingerprint',
        site: SITE,
        fp,
        ip_hash: ipHash,
        ua,
        screen,
        tz,
        lang,
        path,
        first_seen: (prev && prev.first_seen) || now,
        last_seen: now,
        hits: ((prev && Number(prev.hits)) || 0) + 1,
        whitelist: false,
        enforce_whitelist: false
      };
      store.set(key, rec);

      const payload = ingestBody(rec);
      if (ingest) {
        try {
          await fetchImpl(ingest, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...authHeader(auth)
            },
            body: JSON.stringify(payload)
          });
        } catch {
          logFn(`visit-log ${JSON.stringify(payload)}`);
        }
      } else {
        logFn(`visit-log ${JSON.stringify(payload)}`);
      }

      return res.status(200).json({ ok: true, hits: rec.hits, whitelist: false });
    } catch {
      return res.status(204).end();
    }
  };
}

module.exports = {
  SITE,
  createVisitStore,
  createVisitLogHandler,
  clientIp,
  hashIp,
  ingestBody
};
