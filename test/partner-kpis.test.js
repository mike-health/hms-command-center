'use strict';

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
const { NOT_YET, hasMapPoint } = require('../lib/clinic-display');

const seed = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../data/command-center.json'), 'utf-8')
);

describe('partner KPIs from seed /api/state shape', () => {
  it('uses org Oct DRAFT revenue and labels clinic-tagged OA+Stripe as a lower bound', () => {
    const kpi = monthlyRevenueKpi(seed);
    assert.equal(kpi.isDraft, true);
    assert.equal(kpi.value, 250366.77);
    assert.match(kpi.display, /\$250,366\.77/);
    assert.match(kpi.periodLabel, /October 2026 DRAFT/);
    assert.equal(kpi.clinicTaggedLowerBound, 69703.51);
    assert.match(kpi.clinicTaggedLabel, /lower bound/i);
    assert.match(kpi.caveat, /172,685\.69/);
    assert.match(kpi.caveat, /unassigned/i);
    assert.match(kpi.caveat, /TMS/);
    assert.equal(kpi.unassignedOaOct, 172685.69);
  });

  it('does not add TMS remit into clinic-tagged revenue', () => {
    const chula = seed.clinics.find((c) => c.id === 'c-chula');
    assert.equal(chula.revenue, 52144.64);
    assert.equal(chula.rev_oct.oa + chula.rev_oct.stripe, 52144.64);
    assert.ok(chula.rev_oct.tms_overlaps_oa > 0);
    assert.notEqual(chula.revenue, chula.rev_oct.oa + chula.rev_oct.stripe + chula.rev_oct.tms_overlaps_oa);
  });

  it('does not treat tagged clinic revenue as complete actuals over the draft', () => {
    const kpi = monthlyRevenueKpi(seed);
    assert.equal(kpi.isDraft, true);
    assert.equal(kpi.value, 250366.77);
    assert.notEqual(kpi.value, kpi.clinicTaggedLowerBound);
  });

  it('does not invent an org active-patients total from partial clinic rows', () => {
    const kpi = activePatientsKpi(seed);
    assert.equal(kpi.value, null);
    assert.equal(kpi.display, NOT_YET);
    assert.equal(seed.kpis.activePatients.total, null);
    const chula = seed.clinics.find((c) => c.id === 'c-chula');
    assert.equal(chula.patientsMonth, 12);
    assert.equal(seed.clinics.find((c) => c.id === 'c-salinas').patientsMonth, null);
    assert.doesNotMatch(JSON.stringify(kpi), /"36"/);
  });

  it('does not coerce null expenses or patients to 0', () => {
    seed.clinics.forEach((c) => {
      if (c.expenses === 0) assert.fail(`${c.id} expenses should not be 0`);
      if (c.patientsMonth === 0) assert.fail(`${c.id} patientsMonth should not be 0`);
    });
    assert.equal(seed.clinics.find((c) => c.id === 'c-madras').revenue, null);
    assert.equal(seed.clinics.find((c) => c.id === 'c-madras').expenses, null);
  });

  it('counts tagged snapshot referral opens and keeps unassigned separate', () => {
    const kpi = activeReferralsKpi(seed);
    assert.equal(kpi.value, 32);
    assert.equal(kpi.unassignedOpen, 6);
    assert.match(kpi.sub, /32 tagged/);
    assert.match(kpi.sub, /6 unassigned/);
  });

  it('counts live non-placeholder referrals instead of the snapshot', () => {
    const kpi = activeReferralsKpi({
      referrals: [
        { id: 'r-live-1', status: 'pending', patientName: 'Ada', notes: 'live' },
        { id: 'r-live-2', status: 'open', patientName: 'Bea', notes: 'live' },
        { id: 'r-live-3', status: 'closed', patientName: 'Cara', notes: 'done' }
      ],
      kpis: seed.kpis,
      clinics: seed.clinics
    });
    assert.equal(kpi.value, 2);
    assert.equal(kpi.isProxy, false);
  });

  it('surfaces Monterey opening status from Mike 2026-11-02, not yet active', () => {
    const m = montereyStaffing(seed);
    assert.equal(m.clinicStatus, 'opening');
    assert.match(m.label, /not yet active/i);
    assert.match(m.label, /training/);
    assert.match(m.label, /treatments start/);
    assert.equal(m.source, 'Mike, 2026-11-02');
    assert.equal(m.hireStatus, 'training');
  });

  it('includes new clinics and keeps Pleasant Hill separate from Pleasanton', () => {
    const ids = seed.clinics.map((c) => c.id);
    assert.deepEqual(
      ids.sort(),
      [
        'c-chula',
        'c-laguna',
        'c-madras',
        'c-monterey',
        'c-oceanside',
        'c-pleasant-hill',
        'c-riverside',
        'c-salinas',
        'c-yuba-city'
      ]
    );
    assert.equal(seed.clinics.length, 9);
    assert.ok(seed.clinics.some((c) => c.id === 'c-pleasant-hill'));
    assert.ok(!seed.clinics.some((c) => /pleasanton/i.test(c.name)));
    assert.ok(!seed.clinics.some((c) => c.id === 'c-hurst' || /hurst|swhbot/i.test(c.name)));
    assert.match(seed.clinicSnapshot.excluded.Pleasanton, /not a clinic/i);
    assert.match(seed.clinicSnapshot.excluded.Hurst, /not part of this partnership/i);
    assert.equal(seed.clinics.find((c) => c.id === 'c-riverside').status, 'build');
    assert.equal(seed.clinics.find((c) => c.id === 'c-yuba-city').status, 'planned');
    assert.equal(hasMapPoint(seed.clinics.find((c) => c.id === 'c-yuba-city')), false);
    assert.equal(hasMapPoint(seed.clinics.find((c) => c.id === 'c-chula')), true);
  });

  it('partnerSummary includes snapshot as-of and four partner signals', () => {
    const s = partnerSummary(seed);
    assert.ok(s.monthlyRevenue);
    assert.ok(s.activePatients);
    assert.ok(s.activeReferrals);
    assert.ok(s.monterey);
    assert.equal(s.asOf, '2026-11-02');
    assert.equal(s.activePatients.display, NOT_YET);
    assert.equal(s.activeReferrals.value, 32);
    assert.equal(s.monthlyRevenue.value, 250366.77);
  });

  it('seed stores OA counts only — no PHI fields or restricted export path', () => {
    const raw = fs.readFileSync(path.join(__dirname, '../data/command-center.json'), 'utf-8');
    assert.doesNotMatch(raw, /RESTRICTED/);
    assert.doesNotMatch(raw, /all_offices_active_patient_list/);
    assert.doesNotMatch(raw, /date of birth/i);
    assert.doesNotMatch(raw, /"chartNumbers"/);
  });
});
