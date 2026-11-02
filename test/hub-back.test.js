'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { HUB_URL, arrivedFromThisSite, resolveHubBackTarget } = require('../lib/hub-back');

const ORIGIN = 'https://hms-command-center.onrender.com';

describe('hub back navigation', () => {
  it('uses history when referrer is another Command Center page', () => {
    const ref = `${ORIGIN}/modules/org-chart.html`;
    assert.equal(arrivedFromThisSite(ref, ORIGIN), true);
    assert.deepEqual(resolveHubBackTarget(ref, ORIGIN), { type: 'history' });
  });

  it('goes to the partner hub when opened from the hub', () => {
    const ref = 'https://hms-partner-news.netlify.app/';
    assert.equal(arrivedFromThisSite(ref, ORIGIN), false);
    assert.deepEqual(resolveHubBackTarget(ref, ORIGIN), { type: 'redirect', url: HUB_URL });
  });

  it('goes to the partner hub on a fresh tab with no referrer', () => {
    assert.equal(arrivedFromThisSite('', ORIGIN), false);
    assert.deepEqual(resolveHubBackTarget('', ORIGIN), { type: 'redirect', url: HUB_URL });
    assert.deepEqual(resolveHubBackTarget(undefined, ORIGIN), { type: 'redirect', url: HUB_URL });
  });
});
