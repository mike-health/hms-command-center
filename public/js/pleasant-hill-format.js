'use strict';

const stripApi = (typeof require === 'function')
  ? require('./strip-financials')
  : (typeof globalThis !== 'undefined' ? globalThis.PleasantHillStrip : null);

const stripFinancials = stripApi && stripApi.stripFinancials
  ? stripApi.stripFinancials
  : function stripFinancialsFallback(text) {
    return text == null ? '' : String(text);
  };

function stripFinancialsClient(text) {
  return stripFinancials(text == null ? '' : text);
}

function displayTitle(title) {
  return stripFinancialsClient(
    String(title || '')
      .replace(/^Pleasant Hill:\s*/i, '')
      .replace(/\s*\(\s*Owner:\s*[^)]+\)\s*$/i, '')
      .replace(/\(\s*Capital Call\s+\d+\s*\)/gi, '')
      .replace(/\bCapital Call\s+\d+\b/gi, '')
  );
}

function formatShortDate(ymd) {
  if (!ymd) return '—';
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  });
}

function daysBetween(a, b) {
  const pa = Date.parse(a + 'T00:00:00Z');
  const pb = Date.parse(b + 'T00:00:00Z');
  if (Number.isNaN(pa) || Number.isNaN(pb)) return 0;
  return Math.round((pb - pa) / 86400000);
}

function monthTicks(start, end) {
  const ticks = [];
  const [sy, sm] = start.split('-').map(Number);
  let y = sy;
  let m = sm;
  const endT = Date.parse(end + 'T00:00:00Z');
  while (Date.UTC(y, m - 1, 1) <= endT) {
    const ymd = `${y}-${String(m).padStart(2, '0')}-01`;
    ticks.push({
      ymd,
      label: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return ticks;
}

function pctOnRange(ymd, start, end) {
  const total = Math.max(1, daysBetween(start, end));
  const n = daysBetween(start, ymd);
  return Math.max(0, Math.min(100, (n / total) * 100));
}

function assertNoDollar(value, path) {
  if (typeof value === 'string') {
    if (/[$€£]/.test(value) || /\bUSD\b|\bEUR\b|\bGBP\b/i.test(value)) {
      throw new Error('Money figure found at ' + (path || 'root') + ': ' + value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoDollar(item, (path || '') + '[' + i + ']'));
    return;
  }
  if (value && typeof value === 'object') {
    Object.keys(value).forEach((k) => assertNoDollar(value[k], (path ? path + '.' : '') + k));
  }
}

function viewText(text) {
  return stripFinancialsClient(text == null ? '' : String(text));
}

function issueRowHtml(issue, esc) {
  const late = issue.late ? ' ph-late' : '';
  const owners = (issue.owners || []).map((o) => `<span class="ph-owner">${esc(viewText(o))}</span>`).join('');
  const dates = `${formatShortDate(issue.startDate)} – ${formatShortDate(issue.dueDate)}`;
  const href = issue.url ? `href="${esc(viewText(issue.url))}" target="_blank" rel="noopener"` : 'href="#"';
  return `<article class="ph-item${late}" data-id="${esc(viewText(issue.id))}">
    <div class="ph-item-top">
      <a class="ph-item-id" ${href}>${esc(viewText(issue.identifier || ''))}</a>
      ${issue.late ? '<span class="badge badge-red">Late</span>' : ''}
      ${issue.gate ? `<span class="ph-gate-pill">${esc(viewText(issue.gate))}</span>` : ''}
    </div>
    <div class="ph-item-title">${esc(displayTitle(issue.title))}</div>
    <div class="ph-item-meta">
      <span class="ph-dates">${esc(dates)}</span>
      <span class="ph-owners">${owners || '<span class="ph-owner">Unassigned</span>'}</span>
    </div>
  </article>`;
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    assertNoDollar,
    daysBetween,
    displayTitle,
    formatShortDate,
    issueRowHtml,
    monthTicks,
    pctOnRange,
    stripFinancialsClient,
    viewText
  };
}
