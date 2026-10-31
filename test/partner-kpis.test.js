const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  partnerSummary,
  monthlyRevenueKpi,
  activePatientsKpi,
  activeReferralsKpi,
  montereyStaffing,
  siteProjectionKpi,
  cumulativeSitesOverMonths
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

  it('uses OA Oct HBOT visit census (CPT 99183), not the 4-row tracker proxy or 532 roster', () => {
    const kpi = activePatientsKpi(seed);
    assert.equal(kpi.value, 36);
    assert.equal(kpi.display, '36');
    assert.equal(kpi.isCensus, true);
    assert.equal(kpi.isProxy, false);
    assert.equal(kpi.sub, 'Oct HBOT visits · OA 10/31');
    assert.match(kpi.source, /Office Ally Patient Visits Report 2026-10-31/);
    assert.match(kpi.source, /99183/);
    assert.doesNotMatch(kpi.source, /billing\/referrals\.db/);
    assert.equal(seed.kpis.activePatients.total, 36);
    assert.equal(seed.kpis.activePatients.byClinic['c-chula'], 19);
    assert.equal(seed.kpis.activePatients.byClinic['c-salinas'], 7);
    assert.equal(seed.kpis.activePatients.byClinic['c-madras'], 5);
    assert.equal(seed.kpis.activePatients.byClinic['c-laguna'], 5);
    assert.equal(seed.kpis.activePatients.byClinic['c-oceanside'], 0);
    assert.equal(seed.kpis.activePatients.byClinic['c-monterey'], 0);
    assert.equal(seed.kpis.activePatients.byClinic['c-riverside'], 0);
    const byId = Object.fromEntries(seed.clinics.map((c) => [c.id, c.patientsMonth]));
    assert.equal(byId['c-chula'], 19);
    assert.equal(byId['c-salinas'], 7);
    assert.equal(byId['c-madras'], 5);
    assert.equal(byId['c-laguna'], 5);
    assert.equal(byId['c-oceanside'], 0);
    assert.equal(byId['c-monterey'], 0);
    assert.equal(byId['c-riverside'], 0);
    const clinicSum = seed.clinics.reduce((s, c) => s + (c.patientsMonth || 0), 0);
    assert.equal(clinicSum, 36);
    assert.ok(!seed.clinics.some((c) => /pleasant hill/i.test(c.name)));
  });

  it('does not use referral-tracker in-treatment when OA census is missing', () => {
    const { activePatients, ...kpisWithoutCensus } = seed.kpis;
    const kpi = activePatientsKpi({
      clinics: seed.clinics,
      kpis: kpisWithoutCensus
    });
    assert.equal(activePatients.total, 36);
    assert.notEqual(kpi.value, 4);
    assert.equal(kpi.isProxy, false);
    assert.match(kpi.source, /patientsMonth/);
  });

  it('prefers OA Oct HBOT census over clinic patientsMonth', () => {
    const kpi = activePatientsKpi({
      clinics: [{ status: 'operational', patientsMonth: 12 }],
      kpis: seed.kpis
    });
    assert.equal(kpi.value, 36);
    assert.equal(kpi.isCensus, true);
    assert.equal(kpi.sub, 'Oct HBOT visits · OA 10/31');
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
    assert.match(kpi.source, /OA Oct HBOT Active patients census/);
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
    assert.ok(s.siteProjection);
    assert.equal(s.activePatients.value, 36);
    assert.equal(s.activeReferrals.value, 33);
    assert.equal(s.monthlyRevenue.value, 250366.77);
  });

  it('site projection uses draft NOI as monthly capex margin (Mike 2026-10-31)', () => {
    const sp = siteProjectionKpi(seed);
    assert.equal(sp.monthlyCapexMargin, 169588);
    assert.equal(sp.costPerSite, 200000);
    assert.equal(sp.maxSitesPerMonth, 2);
    assert.equal(sp.sitesThisMonth, 0);
    assert.equal(sp.monthsToFirstSite, 2);
    assert.equal(sp.cumulative6Mo, 5);
    assert.equal(sp.isDraft, true);
    assert.match(sp.marginLabel, /169\.6k/);
    assert.match(sp.marginLabel, /DRAFT/);
    assert.equal(sp.displayValue, '0/2 this mo');
    assert.match(sp.sixMoLabel, /5 sites/);
  });

  it('site projection opens up to two sites when margin supports it', () => {
    const sp = siteProjectionKpi({
      clinics: [{ revenue: 900000, expenses: 0 }],
      kpis: seed.kpis
    });
    assert.equal(sp.monthlyCapexMargin, 900000);
    assert.equal(sp.sitesThisMonth, 2);
    assert.equal(sp.monthsToFirstSite, null);
    assert.equal(sp.isDraft, false);
    assert.equal(cumulativeSitesOverMonths(900000, 6), 12);
    assert.equal(sp.cumulative6Mo, 12);
  });

  it('site projection shows margin TBD when net is missing', () => {
    const sp = siteProjectionKpi({ clinics: [], kpis: {} });
    assert.equal(sp.monthlyCapexMargin, null);
    assert.equal(sp.sitesThisMonth, null);
    assert.match(sp.marginLabel, /Margin TBD/);
  });

  it('seed stores OA Active count only — no PHI fields or restricted export path', () => {
    const raw = fs.readFileSync(path.join(__dirname, '../data/command-center.json'), 'utf-8');
    assert.doesNotMatch(raw, /RESTRICTED/);
    assert.doesNotMatch(raw, /all_offices_active_patient_list/);
    assert.doesNotMatch(raw, /date of birth/i);
    assert.doesNotMatch(raw, /"chartNumbers"/);
    const oa = seed.kpis.activePatients;
    assert.ok(!seed.kpis.oaActivePatients);
    assert.equal(oa.total, 36);
    assert.doesNotMatch(JSON.stringify(oa), /chartNumber/i);
  });
});
