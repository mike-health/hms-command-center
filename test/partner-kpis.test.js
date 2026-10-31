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
    assert.match(kpi.periodLabel, /Oct MTD \(to 10\/28\)/);
    assert.match(kpi.source, /Oct MTD/);
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

  it('uses billing referral-tracker in-treatment proxy when patientsMonth is zero', () => {
    const kpi = activePatientsKpi(seed);
    assert.equal(kpi.value, 4);
    assert.equal(kpi.isProxy, true);
    assert.match(kpi.sub, /Open referral pipeline: ~37/);
    assert.match(kpi.source, /billing\/referrals\.db as of 2026-10-31/);
    assert.match(kpi.source, /in treatment/);
  });

  it('prefers live clinic patientsMonth over the billing proxy', () => {
    const kpi = activePatientsKpi({
      clinics: [{ status: 'operational', patientsMonth: 12 }],
      kpis: seed.kpis
    });
    assert.equal(kpi.value, 12);
    assert.equal(kpi.isProxy, false);
    assert.match(kpi.source, /patientsMonth/);
  });

  it('uses billing open pipeline minus in-treatment for Active referrals', () => {
    const kpi = activeReferralsKpi(seed);
    assert.equal(kpi.value, 33);
    assert.equal(kpi.isProxy, true);
    assert.match(kpi.sub, /authorized/i);
    assert.match(kpi.source, /billing\/referrals\.db as of 2026-10-31/);
    assert.match(kpi.source, /37/);
  });

  it('counts live non-placeholder referrals instead of the billing seed', () => {
    const kpi = activeReferralsKpi({
      referrals: [
        { id: 'r-live-1', status: 'pending', patientName: 'Ada', notes: 'live' },
        { id: 'r-live-2', status: 'open', patientName: 'Bea', notes: 'live' },
        { id: 'r-live-3', status: 'closed', patientName: 'Cara', notes: 'done' }
      ],
      kpis: seed.kpis
    });
    assert.equal(kpi.value, 2);
    assert.equal(kpi.isProxy, false);
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
