/**
 * Partner-facing dashboard KPIs from /api/state.
 * Clinic-tagged OA+Stripe is a lower bound (unassigned Oct OA must not be guessed).
 * TMS remit overlaps OA — never add it to OA+Stripe.
 * Null clinic fields stay null (display as "not yet available"), never coerced to 0.
 */

const { formatUsd, displayValue, NOT_YET } = require('./clinic-display');

const ACTIVE_REFERRAL_STATUSES = new Set(['active', 'pending', 'open']);

function sumDefined(clinics, field) {
  let sum = 0;
  let n = 0;
  (clinics || []).forEach((clinic) => {
    const v = clinic[field];
    if (v == null || Number.isNaN(Number(v))) return;
    sum += Number(v);
    n += 1;
  });
  return { value: n ? sum : null, n };
}

function orgDraft(state) {
  return (state.clinicSnapshot && state.clinicSnapshot.org && state.clinicSnapshot.org.oct_pnl_draft)
    || (state.org && state.org.oct_pnl_draft)
    || null;
}

function unassignedOa(state) {
  const fromOrg = (state.clinicSnapshot && state.clinicSnapshot.org && state.clinicSnapshot.org.oct_unassigned_oa_net)
    || (state.org && state.org.oct_unassigned_oa_net);
  if (fromOrg != null) return fromOrg;
  const k = state.kpis && state.kpis.monthlyRevenue;
  return k && k.unassignedOaOct;
}

function monthlyRevenueKpi(state) {
  const tagged = sumDefined(state.clinics, 'revenue');
  const draftPnl = orgDraft(state);
  const k = (state.kpis && state.kpis.monthlyRevenue) || {};
  const amount = (draftPnl && draftPnl.revenue_candidate) || k.amount;
  const unassigned = unassignedOa(state);
  const caveat = k.caveat
    || (unassigned != null
      ? `Clinic-tagged OA+Stripe is a lower bound because $${Number(unassigned).toLocaleString('en-US')} of October Office Ally money is unassigned. Do not add TMS remit (overlaps OA).`
      : null);

  if (typeof amount === 'number') {
    const noi = (draftPnl && draftPnl.noi_draft) || k.noiDraft;
    const opex = (draftPnl && draftPnl.opex) || k.opexDraft;
    return {
      value: amount,
      display: formatUsd(amount),
      periodLabel: (draftPnl && draftPnl.label) || k.periodLabel || 'October 2026 DRAFT',
      source: k.source || 'oct_summary.json',
      caveat,
      isDraft: true,
      gap: unassigned != null,
      net: noi,
      netLabel: noi != null ? `NOI draft ${formatUsd(noi)}` : '',
      opex: opex != null ? formatUsd(opex) : NOT_YET,
      clinicTaggedLowerBound: tagged.value,
      clinicTaggedLabel: tagged.value != null
        ? `Clinic-tagged OA+Stripe ${formatUsd(tagged.value)} (lower bound; TMS not added)`
        : `Clinic-tagged OA+Stripe ${NOT_YET}`,
      unassignedOaOct: unassigned
    };
  }

  if (tagged.value != null) {
    return {
      value: tagged.value,
      display: formatUsd(tagged.value),
      source: 'Sum of non-null clinics[].revenue (OA+Stripe tagged only; TMS not added)',
      caveat: caveat || 'Lower bound — unassigned Office Ally not attributed to clinics.',
      isDraft: false,
      gap: true,
      net: null,
      netLabel: '',
      clinicTaggedLowerBound: tagged.value,
      clinicTaggedLabel: `Clinic-tagged OA+Stripe ${formatUsd(tagged.value)} (lower bound; TMS not added)`,
      unassignedOaOct: unassigned
    };
  }

  return {
    value: null,
    display: NOT_YET,
    source: 'No org draft or clinic-tagged revenue in /api/state',
    isDraft: false,
    gap: true,
    net: null,
    netLabel: '',
    clinicTaggedLowerBound: null,
    clinicTaggedLabel: `Clinic-tagged OA+Stripe ${NOT_YET}`
  };
}

function billingReferralsFacts(state) {
  return (state.kpis && state.kpis.billingReferrals) || null;
}

function officeAllyCensus(state) {
  const raw =
    (state.kpis && state.kpis.activePatients) ||
    (state.kpis && state.kpis.oaActivePatients) ||
    null;
  if (!raw) return null;
  const total = typeof raw.total === 'number' ? raw.total : null;
  return {
    ...raw,
    total,
    sublabel: raw.sublabel || raw.sub
  };
}

function oaActivePatientsFacts(state) {
  const oa = officeAllyCensus(state);
  if (!oa || typeof oa.total !== 'number') return null;
  return {
    count: oa.total,
    asOf: oa.asOf,
    sub: oa.sublabel,
    source: oa.source,
    definition: oa.definition
  };
}

function activePatientsKpi(state) {
  const oa = officeAllyCensus(state);
  if (oa && typeof oa.total === 'number') {
    return {
      value: oa.total,
      display: String(oa.total),
      source: [oa.source || 'Office Ally Patient Visits Report', oa.definition]
        .filter(Boolean)
        .join(' — '),
      sub: oa.sublabel || '',
      isProxy: false,
      isCensus: true
    };
  }

  const tagged = sumDefined(state.clinics, 'patientsMonth');
  const missing = (state.clinics || []).length - tagged.n;
  if (tagged.n && missing === 0) {
    return {
      value: tagged.value,
      display: String(tagged.value),
      source: 'Sum of clinics[].patientsMonth from /api/state',
      sub: `Across ${tagged.n} clinics`,
      isProxy: false,
      isCensus: false
    };
  }

  return {
    value: null,
    display: NOT_YET,
    source: oa && oa.source
      ? oa.source
      : 'clinic-snapshot patientsMonth — most clinics null; no org total',
    sub: oa && oa.sublabel ? oa.sublabel : 'not yet available (do not sum partial clinic rows)',
    isProxy: false,
    isCensus: false
  };
}

function hasLiveReferralRows(referrals) {
  const rows = referrals || [];
  return rows.some((r) => r && r.id !== 'r1' && !/placeholder/i.test(r.notes || r.patientName || ''));
}

function snapshotReferralOpen(state) {
  const tagged = (state.clinics || []).reduce(
    (acc, c) => {
      const n = c.referrals && typeof c.referrals.open === 'number' ? c.referrals.open : null;
      if (n == null) return acc;
      return { value: acc.value + n, n: acc.n + 1 };
    },
    { value: 0, n: 0 }
  );
  const unassigned =
    (state.clinicSnapshot && state.clinicSnapshot.org && state.clinicSnapshot.org.referrals_unassigned_open)
    || (state.org && state.org.referrals_unassigned_open)
    || (state.kpis && state.kpis.billingReferrals && state.kpis.billingReferrals.unassignedOpen);
  return {
    tagged: tagged.n ? tagged.value : null,
    taggedN: tagged.n,
    unassigned: typeof unassigned === 'number' ? unassigned : null
  };
}

function activeReferralsKpi(state) {
  const referrals = state.referrals || [];
  if (hasLiveReferralRows(referrals)) {
    const active = referrals.filter((r) => ACTIVE_REFERRAL_STATUSES.has(r.status));
    const pending = referrals.filter((r) => r.status === 'pending').length;
    return {
      value: active.length,
      display: String(active.length),
      source: 'Count of referrals with status active, pending, or open',
      sub: pending ? `${pending} pending` : `${referrals.length} total in state`,
      isProxy: false
    };
  }

  const snap = snapshotReferralOpen(state);
  if (snap.tagged != null) {
    const parts = [`${snap.tagged} tagged open`];
    if (snap.unassigned != null) parts.push(`${snap.unassigned} unassigned`);
    return {
      value: snap.tagged,
      display: String(snap.tagged),
      source: 'clinic-snapshot referrals.open (clinics with a referrals block only)',
      sub: parts.join(' · '),
      unassignedOpen: snap.unassigned,
      isProxy: false
    };
  }

  const billing = billingReferralsFacts(state);
  if (billing && typeof billing.activeReferrals === 'number') {
    return {
      value: billing.activeReferrals,
      display: String(billing.activeReferrals),
      source: billing.source || 'kpis.billingReferrals',
      sub: billing.note || '',
      isProxy: true
    };
  }

  return {
    value: null,
    display: NOT_YET,
    source: 'No referral counts in snapshot or live rows',
    sub: '',
    isProxy: false
  };
}

function montereyStaffing(state) {
  const clinic = (state.clinics || []).find((c) => c.id === 'c-monterey');
  if (!clinic) {
    return {
      id: 'c-monterey',
      name: 'Monterey',
      label: 'Monterey clinic missing from /api/state',
      status: 'missing',
      highlight: true
    };
  }
  const hire = clinic.operatorHire || {};
  const statusNote = clinic.statusNote || {};
  const label =
    statusNote.text ||
    hire.label ||
    clinic.notes ||
    'No Monterey staffing note in state';
  return {
    id: clinic.id,
    name: clinic.name,
    city: clinic.city,
    clinicStatus: clinic.status,
    notes: clinic.notes,
    statusNote,
    operatorName: hire.name || null,
    hireStatus: hire.status || 'unknown',
    source: statusNote.source || hire.source || null,
    label,
    highlight: true
  };
}

function partnerSummary(state) {
  return {
    monthlyRevenue: monthlyRevenueKpi(state),
    activePatients: activePatientsKpi(state),
    activeReferrals: activeReferralsKpi(state),
    monterey: montereyStaffing(state),
    asOf: (state.clinicSnapshot && (state.clinicSnapshot.asOf || state.clinicSnapshot.generated)) || null
  };
}

module.exports = {
  ACTIVE_REFERRAL_STATUSES,
  sumDefined,
  formatUsd,
  displayValue,
  monthlyRevenueKpi,
  activePatientsKpi,
  activeReferralsKpi,
  montereyStaffing,
  partnerSummary,
  hasLiveReferralRows,
  oaActivePatientsFacts,
  snapshotReferralOpen
};
