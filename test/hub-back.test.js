'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { HUB_URL, HUB_BAR_LABEL, hubBarAttrs } = require('../lib/hub-back');

describe('hub bar', () => {
  it('is always a plain link to the partner hub, never history.back', () => {
    const attrs = hubBarAttrs();
    assert.equal(attrs.href, 'https://hms-partner-news.netlify.app/');
    assert.equal(attrs.href, HUB_URL);
    assert.equal(attrs.text, HUB_BAR_LABEL);
    assert.equal(attrs.className, 'hms-hub-return');
  });

  it('is present on every Command Center HTML page', () => {
    const roots = [
      path.join(__dirname, '../public/index.html'),
      ...fs.readdirSync(path.join(__dirname, '../public/modules'))
        .filter((f) => f.endsWith('.html'))
        .map((f) => path.join(__dirname, '../public/modules', f))
    ];
    assert.ok(roots.length >= 9);
    roots.forEach((file) => {
      const html = fs.readFileSync(file, 'utf8');
      assert.match(html, /class="hms-hub-return"/, file);
      assert.match(html, /href="https:\/\/hms-partner-news\.netlify\.app\/"/, file);
      assert.match(html, /← Back to HMS hub/, file);
      assert.doesNotMatch(html, /goHubBack\(/, file);
      assert.doesNotMatch(html, /btn-hub-back/, file);
      assert.doesNotMatch(html, /history\.back/, file);
    });
  });

  it('uses a sticky high-contrast full-width bar at least 48px tall', () => {
    const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
    const block = css.match(/\.hms-hub-return\s*\{[^}]+\}/);
    assert.ok(block, 'hms-hub-return styles missing');
    assert.match(block[0], /min-height:\s*48px/);
    assert.match(block[0], /background:\s*#1F4E79/);
    assert.match(block[0], /color:\s*#fff/);
    assert.match(block[0], /font-weight:\s*700/);
    assert.match(block[0], /position:\s*sticky/);
    assert.match(block[0], /width:\s*100%/);
    assert.match(css, /\.hms-hub-return\s*\{/);
    const js = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
    assert.doesNotMatch(js, /history\.back/);
    assert.doesNotMatch(js, /goHubBack/);
  });
});
