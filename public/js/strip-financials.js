'use strict';

const NUM = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
const SCALE_WORD = '(?:thousand|million|billion)s?';
const SCALE_LETTER = '[kKmMbB](?![a-zA-Z])';
const SCALE = '(?:' + SCALE_WORD + '|' + SCALE_LETTER + ')';
const ISO = '(?:USD|EUR|GBP)';
const SYM = '[$€£¥]';
const DOLLARS_WORD = '(?:dollars?|bucks)';

function collapseSpace(text) {
  return String(text)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .trim();
}

function stripFinancials(text) {
  if (text == null) return text;
  let out = String(text);

  out = out.replace(/40\s*\/\s*30\s*\/\s*20\s*\/\s*10/g, '');
  out = out.replace(/20\s*\/\s*30\s*\/\s*30\s*\/\s*20/g, '');

  out = out.replace(/\bcapital\s+calls?\b(?:\s+\d+)?(?:\s*\([^)]{0,80}\))?/gi, '');
  out = out.replace(/\bCC\s*[1-4]\b/gi, '');

  out = out.replace(new RegExp('\\bUS\\s*' + SYM + '\\s*' + NUM + '(?:\\s*' + SCALE + ')?', 'gi'), '');
  out = out.replace(new RegExp(SYM + '\\s*' + NUM + '\\s*' + SCALE, 'gi'), '');
  out = out.replace(new RegExp(SYM + '\\s*' + NUM, 'g'), '');

  out = out.replace(new RegExp('\\b' + NUM + '\\s*' + SCALE + '\\s*' + ISO + '\\b', 'gi'), '');
  out = out.replace(new RegExp('\\b' + NUM + '\\s*' + ISO + '\\b', 'gi'), '');
  out = out.replace(new RegExp('\\b' + ISO + '\\s*' + NUM + '(?:\\s*' + SCALE + ')?\\b', 'gi'), '');
  out = out.replace(new RegExp('\\b' + NUM + '\\s*' + DOLLARS_WORD + '\\b', 'gi'), '');
  out = out.replace(new RegExp('\\b' + DOLLARS_WORD + '\\s*' + NUM + '\\b', 'gi'), '');

  out = out.replace(/\$[A-Za-z][\w-]*/g, '');
  out = out.replace(/\$/g, '');
  out = out.replace(/[€£¥]/g, '');

  out = out.replace(/\d+(?:\.\d+)?\s*%/g, '');
  out = out.replace(/\d+(?:\.\d+)?\s*percent\b/gi, '');
  out = out.replace(/\bpercent\b/gi, '');

  return collapseSpace(out);
}

function looksFinancial(text) {
  const s = String(text || '');
  if (!s) return false;
  return /[$€£¥]/.test(s)
    || /\d+(?:\.\d+)?\s*%/.test(s)
    || /\bpercent\b/i.test(s)
    || /\b(?:USD|EUR|GBP)\b/i.test(s)
    || /\bdollars?\b/i.test(s)
    || /\bcapital\s+calls?\b/i.test(s);
}

function scrubString(text) {
  if (text == null) return text;
  const cleaned = stripFinancials(text);
  if (typeof cleaned === 'string' && looksFinancial(cleaned)) return '';
  return cleaned;
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

function deepScrub(value) {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(deepScrub);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((k) => {
      out[k] = deepScrub(value[k]);
    });
    return out;
  }
  return value;
}

function sanitizeForView(value) {
  return deepScrub(value);
}

const api = {
  stripFinancials,
  looksFinancial,
  scrubString,
  deepStrip,
  deepScrub,
  sanitizeForView
};

if (typeof module === 'object' && module.exports) {
  module.exports = api;
} else if (typeof globalThis !== 'undefined') {
  globalThis.PleasantHillStrip = api;
}
