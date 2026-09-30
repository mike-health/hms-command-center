'use strict';

const stripApi = (typeof require === 'function')
  ? require('./strip-financials')
  : (typeof globalThis !== 'undefined' ? globalThis.PleasantHillStrip : null);

const stripMoney = stripApi && stripApi.stripFinancials
  ? stripApi.stripFinancials
  : function stripFinancialsFallback(text) {
    return text == null ? '' : String(text);
  };

function stripFinancialsClient(text) {
  return stripMoney(text == null ? '' : text);
}

function displayTitle(title) {
  return stripFinancialsClient(
    String(title || '')
      .replace(/^Pleasant Hill:\s*/i, '')
      .replace(/\s*\(\s*Owner:\s*[^)]+\)\s*$/i, '')
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
    const cleaned = stripFinancialsClient(value);
    if (stripApi && stripApi.looksFinancial && stripApi.looksFinancial(cleaned)) return '';
    if (/[$€£¥]/.test(cleaned) || /\bUSD\b|\bEUR\b|\bGBP\b/i.test(cleaned)) return '';
    return cleaned;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => assertNoDollar(item, (path || '') + '[' + i + ']'));
  }
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((k) => {
      out[k] = assertNoDollar(value[k], (path ? path + '.' : '') + k);
    });
    return out;
  }
  return value;
}

function viewText(text) {
  const cleaned = stripFinancialsClient(text == null ? '' : String(text));
  if (stripApi && stripApi.looksFinancial && stripApi.looksFinancial(cleaned)) return '';
  if (/[$€£¥]/.test(cleaned) || /\bUSD\b|\bEUR\b|\bGBP\b/i.test(cleaned) || /\bpercent\b/i.test(cleaned)) {
    return '';
  }
  return cleaned;
}

function issueRowHtml(issue, htmlEsc) {
  const v = (s) => htmlEsc(viewText(s == null ? '' : String(s)));
  const late = issue.late ? ' ph-late' : '';
  const owners = (issue.owners || []).map((o) => `<span class="ph-owner">${v(o)}</span>`).join('');
  const dates = `${formatShortDate(issue.startDate)} – ${formatShortDate(issue.dueDate)}`;
  const href = issue.url ? `href="${v(issue.url)}" target="_blank" rel="noopener"` : 'href="#"';
  return `<article class="ph-item${late}" data-id="${v(issue.id)}">
    <div class="ph-item-top">
      <a class="ph-item-id" ${href}>${v(issue.identifier || '')}</a>
      ${issue.late ? '<span class="badge badge-red">Late</span>' : ''}
      ${issue.gate ? `<span class="ph-gate-pill">${v(issue.gate)}</span>` : ''}
    </div>
    <div class="ph-item-title">${v(displayTitle(issue.title))}</div>
    <div class="ph-item-meta">
      <span class="ph-dates">${v(dates)}</span>
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
