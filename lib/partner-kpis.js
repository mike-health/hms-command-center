/**
 * Partner-facing dashboard KPIs derived from /api/state (clinics, referrals, kpis).
 * Clinic revenue/patientsMonth are preferred. Draft P&L figures are labeled estimates only.
 */

const ACTIVE_REFERRAL_STATUSES = new Set(['active', 'pending', 'open']);

function sumClinicField(clinics, field) {
  return (clinics || []).reduce((sum, clinic) => sum + (Number(clinic[field]) || 0), 0);
}

function hasPositiveClinicRevenue(clinics) {
  return (clinics || []).some((clinic) => (Number(clinic.revenue) || 0) > 0);
}

function formatUsd(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(Number(amount));
}

function monthlyRevenueKpi(state) {
  const clinics = state.clinics || [];
  const clinicSum = sumClinicField(clinics, 'revenue');
  const expenseSum = sumClinicField(clinics, 'expenses');

  if (hasPositiveClinicRevenue(clinics)) {
    return {
      value: clinicSum,
      display: formatUsd(clinicSum),
      source: 'Sum of clinics[].revenue from /api/state',
      isDraft: false,
      gap: false,
      net: clinicSum - expenseSum,
      netLabel: `Net: ${formatUsd(clinicSum - expenseSum)}`
    };
  }

  const draft = state.kpis && state.kpis.monthlyRevenue;
  if (draft && typeof draft.amount === 'number') {
    const noi = draft.noiDraft;
    return {
      value: draft.amount,
      display: formatUsd(draft.amount),
      periodLabel: draft.periodLabel || 'Draft estimate',
      source: [draft.source, draft.periodLabel].filter(Boolean).join(' · '),
      caveat: draft.caveat || 'Clinic revenue fields in /api/state are $0.',
      isDraft: true,
      gap: true,
      net: noi,
      netLabel: noi != null ? `NOI draft ${formatUsd(noi)}` : ''
    };
  }

  return {
    value: null,
    display: '—',
    source: 'No clinic.revenue in /api/state (all zero or missing)',
    isDraft: false,
    gap: true,
    net: null,
    netLabel: 'Revenue not in clinic fields'
  };
}

function billingReferralsFacts(state) {
  return (state.kpis && state.kpis.billingReferrals) || null;
}

function hasPositiveClinicPatients(clinics) {
  return (clinics || []).some((clinic) => (Number(clinic.patientsMonth) || 0) > 0);
}

function activePatientsKpi(state) {
  const clinics = state.clinics || [];
  const total = sumClinicField(clinics, 'patientsMonth');
  const operational = clinics.filter((c) => c.status === 'operational').length;

  if (hasPositiveClinicPatients(clinics)) {
    return {
      value: total,
      display: String(total),
      source: 'Sum of clinics[].patientsMonth from /api/state',
      sub: `Across ${operational} operational clinic${operational === 1 ? '' : 's'}`,
      isProxy: false
    };
  }

  const billing = billingReferralsFacts(state);
  if (billing && typeof billing.inTreatment === 'number') {
    const pipeline =
      billing.openPipelineLabel ||
      (typeof billing.openPipeline === 'number'
        ? `Open referral pipeline: ~${billing.openPipeline}`
        : '');
    const statuses = (billing.inTreatmentStatuses || []).join('; ');
    return {
      value: billing.inTreatment,
      display: String(billing.inTreatment),
      source: [
        billing.source || 'billing/referrals.db',
        statuses ? `in-care: ${statuses}` : '',
        billing.note || 'No clinic census SoT; referral-tracker proxy'
      ]
        .filter(Boolean)
        .join(' — '),
      sub: pipeline,
      isProxy: true
    };
  }

  return {
    value: total,
    display: String(total),
    source: 'Sum of clinics[].patientsMonth from /api/state',
    sub: 'No patientsMonth values in clinic state (all 0)',
    isProxy: false
  };
}

function hasLiveReferralRows(referrals) {
  const rows = referrals || [];
  return rows.some((r) => r && r.id !== 'r1' && !/placeholder/i.test(r.notes || r.patientName || ''));
}

function activeReferralsKpi(state) {
  const referrals = state.referrals || [];
  const billing = billingReferralsFacts(state);

  if (!hasLiveReferralRows(referrals) && billing && typeof billing.activeReferrals === 'number') {
    const statuses = (billing.activeReferralStatuses || []).join(' / ');
    return {
      value: billing.activeReferrals,
      display: String(billing.activeReferrals),
      source: [
        billing.source || 'billing/referrals.db',
        billing.activeReferralsNote ||
          'Authorized/waiting/cleared-not-booked/open; excludes in-treatment'
      ]
        .filter(Boolean)
        .join(' — '),
      sub: statuses
        ? `${statuses} (excludes in-treatment patients)`
        : 'Open pipeline excluding in-treatment patients',
      isProxy: true
    };
  }

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
  const label =
    hire.label ||
    clinic.notes ||
    'No Monterey staffing note in state';
  return {
    id: clinic.id,
    name: clinic.name,
    city: clinic.city,
    clinicStatus: clinic.status,
    notes: clinic.notes,
    operatorName: hire.name || null,
    hireStatus: hire.status || 'unknown',
    label,
    highlight: true
  };
}

function partnerSummary(state) {
  return {
    monthlyRevenue: monthlyRevenueKpi(state),
    activePatients: activePatientsKpi(state),
    activeReferrals: activeReferralsKpi(state),
    monterey: montereyStaffing(state)
  };
}

module.exports = {
  ACTIVE_REFERRAL_STATUSES,
  sumClinicField,
  formatUsd,
  monthlyRevenueKpi,
  activePatientsKpi,
  activeReferralsKpi,
  montereyStaffing,
  partnerSummary,
  hasLiveReferralRows
};
