'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  collectOwnerLabels,
  filterOpsIssues,
  mapLinearIssue,
  mapPriority,
  mockBoard,
  streamFromLabels
} = require('../lib/ops-cadence');

describe('mapLinearIssue', () => {
  it('splits Cadence vs Owner labels by name set and parent group', () => {
    const mapped = mapLinearIssue(
      {
        id: '1',
        identifier: 'HEA-82',
        title: 'Door punch',
        url: 'https://linear.app/healthi/issue/HEA-82',
        dueDate: null,
        state: { name: 'Backlog', type: 'backlog' },
        labels: {
          nodes: [
            { name: 'Daily', parent: { name: 'Cadence' } },
            { name: 'Rudy', parent: { name: 'Owner' } },
            { name: 'Feature', parent: null }
          ]
        }
      },
      new Set(['Rudy', 'Stacey', 'Mike'])
    );
    assert.deepEqual(mapped.cadenceLabels, ['Daily']);
    assert.deepEqual(mapped.ownerLabels, ['Rudy']);
    assert.equal(mapped.status, 'Backlog');
    assert.equal(mapped.streamLabel, null);
    assert.equal(mapped.priority, null);
  });

  it('maps Stream label group and Linear priority', () => {
    const mapped = mapLinearIssue(
      {
        id: '2',
        identifier: 'HEA-90',
        title: 'Chamber install',
        url: 'https://linear.app/healthi/issue/HEA-90',
        dueDate: '2026-09-08',
        priority: 2,
        state: { name: 'In Progress', type: 'started' },
        labels: {
          nodes: [
            { name: 'Weekly', parent: { name: 'Cadence' } },
            { name: 'Clinical', parent: { name: 'Stream' } },
            { name: 'Stacey', parent: { name: 'Owner' } }
          ]
        }
      },
      new Set(['Stacey'])
    );
    assert.equal(mapped.streamLabel, 'Clinical');
    assert.equal(mapped.priority, 'High');
    assert.equal(mapped.status, 'In Progress');
  });
});

describe('mapPriority', () => {
  it('returns null for unset priority and labels for 1–4', () => {
    assert.equal(mapPriority(0), null);
    assert.equal(mapPriority(null), null);
    assert.equal(mapPriority(1), 'Urgent');
    assert.equal(mapPriority(3), 'Medium');
  });
});

describe('streamFromLabels', () => {
  it('picks first Stream group label', () => {
    assert.equal(
      streamFromLabels([
        { name: 'Finance', parent: { name: 'Stream' } },
        { name: 'Equipment', parent: { name: 'Stream' } }
      ]),
      'Finance'
    );
    assert.equal(streamFromLabels([{ name: 'Mike', parent: { name: 'Owner' } }]), null);
  });
});

describe('filterOpsIssues', () => {
  const issues = mockBoard().issues;

  it('keeps cadence tab matches only', () => {
    const daily = filterOpsIssues(issues, 'Daily', []);
    assert.ok(daily.every((i) => i.cadenceLabels.includes('Daily')));
    assert.equal(filterOpsIssues(issues, 'Weekly', []).length, 1);
    assert.equal(filterOpsIssues(issues, 'Monthly', []).length, 1);
  });

  it('treats empty owner selection as all people', () => {
    const dailyAll = filterOpsIssues(issues, 'Daily', []);
    const dailyEmpty = filterOpsIssues(issues, 'Daily', null);
    assert.equal(dailyAll.length, dailyEmpty.length);
    assert.ok(dailyAll.length >= 2);
  });

  it('matches any selected Owner label (not assignee)', () => {
    const rudy = filterOpsIssues(issues, 'Daily', ['Rudy']);
    assert.equal(rudy.length, 1);
    assert.equal(rudy[0].identifier, 'HEA-82');
    const both = filterOpsIssues(issues, 'Daily', ['Rudy', 'Mike']);
    assert.equal(both.length, 2);
  });
});

describe('collectOwnerLabels', () => {
  it('prefers Linear Owner group labels', () => {
    const names = collectOwnerLabels(
      [
        { name: 'Stacey', parent: { name: 'Owner' } },
        { name: 'Daily', parent: { name: 'Cadence' } },
        { name: 'Mike', parent: { name: 'Owner' } }
      ],
      []
    );
    assert.deepEqual(names, ['Mike', 'Stacey']);
  });
});
