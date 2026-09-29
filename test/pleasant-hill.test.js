'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  displayTitle,
  fixtureBoard,
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
const { stripFinancials } = require('../public/js/strip-financials');
const { assertNoDollar, issueRowHtml, viewText } = require('../public/js/pleasant-hill-format');

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
    ['£1,200', '£1,200']
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

  it('strips percent splits and capital-call amounts', () => {
    const cleaned = stripFinancials('Split 40/30/20/10 vs 20/30/30/20. Capital Call 1 (40%).');
    assert.doesNotMatch(cleaned, /\d+%/);
    assert.doesNotMatch(cleaned, /40\s*\/\s*30/);
    assert.doesNotMatch(cleaned, /Capital Call/i);
  });

  it('applies the choke point to fixture JSON and rendered rows', () => {
    const board = fixtureBoard(new Date('2026-09-29T19:00:00Z'));
    assertNoDollar(board);
    const blob = JSON.stringify(board);
    assert.doesNotMatch(blob, /[$€£]/);
    assert.doesNotMatch(blob, /\bUSD\b/i);
    assert.equal(blob.includes('linear.app'), false);
    const html = board.issues.map((issue) => issueRowHtml(issue, (s) => s)).join('\n');
    assert.doesNotMatch(html, /[$€£]/);
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
    assert.ok(board.late.some((i) => i.identifier === 'PH-090'));
    assert.ok(board.thisWeek.some((i) => i.identifier === 'PH-091'));
  });
});
