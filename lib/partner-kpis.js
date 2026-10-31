/**
 * Partner-facing dashboard KPIs derived from /api/state (clinics, referrals, kpis).
 * Active patients uses OA Oct HBOT visits (CPT 99183 unique) when kpis.activePatients
 * is seeded (Mike 2026-10-31). Billing in-treatment is a last-resort proxy only.
 * Draft P&L figures are labeled estimates only.
 */

const ACTIVE_REFERRAL_STATUSES = new Set(['active', 'pending', 'open']);
const SITE_COST_USD = 200000;
const MAX_SITES_PER_MONTH = 2;

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

function formatUsdCompact(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return null;
  const n = Number(amount);
  if (Math.abs(n) >= 1000) {
    const k = n / 1000;
    const rounded = k >= 1000 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, '');
    return `$${rounded}k`;
  }
  return formatUsd(n);
}

function monthsUntilFirstSite(monthlyMargin, costPerSite = SITE_COST_USD) {
  if (monthlyMargin == null || monthlyMargin <= 0) return null;
  if (Math.floor(monthlyMargin / costPerSite) >= 1) return null;
  let pool = 0;
  for (let month = 1; month <= 240; month += 1) {
    pool += monthlyMargin;
    const canOpen = Math.min(MAX_SITES_PER_MONTH, Math.floor(pool / costPerSite));
    if (canOpen >= 1) return month;
  }
  return null;
}

function cumulativeSitesOverMonths(
  monthlyMargin,
  numMonths,
  costPerSite = SITE_COST_USD,
  maxPerMonth = MAX_SITES_PER_MONTH
) {
  if (monthlyMargin == null || monthlyMargin <= 0) return 0;
  let pool = 0;
  let total = 0;
  for (let i = 0; i < numMonths; i += 1) {
    pool += monthlyMargin;
    const sites = Math.min(maxPerMonth, Math.floor(pool / costPerSite));
    total += sites;
    pool -= sites * costPerSite;
  }
  return total;
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

function officeAllyCensus(state) {
  const raw =
    (state.kpis && state.kpis.activePatients) ||
    (state.kpis && state.kpis.oaActivePatients) ||
    null;
  if (!raw) return null;
  const total = typeof raw.total === 'number' ? raw.total : raw.count;
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

function hasPositiveClinicPatients(clinics) {
  return (clinics || []).some((clinic) => (Number(clinic.patientsMonth) || 0) > 0);
}

function oaCensusKpi(oa) {
  return {
    value: oa.total,
    display: String(oa.total),
    source: [oa.source || 'Office Ally Patient Visits Report', oa.definition]
      .filter(Boolean)
      .join(' — '),
    sub: oa.sublabel || 'Oct HBOT visits · OA 10/31',
    isProxy: false,
    isCensus: true
  };
}

function activePatientsKpi(state) {
  const oa = officeAllyCensus(state);
  if (oa && typeof oa.total === 'number') {
    return oaCensusKpi(oa);
  }

  const clinics = state.clinics || [];
  const total = sumClinicField(clinics, 'patientsMonth');
  const operational = clinics.filter((c) => c.status === 'operational').length;

  if (hasPositiveClinicPatients(clinics)) {
    return {
      value: total,
      display: String(total),
      source: 'Sum of clinics[].patientsMonth from /api/state',
      sub: `Across ${operational} operational clinic${operational === 1 ? '' : 's'}`,
      isProxy: false,
      isCensus: false
    };
  }

  return {
    value: total,
    display: String(total),
    source: 'Sum of clinics[].patientsMonth from /api/state',
    sub: 'No OA Oct HBOT census or patientsMonth values in state',
    isProxy: false,
    isCensus: false
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

function siteProjectionKpi(state) {
  const rev = monthlyRevenueKpi(state);
  const override =
    state.kpis &&
    state.kpis.siteProjection &&
    typeof state.kpis.siteProjection.monthlyCapexMargin === 'number'
      ? state.kpis.siteProjection.monthlyCapexMargin
      : null;
  const margin = override != null ? override : rev.net;
  const isDraft = override == null && rev.isDraft === true;
  const costPerSite = SITE_COST_USD;
  const maxSitesPerMonth = MAX_SITES_PER_MONTH;

  let sitesThisMonth = null;
  let monthsToFirstSite = null;
  let cumulative6Mo = null;

  if (typeof margin === 'number' && !Number.isNaN(margin)) {
    sitesThisMonth = Math.min(maxSitesPerMonth, Math.floor(margin / costPerSite));
    monthsToFirstSite =
      sitesThisMonth >= 1 ? null : monthsUntilFirstSite(margin, costPerSite);
    cumulative6Mo = cumulativeSitesOverMonths(margin, 6, costPerSite, maxSitesPerMonth);
  }

  const marginCompact = formatUsdCompact(margin);
  const assumptions = `$${costPerSite / 1000}k/site · max ${maxSitesPerMonth}/mo · capex from monthly NOI/net`;
  const displayValue =
    sitesThisMonth != null
      ? `${sitesThisMonth}/${maxSitesPerMonth} this mo`
      : `—/${maxSitesPerMonth} this mo`;
  const marginLabel = marginCompact
    ? `Margin ${marginCompact}${isDraft ? ' DRAFT' : ''} · $200k/site · max 2/mo`
    : 'Margin TBD · $200k/site · max 2/mo';
  let sixMoLabel =
    cumulative6Mo != null
      ? `6-mo @ same margin: ${cumulative6Mo} site${cumulative6Mo === 1 ? '' : 's'}`
      : '6-mo @ same margin: TBD';
  if (monthsToFirstSite != null) {
    sixMoLabel += ` · 1st site ~${monthsToFirstSite} mo`;
  }

  return {
    monthlyCapexMargin: margin ?? null,
    costPerSite,
    maxSitesPerMonth,
    sitesThisMonth,
    monthsToFirstSite,
    cumulative6Mo,
    assumptions,
    isDraft,
    displayValue,
    marginLabel,
    sixMoLabel,
    source: rev.isDraft
      ? 'Monthly capex margin = draft NOI from partner.monthlyRevenue.net'
      : 'Monthly capex margin = partner.monthlyRevenue.net (clinic revenue − expenses)'
  };
}

function partnerSummary(state) {
  return {
    monthlyRevenue: monthlyRevenueKpi(state),
    activePatients: activePatientsKpi(state),
    activeReferrals: activeReferralsKpi(state),
    monterey: montereyStaffing(state),
    siteProjection: siteProjectionKpi(state)
  };
}

module.exports = {
  ACTIVE_REFERRAL_STATUSES,
  SITE_COST_USD,
  MAX_SITES_PER_MONTH,
  sumClinicField,
  formatUsd,
  formatUsdCompact,
  monthsUntilFirstSite,
  cumulativeSitesOverMonths,
  monthlyRevenueKpi,
  activePatientsKpi,
  activeReferralsKpi,
  montereyStaffing,
  siteProjectionKpi,
  partnerSummary,
  hasLiveReferralRows,
  oaActivePatientsFacts
};
