'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cityFromAddress, MONTEREY_OVERLAY } = require('../scripts/merge-clinic-snapshot');
const { displayValue, formatUsd, NOT_YET, hasMapPoint } = require('../lib/clinic-display');

describe('clinic snapshot merge helpers', () => {
  it('parses city from snapshot addresses without inventing them', () => {
    assert.equal(cityFromAddress('826 Starboard St, Chula Vista, CA 91914'), 'Chula Vista, CA');
    assert.equal(cityFromAddress('450 Queens Ave, Yuba City, CA 95991 (APN 51-560-110)'), 'Yuba City, CA');
    assert.equal(cityFromAddress(null), null);
  });

  it('shows null as not yet available and never as 0', () => {
    assert.equal(displayValue(null), NOT_YET);
    assert.equal(formatUsd(null), NOT_YET);
    assert.equal(displayValue(0), '0');
    assert.equal(hasMapPoint({ lat: null, lng: null }), false);
  });

  it('keeps Mike 2026-11-02 Monterey overlay copy', () => {
    assert.equal(MONTEREY_OVERLAY.status, 'opening');
    assert.equal(MONTEREY_OVERLAY.statusNote.source, 'Mike, 2026-11-02');
  });
});
