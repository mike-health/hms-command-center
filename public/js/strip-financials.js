'use strict';

const MONEY_NUMBER = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
const KMB = '[kKmMbB]';
const ISO_CODE = '(?:USD|EUR|GBP)';
const SYM = '[$€£¥]';

function stripFinancials(text) {
  if (text == null) return text;
  let out = String(text);

  out = out.replace(/40\s*\/\s*30\s*\/\s*20\s*\/\s*10/g, '');
  out = out.replace(/20\s*\/\s*30\s*\/\s*30\s*\/\s*20/g, '');

  out = out.replace(new RegExp('\\bUS\\s*' + SYM + '\\s*' + MONEY_NUMBER + '\\s*' + KMB + '\\b', 'gi'), '');
  out = out.replace(new RegExp('\\bUS\\s*' + SYM + '\\s*' + MONEY_NUMBER, 'gi'), '');
  out = out.replace(new RegExp(SYM + '\\s*' + MONEY_NUMBER + '\\s*' + KMB + '\\b', 'g'), '');
  out = out.replace(new RegExp(SYM + '\\s*' + MONEY_NUMBER, 'g'), '');

  out = out.replace(new RegExp('\\b' + MONEY_NUMBER + '\\s*' + KMB + '\\s*' + ISO_CODE + '\\b', 'gi'), '');
  out = out.replace(new RegExp('\\b' + MONEY_NUMBER + '\\s*' + ISO_CODE + '\\b', 'gi'), '');
  out = out.replace(new RegExp('\\b' + ISO_CODE + '\\s*' + MONEY_NUMBER + '\\s*' + KMB + '\\b', 'gi'), '');
  out = out.replace(new RegExp('\\b' + ISO_CODE + '\\s*' + MONEY_NUMBER + '\\b', 'gi'), '');

  out = out.replace(/\bcapital\s+call(?:s)?\s+\d+\s*\(\s*\d{1,3}\s*%\s*\)/gi, (m) =>
    m.replace(/\s*\(\s*\d{1,3}\s*%\s*\)/i, '')
  );
  out = out.replace(/\(\s*\d{1,3}\s*%\s*\)/g, '');
  out = out.replace(/\bCC\s*[1-4]\s+\d{1,3}\s*%/gi, (m) => m.replace(/\s+\d{1,3}\s*%/i, ''));
  out = out.replace(/\(\s*Capital Call\s+\d+\s*\)/gi, '');
  out = out.replace(/\bCapital Call\s+\d+\b/gi, '');
  out = out.replace(/\b\d{1,3}\s*%\b/g, '');

  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/ +\n/g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

function deepStrip(value) {
  if (typeof value === 'string') return stripFinancials(value);
  if (Array.isArray(value)) return value.map(deepStrip);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((k) => {
      out[k] = deepStrip(value[k]);
    });
    return out;
  }
  return value;
}

function sanitizeForView(value) {
  return deepStrip(value);
}

const api = { stripFinancials, deepStrip, sanitizeForView };

if (typeof module === 'object' && module.exports) {
  module.exports = api;
} else if (typeof globalThis !== 'undefined') {
  globalThis.PleasantHillStrip = api;
  globalThis.stripFinancials = stripFinancials;
  globalThis.deepStrip = deepStrip;
  globalThis.sanitizeForView = sanitizeForView;
}
