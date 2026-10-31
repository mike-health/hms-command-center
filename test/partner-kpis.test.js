const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  partnerSummary,
  monthlyRevenueKpi,
  activePatientsKpi,
  activeReferralsKpi,
  montereyStaffing
} = require('../lib/partner-kpis');

const seed = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../data/command-center.json'), 'utf-8')
);

describe('partner KPIs from seed /api/state shape', () => {
  it('uses labeled P&L draft when clinic revenue fields are zero', () => {
    const kpi = monthlyRevenueKpi(seed);
    assert.equal(kpi.isDraft, true);
    assert.equal(kpi.gap, true);
    assert.equal(kpi.value, 250366.77);
    assert.match(kpi.display, /\$250,366\.77/);
    assert.match(kpi.source, /HMS P&L v1/);
    assert.match(kpi.source, /Oct 1/);
  });

  it('prefers live clinic revenue over the draft estimate', () => {
    const kpi = monthlyRevenueKpi({
      clinics: [{ revenue: 1000, expenses: 200 }],
      kpis: seed.kpis
    });
    assert.equal(kpi.isDraft, false);
    assert.equal(kpi.value, 1000);
    assert.match(kpi.source, /clinics\[\]\.revenue/);
  });

  it('sums patientsMonth honestly (seed is all zeros)', () => {
    const kpi = activePatientsKpi(seed);
    assert.equal(kpi.value, 0);
    assert.match(kpi.source, /patientsMonth/);
  });

  it('counts pending sample referral as active pipeline', () => {
    const kpi = activeReferralsKpi(seed);
    assert.equal(kpi.value, 1);
    assert.match(kpi.sub, /pending/);
  });

  it('surfaces Monterey tentative operator hire, not confirmed hired', () => {
    const m = montereyStaffing(seed);
    assert.match(m.label, /Finnlee Morgan/);
    assert.match(m.label, /tentative start/);
    assert.equal(m.hireStatus, 'tentative');
    assert.doesNotMatch(m.label.toLowerCase(), /hired confirmed/);
  });

  it('partnerSummary includes all four partner signals', () => {
    const s = partnerSummary(seed);
    assert.ok(s.monthlyRevenue);
    assert.ok(s.activePatients);
    assert.ok(s.activeReferrals);
    assert.ok(s.monterey);
  });
});
