'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cityFromAddress, MONTEREY_OVERLAY, dropExcludedClinics, merge } = require('../scripts/merge-clinic-snapshot');
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

  it('drops Hurst / SWHBOT so a snapshot refresh cannot add it back', () => {
    const kept = dropExcludedClinics([
      { id: 'c-chula', name: 'Chula Vista' },
      { id: 'c-hurst', name: 'Hurst, TX (SWHBOT - sold/partner)', address: '1845 Precinct Line Rd Ste 105, Hurst, TX 76054' },
      { id: 'c-other', name: 'Southwest Hyperbaric of Hurst' }
    ]);
    assert.deepEqual(kept.map((c) => c.id), ['c-chula']);
    const seed = { clinics: [], kpis: {}, dataNotes: {} };
    const snap = {
      generated: '2026-11-02',
      clinics: [
        { id: 'c-chula', name: 'Chula Vista', address: '826 Starboard St, Chula Vista, CA 91914' },
        { id: 'c-hurst', name: 'Hurst, TX (SWHBOT - sold/partner)', address: '1845 Precinct Line Rd Ste 105, Hurst, TX 76054' }
      ],
      org: {},
      excluded: {}
    };
    const out = merge(seed, snap);
    assert.equal(out.clinics.length, 1);
    assert.equal(out.clinics[0].id, 'c-chula');
    assert.match(out.clinicSnapshot.excluded.Hurst, /not part of this partnership/i);
  });
});
