#!/usr/bin/env node
'use strict';

/**
 * Merge a clinic-snapshot-YYYY-MM-DD.json into data/command-center.json.
 * Keeps nodes, orgEdges, tasks, referrals, alerts. Replaces clinics + org KPI block.
 *
 * Usage: node scripts/merge-clinic-snapshot.js [path-to-snapshot.json]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SEED_PATH = path.join(ROOT, 'data', 'command-center.json');
const DEFAULT_SNAP = path.join(ROOT, 'data', 'clinic-snapshot-2026-11-02.json');

const MONTEREY_OVERLAY = {
  status: 'opening',
  statusNote: {
    text: 'Opening — not yet active. New employee starts this week (week of 2026-11-02) for training; treatments start next week (week of 2026-11-09).',
    source: 'Mike, 2026-11-02'
  },
  operatorHire: {
    status: 'training',
    start: 'week of 2026-11-02',
    treatmentsStart: 'week of 2026-11-09',
    label: 'New employee starts week of 2026-11-02 for training; treatments start week of 2026-11-09',
    source: 'Mike, 2026-11-02'
  }
};

/** Locations that must never land in Command Center clinic lists, even if a snapshot refresh includes them. */
const DROP_CLINICS = [
  {
    ids: new Set(['c-hurst']),
    nameRe: /hurst|\bswhbot\b/i,
    excludedKey: 'Hurst',
    reason: 'not part of this partnership (Mike); do not re-add on snapshot refresh'
  }
];

function isDroppedClinic(c) {
  const hay = `${c.id || ''} ${c.name || ''} ${c.address || ''} ${c.city || ''}`;
  return DROP_CLINICS.some((d) => d.ids.has(c.id) || d.nameRe.test(hay));
}

function dropExcludedClinics(clinics) {
  return (clinics || []).filter((c) => !isDroppedClinic(c));
}

function withDropNotes(excluded) {
  const next = { ...(excluded || {}) };
  DROP_CLINICS.forEach((d) => {
    next[d.excludedKey] = d.reason;
  });
  return next;
}

function cityFromAddress(address) {
  if (!address) return null;
  const cleaned = String(address).replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const city = parts[parts.length - 2];
    const st = parts[parts.length - 1].replace(/\d.*/g, '').trim();
    return st ? `${city}, ${st}` : city;
  }
  return cleaned || null;
}

function freshestAsOf(sources) {
  const dates = Object.values(sources || {})
    .map((s) => s && s.as_of)
    .filter(Boolean)
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
}

function taggedRevenueSum(clinics) {
  return clinics.reduce(
    (acc, c) => {
      if (c.revenue == null || Number.isNaN(Number(c.revenue))) return acc;
      return { value: acc.value + Number(c.revenue), n: acc.n + 1 };
    },
    { value: 0, n: 0 }
  );
}

function taggedReferralOpen(clinics) {
  return clinics.reduce(
    (acc, c) => {
      const n = c.referrals && typeof c.referrals.open === 'number' ? c.referrals.open : null;
      if (n == null) return acc;
      return { value: acc.value + n, n: acc.n + 1 };
    },
    { value: 0, n: 0 }
  );
}

function merge(seed, snap) {
  const clinics = dropExcludedClinics(snap.clinics || []).map((c) => {
    const row = { ...c, city: cityFromAddress(c.address), asOf: freshestAsOf(c._sources) || snap.generated || null };
    if (row.id === 'c-monterey') {
      row.status = MONTEREY_OVERLAY.status;
      row.statusNote = MONTEREY_OVERLAY.statusNote;
      row.operatorHire = MONTEREY_OVERLAY.operatorHire;
    }
    return row;
  });
  if (clinics.some(isDroppedClinic)) {
    throw new Error('Dropped clinic leaked into merge output');
  }

  const names = clinics.map((c) => (c.name || '').toLowerCase());
  if (names.some((n) => n === 'pleasanton' || n.includes('pleasanton') && !n.includes('pleasant hill'))) {
    throw new Error('Snapshot included Pleasanton as a clinic — it is storage/capex, not a clinic');
  }

  const pnl = (snap.org && snap.org.oct_pnl_draft) || {};
  const tagged = taggedRevenueSum(clinics);
  const refs = taggedReferralOpen(clinics);
  const unassignedOa = snap.org && snap.org.oct_unassigned_oa_net;
  const unassignedRefs = snap.org && snap.org.referrals_unassigned_open;

  seed.clinics = clinics;
  seed.clinicSnapshot = {
    generated: snap.generated,
    asOf: snap.generated,
    org: snap.org,
    excluded: withDropNotes(snap.excluded)
  };
  seed.org = snap.org;
  seed.lastModified = `${snap.generated || '2026-11-02'}T12:00:00.000Z`;
  seed.dataNotes = {
    ...(seed.dataNotes || {}),
    seedIsSourceOfTruth: true,
    clinicSnapshotFile: 'data/clinic-snapshot-2026-11-02.json',
    clinicAsOf: snap.generated,
    liveOverrideTodo:
      'TODO: Live /api/state persists to data/command-center.json at runtime. POST /api/reset to restore this snapshot seed.',
    pleasanton: (snap.excluded && snap.excluded.Pleasanton) || 'not a clinic',
    hurst: 'not part of this partnership (Mike); do not re-add on snapshot refresh'
  };

  seed.kpis = seed.kpis || {};
  seed.kpis.monthlyRevenue = {
    amount: pnl.revenue_candidate,
    currency: 'USD',
    period: pnl.month,
    periodLabel: pnl.label || 'October 2026 DRAFT',
    status: pnl.is_draft ? 'draft-estimate' : 'actual',
    source: (snap.org && snap.org._sources && snap.org._sources.oct_pnl_draft) || 'oct_summary.json',
    bankThru: pnl.bank_thru,
    caveat:
      'Clinic-tagged OA+Stripe is a lower bound because $172,685.69 of October Office Ally money is unassigned. Do not add TMS remit (overlaps OA).',
    noiDraft: pnl.noi_draft,
    opexDraft: pnl.opex,
    capex: pnl.capex,
    pnlUrl: pnl.pnl_url,
    clinicTaggedLowerBound: tagged.n ? tagged.value : null,
    clinicTaggedCount: tagged.n,
    unassignedOaOct: unassignedOa
  };

  const patientsByClinic = {};
  clinics.forEach((c) => {
    patientsByClinic[c.id] = c.patientsMonth == null ? null : c.patientsMonth;
  });
  seed.kpis.activePatients = {
    asOf: snap.generated,
    source: 'clinic-snapshot-2026-11-02.json patientsMonth (null = not yet available; Chula 12 is Aug paid-patient count, stale)',
    definition: 'Per-clinic patientsMonth from the snapshot only. No org total — most clinics are null.',
    sublabel: 'not yet available at org level',
    total: null,
    byClinic: patientsByClinic
  };

  seed.kpis.billingReferrals = {
    asOf: '2026-10-31',
    source: 'clinic-snapshot-2026-11-02.json referrals.open + org.referrals_unassigned_open',
    taggedOpen: refs.n ? refs.value : null,
    taggedClinicCount: refs.n,
    unassignedOpen: unassignedRefs,
    note: 'Tagged open referrals from clinics that have a referrals block. Unassigned is separate — not a clinic.',
    activeReferrals: refs.n ? refs.value : null
  };

  return seed;
}

function main() {
  const snapPath = path.resolve(process.argv[2] || DEFAULT_SNAP);
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  const destSnap = path.join(ROOT, 'data', 'clinic-snapshot-2026-11-02.json');
  if (path.resolve(snapPath) !== destSnap) {
    fs.copyFileSync(snapPath, destSnap);
  }
  const next = merge(seed, snap);
  fs.writeFileSync(SEED_PATH, JSON.stringify(next, null, 2) + '\n');
  console.log(`Merged ${next.clinics.length} clinics from ${snapPath} into ${SEED_PATH}`);
}

if (require.main === module) main();

module.exports = {
  merge,
  cityFromAddress,
  freshestAsOf,
  MONTEREY_OVERLAY,
  taggedRevenueSum,
  dropExcludedClinics,
  isDroppedClinic,
  DROP_CLINICS
};
