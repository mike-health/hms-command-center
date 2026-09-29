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
  stripFinancials,
  stripOwnerSuffix,
  titleMatchesPrefix,
  unconfiguredBoard
} = require('../lib/pleasant-hill');
const { assertNoDollar, issueRowHtml } = require('../public/js/pleasant-hill-format');

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

describe('issue filters', () => {
  it('keeps Pleasant Hill: titles and drops Pleasanton: HEA-33 / HEA-36', () => {
    assert.equal(titleMatchesPrefix('Pleasant Hill: layout freeze (Owner: Todd)', 'Pleasant Hill:'), true);
    assert.equal(
      includeIssue({
        title: 'Pleasanton: intake Andrew site diagrams / layouts / photos',
        project: 'Clinic Development - Todd'
      }),
      false
    );
    assert.equal(
      includeIssue({
        title: 'Pleasanton: budget travel + tempo/frequency (Budget + PM)',
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
    assert.equal(
      includeIssue({
        title: 'Pleasant Hill: People & certifications (Ops Director)',
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
      title: 'Pleasant Hill: Leddy equipment spec + lead-time quotes + install scope (Owner: Leddy)',
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
      'Pleasant Hill: M1 — final proposal + agreement signed (Capital Call 1)',
      'Pleasant Hill: M2 — equipment delivered + rigged/staged (Capital Call 2) (Owner: Leddy)',
      'Pleasant Hill: M3 — rough-in complete + inspected (Capital Call 3) (Owner: Todd)',
      'Pleasant Hill: M4 — commissioning, med-gas verification, AHJ finals (Capital Call 4) (Owner: Leddy/Todd)'
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
    assert.equal(mapped.id, undefined);
  });
});

describe('no dollar amounts', () => {
  it('strips $ figures, splits, and capital-call amounts from issue text', () => {
    const cleaned = stripFinancials(
      'Hold $50,000. Capital Call 1 (40%). Split 40/30/20/10 vs 20/30/30/20.'
    );
    assert.equal(hasNoDollar(cleaned), true);
    assert.doesNotMatch(cleaned, /\d+%/);
    assert.doesNotMatch(cleaned, /40\s*\/\s*30/);
    assert.doesNotMatch(cleaned, /Capital Call/i);
  });

  it('fixture board JSON and rendered rows contain no $', () => {
    const board = fixtureBoard(new Date('2026-09-29T19:00:00Z'));
    assertNoDollar(board);
    hasNoDollar(JSON.stringify(board));
    const html = board.issues.map((issue) => issueRowHtml(issue, (s) => s)).join('\n');
    assert.equal(html.includes('$'), false);
  });
});

describe('fixture from filed Linear issues', () => {
  it('loads real URLs, both projects, and M1-M4 title gates', () => {
    const board = fixtureBoard(new Date('2026-09-29T19:00:00Z'));
    const ids = board.issues.map((i) => i.identifier);
    assert.ok(ids.includes('HEA-34'));
    assert.ok(ids.includes('HEA-133'));
    assert.ok(ids.includes('HEA-148'));
    assert.ok(ids.includes('HEA-91'));
    assert.ok(ids.includes('HEA-100'));
    assert.ok(ids.includes('HEA-103'));
    assert.ok(!ids.includes('HEA-33'));
    assert.ok(!ids.includes('HEA-36'));
    const gates = Object.fromEntries(board.gates.map((g) => [g.code, g]));
    assert.equal(gates.M1.source, 'issue-title');
    assert.ok(gates.M1.issueIds.includes('HEA-136'));
    assert.ok(gates.M2.issueIds.includes('HEA-142'));
    assert.ok(gates.M3.issueIds.includes('HEA-144'));
    assert.ok(gates.M4.issueIds.includes('HEA-147'));
    const todd = board.issues.find((i) => i.identifier === 'HEA-137');
    assert.deepEqual(todd.owners, ['Todd']);
    assert.equal(todd.title.includes('(Owner:'), false);
    assert.match(todd.url, /^https:\/\/linear\.app\/healtho2\/issue\/HEA-137/);
  });
});

function hasNoDollar(text) {
  assert.equal(String(text).includes('$'), false);
  return true;
}
