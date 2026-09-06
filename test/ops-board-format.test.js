'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatDue } = require('../public/js/ops-board-format');

describe('formatDue', () => {
  it('returns { label, overdue } for null, undefined, and empty string', () => {
    for (const value of [null, undefined, '']) {
      const result = formatDue(value);
      assert.deepEqual(result, { label: '—', overdue: false });
    }
  });

  it('returns formatted label and overdue flag for valid ISO dates', () => {
    const future = formatDue('2099-12-31');
    assert.equal(future.label, 'Dec 31');
    assert.equal(future.overdue, false);

    const past = formatDue('2020-01-15');
    assert.equal(past.label, 'Jan 15');
    assert.equal(past.overdue, true);
  });

  it('returns safe fallback for invalid date strings', () => {
    assert.deepEqual(formatDue('not-a-date'), { label: '—', overdue: false });
  });
});
