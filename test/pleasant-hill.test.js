'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const {
  displayTitle,
  fixtureBoard,
  assembleBoard,
  gateCodeFromText,
  getPleasantHillBoard,
  includeIssue,
  mapIssue,
  ownersFromIssue,
  parseOwnerSuffix,
  resetPleasantHillCache,
  stripOwnerSuffix,
  titleMatchesPrefix,
  unconfiguredBoard,
  VIEWER_LOAD_ERROR
} = require('../lib/pleasant-hill');
const { stripFinancials, scrubString } = require('../public/js/strip-financials');
const { assertNoDollar, issueRowHtml, viewText } = require('../public/js/pleasant-hill-format');
const {
  AUTH_MAX_TRIES,
  passwordRequired,
  resetAuthAttempts,
  tokensEqual
} = require('../lib/ph-view-gate');
const { BASIC_REALM, mountPleasantHill } = require('../lib/pleasant-hill-routes');

describe('Linear not configured', () => {
  it('returns a Linear not configured board when the API key is missing', async () => {
    const prev = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    const board = await getPleasantHillBoard({ now: '2026-09-29T12:00:00-07:00' });
    assert.equal(board.configured, false);
    assert.equal(board.source, 'unconfigured');
    assert.equal(board.message, 'Linear not configured');
    assert.equal(board.issues.length, 0);
    if (prev != null) process.env.LINEAR_API_KEY = prev;
  });

  it('unconfiguredBoard does not throw and carries unknown gates', () => {
    const board = unconfiguredBoard();
    assert.equal(board.message, 'Linear not configured');
    assert.deepEqual(board.gates.map((g) => g.code), ['M1', 'M2', 'M3', 'M4']);
  });
});

describe('Linear errors stay off the page', () => {
  it('returns a generic viewer message and omits the raw API error', async () => {
    resetPleasantHillCache();
    const secret = 'Linear HTTP 401: workspace token sk_live_not_for_viewers';
    const board = await getPleasantHillBoard({
      apiKey: 'test-key',
      bypassCache: true,
      now: new Date('2026-09-29T19:00:00Z'),
      graphql: async () => {
        throw new Error(secret);
      }
    });
    assert.equal(board.source, 'error');
    assert.equal(board.message, VIEWER_LOAD_ERROR);
    const blob = JSON.stringify(board);
    assert.equal(blob.includes(secret), false);
    assert.equal(blob.includes('401'), false);
    assert.equal(blob.includes('sk_live'), false);
  });

  it('caches Linear errors for about 60s so outages are not hammered', async () => {
    resetPleasantHillCache();
    let calls = 0;
    const graphql = async () => {
      calls += 1;
      throw new Error('Linear HTTP 503 unavailable');
    };
    await getPleasantHillBoard({ apiKey: 'test-key', graphql, now: new Date('2026-09-29T19:00:00Z') });
    await getPleasantHillBoard({ apiKey: 'test-key', graphql, now: new Date('2026-09-29T19:00:00Z') });
    assert.equal(calls, 1);
  });
});

describe('fail closed without viewer password', () => {
  it('does not call Linear when the API key is set and PH_VIEW_PASSWORD is missing', async () => {
    const prevKey = process.env.LINEAR_API_KEY;
    const prevPw = process.env.PH_VIEW_PASSWORD;
    process.env.LINEAR_API_KEY = 'live-key';
    delete process.env.PH_VIEW_PASSWORD;
    resetPleasantHillCache();
    let calls = 0;
    const board = await getPleasantHillBoard({
      graphql: async () => {
        calls += 1;
        return {};
      }
    });
    assert.equal(board.source, 'gated');
    assert.equal(board.message, VIEWER_LOAD_ERROR);
    assert.equal(board.issues.length, 0);
    assert.equal(calls, 0);
    if (prevKey == null) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = prevKey;
    if (prevPw == null) delete process.env.PH_VIEW_PASSWORD;
    else process.env.PH_VIEW_PASSWORD = prevPw;
  });
});

describe('issue filters', () => {
  it('keeps Pleasant Hill: titles and drops Pleasanton: prefix', () => {
    assert.equal(titleMatchesPrefix('Pleasant Hill: layout freeze (Owner: Todd)', 'Pleasant Hill:'), true);
    assert.equal(
      includeIssue({
        title: 'Pleasanton: leftover intake photos',
        project: 'Clinic Development - Todd'
      }),
      false
    );
  });

  it('includes Supervision Standard Rollout issues that name Pleasant Hill even without the prefix', () => {
    assert.equal(
      includeIssue({
        title: 'Bring Pleasant Hill to supervision standard',
        project: 'Supervision Standard Rollout'
      }),
      true
    );
  });
});

describe('owners and display titles', () => {
  it('parses (Owner: Todd) / (Owner: Leddy) when unassigned and strips the suffix', () => {
    const todd = {
      title: 'Pleasant Hill: layout freeze / schematic design sign-off (Owner: Todd)',
      assignee: null,
      labels: { nodes: [] }
    };
    const leddy = {
      title: 'Pleasant Hill: equipment quotes (Owner: Leddy)',
      assignee: null,
      labels: { nodes: [] }
    };
    assert.deepEqual(parseOwnerSuffix(todd.title), ['Todd']);
    assert.deepEqual(ownersFromIssue(todd), ['Todd']);
    assert.deepEqual(ownersFromIssue(leddy), ['Leddy']);
    assert.equal(stripOwnerSuffix(todd.title).includes('(Owner:'), false);
    assert.equal(displayTitle(todd.title).includes('Owner:'), false);
    assert.match(displayTitle(todd.title), /layout freeze/);
  });

  it('splits (Owner: Leddy/Todd) and (Owner: owner-side / Todd)', () => {
    assert.deepEqual(
      ownersFromIssue({
        title: 'Pleasant Hill: M4 — commissioning (Owner: Leddy/Todd)',
        assignee: null,
        labels: { nodes: [] }
      }),
      ['Leddy', 'Todd']
    );
    assert.deepEqual(
      ownersFromIssue({
        title: 'Pleasant Hill: GC bid + award (Owner: owner-side / Todd)',
        assignee: null,
        labels: { nodes: [] }
      }),
      ['Owner-side', 'Todd']
    );
  });
});

describe('M1-M4 gates from titles', () => {
  it('parses M1-M4 from the title marker rather than issue ids', () => {
    const titles = [
      'Pleasant Hill: M1 — agreement signed',
      'Pleasant Hill: M2 — equipment delivered (Owner: Leddy)',
      'Pleasant Hill: M3 — rough-in complete (Owner: Todd)',
      'Pleasant Hill: M4 — commissioning (Owner: Leddy/Todd)'
    ];
    assert.deepEqual(titles.map(gateCodeFromText), ['M1', 'M2', 'M3', 'M4']);
    const mapped = mapIssue(
      {
        title: titles[1],
        dueDate: '2027-03-19',
        state: { name: 'Backlog', type: 'backlog' },
        labels: { nodes: [] }
      },
      '2026-09-29'
    );
    assert.equal(mapped.gate, 'M2');
  });

  it('does not repeat the gate code in the gate name', () => {
    const board = fixtureBoard(new Date('2026-09-29T19:00:00Z'));
    const m1 = board.gates.find((g) => g.code === 'M1');
    assert.equal(m1.name.includes('M1'), false);
    assert.match(m1.name, /agreement signed/i);
  });
});

describe('no-money filter', () => {
  const cases = [
    ['$1,200', '$1,200'],
    ['$1.2k', '$1.2k'],
    ['$3M', '$3M'],
    ['1200 USD', '1200 USD'],
    ['1,200 usd', '1,200 usd'],
    ['1.2k USD', '1.2k USD'],
    ['€900', '€900'],
    ['£1,200', '£1,200'],
    ['Deposit 20% due', '20%'],
    ['Pay 30%', '30%'],
    ['2.5%', '2.5%'],
    ['ten percent fee', 'percent'],
    ['$1.2 million', '$1.2 million'],
    ['$TBD', '$TBD'],
    ['50,000 USD', '50,000 USD'],
    ['capital call due Nov', 'capital call']
  ];

  for (const [name, sample] of cases) {
    it('strips ' + name, () => {
      const cleaned = stripFinancials('Note ' + sample + ' end');
      assert.equal(cleaned.includes(sample), false);
      assert.doesNotMatch(cleaned, /[$€£]/);
      assert.doesNotMatch(cleaned, /\bUSD\b|\bEUR\b|\bGBP\b/i);
      assert.equal(viewText(sample).includes(sample), false);
    });
  }

  it('keeps surrounding words when stripping percents', () => {
    const cleaned = stripFinancials('Deposit 20% due');
    assert.match(cleaned, /Deposit/i);
    assert.match(cleaned, /due/i);
    assert.doesNotMatch(cleaned, /20%/);
  });

  it('strips $1.2 million without leaving illion', () => {
    const cleaned = stripFinancials('Budget $1.2 million reserved');
    assert.doesNotMatch(cleaned, /illion/i);
    assert.doesNotMatch(cleaned, /\$/);
    assert.match(cleaned, /Budget/i);
    assert.match(cleaned, /reserved/i);
  });

  it('strips capital call phrases including dates with no attached figure', () => {
    const cleaned = stripFinancials('capital call due Nov');
    assert.doesNotMatch(cleaned, /capital call/i);
    assert.match(cleaned, /due Nov/i);
  });

  it('strips percent splits and capital-call amounts', () => {
    const cleaned = stripFinancials('Split 40/30/20/10 vs 20/30/30/20. Capital Call 1 (40%).');
    assert.doesNotMatch(cleaned, /\d+%/);
    assert.doesNotMatch(cleaned, /40\s*\/\s*30/);
    assert.doesNotMatch(cleaned, /Capital Call/i);
  });

  it('blanks leftover money instead of rendering it', () => {
    assert.equal(scrubString('USD still here'), '');
    assert.equal(assertNoDollar('Pay 30%'), 'Pay');
    assert.equal(viewText('$TBD'), '');
    assert.equal(viewText('$1.2 million'), '');
  });

  it('blanks titles that are mostly stripped leftover separators', () => {
    assert.equal(scrubString('Wire / / / /'), '');
    assert.equal(displayTitle('Pleasant Hill: Wire $1,200 / $3M / 20% / 10%'), '');
  });

  it('strips Budget: 500k-style figures after budget/cost/price words', () => {
    const cleaned = stripFinancials('Note Budget: 500k and cost 1.2m end');
    assert.doesNotMatch(cleaned, /500k/i);
    assert.doesNotMatch(cleaned, /1\.2m/i);
    assert.equal(scrubString('Budget: 500k').includes('500'), false);
  });

  it('browser scripts do not redeclare stripFinancials on the global object', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const stripSrc = fs.readFileSync(path.join(__dirname, '../public/js/strip-financials.js'), 'utf8');
    const formatSrc = fs.readFileSync(path.join(__dirname, '../public/js/pleasant-hill-format.js'), 'utf8');
    assert.equal(/globalThis\.stripFinancials\s*=/.test(stripSrc), false);
    assert.doesNotMatch(formatSrc, /(?:const|let|var)\s+stripFinancials\b/);
  });

  it('applies the choke point to fixture JSON and rendered rows', () => {
    const board = fixtureBoard(new Date('2026-09-29T19:00:00Z'));
    const scrubbed = assertNoDollar(board);
    const blob = JSON.stringify(scrubbed);
    assert.doesNotMatch(blob, /[$€£]/);
    assert.doesNotMatch(blob, /\bUSD\b/i);
    assert.equal(blob.includes('linear.app'), false);
    assert.equal(blob.includes('"description"'), false);
    assert.equal(blob.includes('"rawTitle"'), false);
    const html = board.issues.map((issue) => issueRowHtml(issue, (s) => s)).join('\n');
    assert.doesNotMatch(html, /[$€£]/);
    const bait = issueRowHtml(
      { id: 'x', identifier: 'PH-999', title: 'Note $1,200 and 1.2k USD', owners: ['$3M'], url: null },
      (s) => s
    );
    assert.doesNotMatch(bait, /\$1,200/);
    assert.doesNotMatch(bait, /1\.2k USD/i);
    assert.doesNotMatch(bait, /\$3M/);
  });
});

describe('synthetic fixture', () => {
  it('loads both projects, M1-M4 title gates, and no third-party URLs', () => {
    const board = fixtureBoard(new Date('2026-09-29T19:00:00Z'));
    const ids = board.issues.map((i) => i.identifier);
    assert.ok(ids.includes('PH-101'));
    assert.ok(ids.includes('PH-201'));
    assert.ok(ids.includes('PH-502'));
    assert.ok(!ids.includes('PH-000'));
    const gates = Object.fromEntries(board.gates.map((g) => [g.code, g]));
    assert.equal(gates.M1.source, 'issue-title');
    assert.ok(gates.M1.issueIds.includes('PH-201'));
    assert.ok(gates.M2.issueIds.includes('PH-301'));
    assert.ok(gates.M3.issueIds.includes('PH-302'));
    assert.ok(gates.M4.issueIds.includes('PH-401'));
    const todd = board.issues.find((i) => i.identifier === 'PH-202');
    assert.deepEqual(todd.owners, ['Todd']);
    assert.equal(todd.title.includes('(Owner:'), false);
    assert.equal(todd.url, null);
    assert.equal(Object.prototype.hasOwnProperty.call(todd, 'description'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(todd, 'rawTitle'), false);
    assert.ok(board.late.some((i) => i.identifier === 'PH-090'));
    assert.ok(board.thisWeek.some((i) => i.identifier === 'PH-091'));
  });

  it('dedupes mapped issues by id', () => {
    const raw = {
      id: 'dup-1',
      identifier: 'PH-DUP',
      title: 'Pleasant Hill: duplicate row',
      dueDate: '2026-10-10',
      state: { name: 'Backlog', type: 'backlog' },
      labels: { nodes: [] },
      project: { name: 'Clinic Development - Todd' }
    };
    const board = assembleBoard({
      issues: [raw, { ...raw, title: 'Pleasant Hill: duplicate row copy' }],
      project: { name: 'Clinic Development - Todd', url: null },
      milestones: [],
      source: 'fixture',
      now: new Date('2026-09-29T19:00:00Z')
    });
    assert.equal(board.issues.filter((i) => i.id === 'dup-1').length, 1);
  });
});

describe('Pleasant Hill viewer gate', () => {
  let server;
  let base;
  const prev = {};

  before(async () => {
    prev.LINEAR_API_KEY = process.env.LINEAR_API_KEY;
    prev.PH_VIEW_PASSWORD = process.env.PH_VIEW_PASSWORD;
    prev.NODE_ENV = process.env.NODE_ENV;
    process.env.PH_VIEW_PASSWORD = 'test-pass';
    delete process.env.LINEAR_API_KEY;
    process.env.NODE_ENV = 'test';
    const app = express();
    app.use(express.json());
    mountPleasantHill(app);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    base = 'http://127.0.0.1:' + port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (prev.LINEAR_API_KEY == null) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = prev.LINEAR_API_KEY;
    if (prev.PH_VIEW_PASSWORD == null) delete process.env.PH_VIEW_PASSWORD;
    else process.env.PH_VIEW_PASSWORD = prev.PH_VIEW_PASSWORD;
    if (prev.NODE_ENV == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev.NODE_ENV;
  });

  function request(pathname, opts) {
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

  it('requires a passcode for the API when PH_VIEW_PASSWORD is set', async () => {
    resetAuthAttempts();
    assert.equal(passwordRequired(), true);
    const res = await request('/api/pleasant-hill?fixture=1');
    assert.equal(res.status, 401);
    assert.match(res.body, /Passcode required/);
    assert.equal(res.headers['www-authenticate'], BASIC_REALM);
    assert.equal(res.body.includes('PH-101'), false);
  });

  it('unlocks with a passcode cookie and then serves the board', async () => {
    const unlock = await request('/api/pleasant-hill/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-pass' })
    });
    assert.equal(unlock.status, 200);
    const setCookie = unlock.headers['set-cookie'] && unlock.headers['set-cookie'][0];
    assert.match(setCookie, /ph_view=/);
    const cookie = setCookie.split(';')[0];
    const res = await request('/api/pleasant-hill?fixture=1', { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.source, 'fixture');
    assert.ok(json.issues.some((i) => i.identifier === 'PH-101'));
    assert.equal(JSON.stringify(json).includes('"description"'), false);
  });

  it('accepts HTTP basic auth', async () => {
    resetAuthAttempts();
    const token = Buffer.from('view:test-pass').toString('base64');
    const res = await request('/api/pleasant-hill?fixture=1', {
      headers: { Authorization: 'Basic ' + token }
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).source, 'fixture');
  });

  it('rate-limits unlock and Basic auth to about 5 tries per minute per IP', async () => {
    resetAuthAttempts();
    const posts = [];
    for (let i = 0; i < AUTH_MAX_TRIES + 1; i += 1) {
      posts.push(await request('/api/pleasant-hill/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
        body: JSON.stringify({ password: 'wrong' })
      }));
    }
    assert.equal(posts[AUTH_MAX_TRIES - 1].status, 401);
    assert.equal(posts[AUTH_MAX_TRIES].status, 429);
    resetAuthAttempts();
    const basic = Buffer.from('view:nope').toString('base64');
    let last;
    for (let i = 0; i < AUTH_MAX_TRIES + 1; i += 1) {
      last = await request('/api/pleasant-hill?fixture=1', {
        headers: { Authorization: 'Basic ' + basic, 'X-Forwarded-For': '203.0.113.10' }
      });
    }
    assert.equal(last.status, 429);
    assert.ok(last.headers['retry-after']);
  });
});

describe('constant-time secret compare', () => {
  it('compares HMAC digests and does not return early on length mismatch', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../lib/ph-view-gate.js'), 'utf8');
    assert.equal(/left\.length\s*!==\s*right\.length/.test(src), false);
    assert.match(src, /timingSafeEqual\(hmacDigest/);
    assert.equal(tokensEqual('short', 'much-longer-secret'), false);
    assert.equal(tokensEqual('same-secret', 'same-secret'), true);
  });
});

describe('fail-closed HTTP 503', () => {
  it('returns 503 when the Linear key is set without PH_VIEW_PASSWORD', async () => {
    const prevKey = process.env.LINEAR_API_KEY;
    const prevPw = process.env.PH_VIEW_PASSWORD;
    process.env.LINEAR_API_KEY = 'live-key';
    delete process.env.PH_VIEW_PASSWORD;
    const app = express();
    app.use(express.json());
    mountPleasantHill(app);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const res = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:' + port + '/api/pleasant-hill', (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (c) => { body += c; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      }).on('error', reject);
    });
    await new Promise((resolve) => server.close(resolve));
    assert.equal(res.status, 503);
    const json = JSON.parse(res.body);
    assert.equal(json.source, 'gated');
    assert.equal(json.issues.length, 0);
    if (prevKey == null) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = prevKey;
    if (prevPw == null) delete process.env.PH_VIEW_PASSWORD;
    else process.env.PH_VIEW_PASSWORD = prevPw;
  });
});

describe('Render NODE_ENV docs', () => {
  it('tells operators to set NODE_ENV=production explicitly', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
    const envExample = fs.readFileSync(path.join(__dirname, '../.env.example'), 'utf8');
    assert.match(readme, /NODE_ENV=production/);
    assert.match(readme, /explicitly/);
    assert.match(envExample, /NODE_ENV=production/);
    assert.match(envExample, /Render does not set this for you/);
  });
});
