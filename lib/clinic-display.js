'use strict';

const NOT_YET = 'not yet available';

function isBlank(value) {
  return value == null || value === '' || (typeof value === 'number' && Number.isNaN(value));
}

function displayValue(value) {
  if (isBlank(value)) return NOT_YET;
  return String(value);
}

function formatUsd(amount) {
  if (isBlank(amount)) return NOT_YET;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(amount));
}

function statusBadgeTone(status) {
  if (isBlank(status)) return 'gray';
  const s = String(status).toLowerCase();
  if (s === 'open' || s.startsWith('open ') || s === 'operational') return 'green';
  if (s.includes('opening') || s === 'startup') return 'blue';
  if (s === 'build' || s === 'partly') return 'amber';
  return 'gray';
}

function hasMapPoint(clinic) {
  return clinic && clinic.lat != null && clinic.lng != null
    && !Number.isNaN(Number(clinic.lat)) && !Number.isNaN(Number(clinic.lng));
}

function snapshotAsOf(state) {
  return (state && state.clinicSnapshot && (state.clinicSnapshot.asOf || state.clinicSnapshot.generated))
    || (state && state.dataNotes && state.dataNotes.clinicAsOf)
    || null;
}

module.exports = {
  NOT_YET,
  isBlank,
  displayValue,
  formatUsd,
  statusBadgeTone,
  hasMapPoint,
  snapshotAsOf
};
