'use strict';

function formatDue(iso) {
  if (iso == null || iso === '') {
    return { label: '—', overdue: false };
  }
  const str = String(iso);
  const d = new Date(str + (str.length === 10 ? 'T12:00:00' : ''));
  if (Number.isNaN(d.getTime())) {
    return { label: '—', overdue: false };
  }
  const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return { label, overdue: d < today };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatDue };
}
