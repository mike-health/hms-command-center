'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const OrgTree = require('../public/js/org-tree.js');

const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../data/command-center.json'), 'utf8')
);

describe('HEA-97 Phase 1 org tree data', () => {
  it('keeps HMS apex, Greene/Mike peers, Mily under Mike, Rudy multi-home', () => {
    const problems = OrgTree.assertHardRules(data.nodes, data.orgEdges);
    assert.deepEqual(problems, []);
  });

  it('resolves the same visual parents from parentId+members when orgEdges omitted', () => {
    const derived = OrgTree.deriveEdgesFromNodes(data.nodes);
    const stored = data.orgEdges.map(e => e.from + '>' + e.to).sort();
    const got = derived.map(e => e.from + '>' + e.to).sort();
    assert.deepEqual(got, stored);
  });

  it('renders founder-stage DNA and does not put clinics under Rudy', () => {
    const html = OrgTree.renderTree(data.nodes, data.orgEdges);
    assert.match(html, /node-apex/);
    assert.match(html, /founder-col--greene/);
    assert.match(html, /founder-col--greenhalgh/);
    assert.match(html, /mike-subtree/);
    assert.match(html, /Partner lane — do not contact/);
    assert.match(html, /Medical Director · Site Selection · Strategy/);
    assert.match(html, /Personnel &amp; Clinic Design \/ Chula Manager/);
    assert.match(html, /node-group-header[^>]*marketingOutreach/);
    assert.match(html, /data-home="marketing"/);
    assert.match(html, /data-home="ops"/);
    assert.equal((html.match(/data-id="rudy"/g) || []).length, 2);
    assert.equal((html.match(/data-id="melinna"/g) || []).length, 1);
    assert.doesNotMatch(html, /c-chula|Monica Hernandez|Deborah Dunton/);
    assert.equal(OrgTree.childrenOf(data.orgEdges, 'rudy').length, 0);
    assert.equal(OrgTree.subtreeColumns(data.nodes, data.orgEdges, 'greenhalgh').length, 5);
  });

  it('keeps Greene title/role as Partner DNC and not in Mike reporting chain', () => {
    assert.equal(data.nodes.greene.parentId, 'hms');
    assert.match(data.nodes.greene.role, /Do Not Contact/i);
    assert.equal(data.nodes.greene.title, 'Medical Director · Site Selection · Strategy');
    assert.equal(OrgTree.childrenOf(data.orgEdges, 'greene').length, 0);
  });
});
