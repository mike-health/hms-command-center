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

  it('uses OA Active census (all clinics) for Active patients, not referral in-treatment', () => {
    const kpi = activePatientsKpi(seed);
    assert.equal(kpi.value, 532);
    assert.equal(kpi.isCensus, true);
    assert.equal(kpi.isProxy, false);
    assert.equal(kpi.sub, 'OA Active (all clinics) · as of 10/29');
    assert.match(kpi.source, /Office Ally Patient List Status='Active'/);
    assert.match(kpi.source, /10\/29\/2026/);
    assert.doesNotMatch(kpi.source, /in-treatment/i);
    assert.doesNotMatch(kpi.sub, /in treatment/i);
  });

  it('does not use referral-tracker in-treatment when OA census is missing', () => {
    const { oaActivePatients, ...kpisWithoutCensus } = seed.kpis;
    const kpi = activePatientsKpi({
      clinics: seed.clinics,
      kpis: kpisWithoutCensus
    });
    assert.equal(oaActivePatients.count, 532);
    assert.notEqual(kpi.value, 4);
    assert.equal(kpi.isProxy, false);
    assert.match(kpi.source, /patientsMonth/);
  });

  it('prefers OA Active census over clinic patientsMonth', () => {
    const kpi = activePatientsKpi({
      clinics: [{ status: 'operational', patientsMonth: 12 }],
      kpis: seed.kpis
    });
    assert.equal(kpi.value, 532);
    assert.equal(kpi.isCensus, true);
    assert.equal(kpi.sub, 'OA Active (all clinics) · as of 10/29');
  });

  it('falls back to clinic patientsMonth only when OA census is absent', () => {
    const kpi = activePatientsKpi({
      clinics: [{ status: 'operational', patientsMonth: 12 }],
      kpis: { billingReferrals: seed.kpis.billingReferrals }
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
    assert.match(kpi.source, /OA Active patients census/);
    assert.doesNotMatch(kpi.source, /double-counted/);
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
    assert.equal(s.activePatients.value, 532);
    assert.equal(s.activeReferrals.value, 33);
    assert.equal(s.monthlyRevenue.value, 250366.77);
  });

  it('seed stores OA Active count only — no PHI fields or restricted export path', () => {
    const raw = fs.readFileSync(path.join(__dirname, '../data/command-center.json'), 'utf-8');
    assert.doesNotMatch(raw, /RESTRICTED/);
    assert.doesNotMatch(raw, /all_offices_active_patient_list/);
    assert.doesNotMatch(raw, /date of birth/i);
    assert.doesNotMatch(raw, /"chartNumbers"/);
    const oa = seed.kpis.oaActivePatients;
    assert.equal(Object.keys(oa).sort().join(','), 'asOf,count,definition,source,sub');
    assert.equal(oa.count, 532);
  });
});
