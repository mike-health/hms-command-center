'use strict';

const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const {
  applyOpsPlan,
  detectSensitiveKeywords,
  parseOpsInstruction,
  previewOpsInstruction,
  signPlan
} = require('../lib/ops-chat');
const opsCadence = require('../lib/ops-cadence');

const mockIssues = opsCadence.mockBoard().issues;
const ownerLabels = ['Mike', 'Rudy', 'Stacey'];

describe('parseOpsInstruction', () => {
  it('parses create with cadence and owner', () => {
    const result = parseOpsInstruction(
      'create Review chamber logs weekly assign Stacey',
      { cadence: 'Daily', ownerLabels },
      mockIssues
    );
    assert.equal(result.ok, true);
    assert.equal(result.plan.action, 'create');
    assert.equal(result.plan.changes.title, 'Review chamber logs');
    assert.equal(result.plan.changes.cadence, 'Weekly');
    assert.equal(result.plan.changes.owner, 'Stacey');
  });

  it('parses update for open drawer issue', () => {
    const issue = mockIssues[0];
    const result = parseOpsInstruction('mark done', { issueId: issue.id, ownerLabels }, mockIssues);
    assert.equal(result.ok, true);
    assert.equal(result.plan.action, 'update');
    assert.equal(result.plan.issueId, issue.id);
    assert.equal(result.plan.changes.status, 'done');
  });

  it('parses update by HEA identifier', () => {
    const result = parseOpsInstruction(
      'update HEA-82 assign Mike due 2026-09-15',
      { ownerLabels },
      mockIssues
    );
    assert.equal(result.ok, true);
    assert.equal(result.plan.targetIdentifier, 'HEA-82');
    assert.equal(result.plan.changes.owner, 'Mike');
    assert.equal(result.plan.changes.dueDate, '2026-09-15');
  });

  it('flags payment/email instructions for extra confirm copy', () => {
    const result = parseOpsInstruction(
      'create Send payment link to vendor',
      { cadence: 'Daily', ownerLabels },
      mockIssues
    );
    assert.equal(result.ok, true);
    assert.equal(result.requiresConfirm, true);
    assert.match(result.sensitiveNote, /no automatic payment or email/i);
  });
});

describe('detectSensitiveKeywords', () => {
  it('detects pay and email phrases', () => {
    assert.equal(detectSensitiveKeywords('approve payment for supplies'), true);
    assert.equal(detectSensitiveKeywords('send email to patient'), true);
    assert.equal(detectSensitiveKeywords('assign Mike'), false);
  });
});

describe('preview/confirm gate', () => {
  it('preview returns a plan without calling Linear mutations', async () => {
    const mutationMock = mock.fn(async () => {
      throw new Error('mutation should not run during preview');
    });
    mock.method(opsCadence, 'applyOpsMutation', mutationMock);

    const preview = await previewOpsInstruction({
      instruction: 'create Daily standup notes assign Mike',
      cadence: 'Daily',
      ownerLabels,
      issues: mockIssues
    });

    assert.equal(preview.ok, true);
    assert.ok(preview.planId);
    assert.equal(preview.plan.action, 'create');
    assert.equal(mutationMock.mock.callCount(), 0);

    mock.restoreAll();
  });

  it('apply rejects when confirmed flag is false', async () => {
    const plan = {
      action: 'create',
      changes: { title: 'Test task', cadence: 'Daily', owner: 'Mike' }
    };
    const result = await applyOpsPlan({
      plan,
      planId: signPlan(plan),
      confirmed: false
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /confirmation required/i);
  });

  it('apply rejects tampered planId', async () => {
    const plan = {
      action: 'update',
      issueId: mockIssues[0].id,
      targetIdentifier: mockIssues[0].identifier,
      changes: { status: 'done' }
    };
    const result = await applyOpsPlan({
      plan,
      planId: 'bad-plan-id',
      confirmed: true
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /plan mismatch/i);
  });

  it('apply does not call Linear mutation until confirmed', async () => {
    const mutationMock = mock.fn(async () => ({ issue: mockIssues[0], action: 'update' }));
    mock.method(opsCadence, 'applyOpsMutation', mutationMock);

    const prevKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = 'test-key';

    const plan = {
      action: 'update',
      issueId: mockIssues[0].id,
      targetIdentifier: mockIssues[0].identifier,
      changes: { status: 'done' }
    };

    const blocked = await applyOpsPlan({ plan, planId: signPlan(plan), confirmed: false });
    assert.equal(blocked.ok, false);
    assert.equal(mutationMock.mock.callCount(), 0);

    const applied = await applyOpsPlan({ plan, planId: signPlan(plan), confirmed: true });
    assert.equal(applied.ok, true);
    assert.equal(mutationMock.mock.callCount(), 1);

    if (prevKey == null) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = prevKey;

    mock.restoreAll();
  });

  it('apply in demo mode succeeds without Linear mutation when no API key', async () => {
    const mutationMock = mock.fn(async () => {
      throw new Error('should not call Linear in demo mode');
    });
    mock.method(opsCadence, 'applyOpsMutation', mutationMock);

    const prevKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;

    const plan = {
      action: 'create',
      changes: { title: 'Demo task', cadence: 'Daily' }
    };
    const result = await applyOpsPlan({
      plan,
      planId: signPlan(plan),
      confirmed: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.mock, true);
    assert.equal(mutationMock.mock.callCount(), 0);

    if (prevKey != null) process.env.LINEAR_API_KEY = prevKey;

    mock.restoreAll();
  });
});

describe('resolveStateId', () => {
  it('maps status aliases to workflow state ids', () => {
    const states = [
      { id: 's1', name: 'Backlog', type: 'backlog' },
      { id: 's2', name: 'In Progress', type: 'started' },
      { id: 's3', name: 'Done', type: 'completed' }
    ];
    assert.equal(opsCadence.resolveStateId(states, 'done'), 's3');
    assert.equal(opsCadence.resolveStateId(states, 'progress'), 's2');
  });
});
