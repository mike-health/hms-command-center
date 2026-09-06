/**
 * HMS org tree — Phase 1 data-driven layout (no drag / no chatbox patch).
 * Works in the browser (global OrgTree) and in Node tests (module.exports).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OrgTree = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function nodeList(nodes) {
    return Object.keys(nodes || {}).map(function (id) { return nodes[id]; }).filter(Boolean);
  }

  function deriveEdgesFromNodes(nodes) {
    var edges = [];
    var seen = {};
    function add(from, to, extra) {
      if (!from || !to) return;
      var key = from + '>' + to + '>' + (extra && extra.home || '');
      if (seen[key]) return;
      seen[key] = true;
      var e = { from: from, to: to };
      if (extra) {
        Object.keys(extra).forEach(function (k) {
          if (extra[k] != null && extra[k] !== '') e[k] = extra[k];
        });
      }
      edges.push(e);
    }
    nodeList(nodes).forEach(function (n) {
      if (!n || n.inTree === false) return;
      if (n.parentId) {
        add(n.parentId, n.id, {
          order: n.order,
          vlineClass: n.vlineClass,
          home: n.home
        });
      }
      (n.edges || []).forEach(function (ed) {
        add(ed.from || ed.parentId, ed.to || n.id, {
          order: ed.order,
          vlineClass: ed.vlineClass,
          home: ed.home
        });
      });
    });
    nodeList(nodes).forEach(function (n) {
      if (!n || !n.members) return;
      n.members.forEach(function (mid, i) {
        add(n.id, mid, { home: 'marketing', order: i + 1 });
      });
    });
    return edges;
  }

  function resolveEdges(nodes, orgEdges) {
    if (orgEdges && orgEdges.length) return orgEdges.slice();
    return deriveEdgesFromNodes(nodes);
  }

  function childrenOf(edges, parentId) {
    return (edges || [])
      .filter(function (e) { return e.from === parentId; })
      .slice()
      .sort(function (a, b) {
        var ao = a.order != null ? a.order : 99;
        var bo = b.order != null ? b.order : 99;
        if (ao !== bo) return ao - bo;
        return String(a.to).localeCompare(String(b.to));
      });
  }

  function apexId(nodes, edges) {
    var listed = nodeList(nodes).find(function (n) {
      return n.treeRole === 'apex' || n.id === 'hms';
    });
    if (listed) return listed.id;
    var targets = {};
    (edges || []).forEach(function (e) { targets[e.to] = true; });
    var roots = nodeList(nodes).filter(function (n) {
      return n.inTree !== false && !n.parentId && !targets[n.id];
    });
    return roots[0] ? roots[0].id : null;
  }

  function founderPeers(nodes, edges, rootId) {
    return childrenOf(edges, rootId).filter(function (e) {
      var n = nodes[e.to];
      if (!n || n.inTree === false) return false;
      return n.treeRole === 'founder' || n.nodeClass === 'node-founder';
    });
  }

  function subtreeColumns(nodes, edges, founderId) {
    return childrenOf(edges, founderId).filter(function (e) {
      var n = nodes[e.to];
      return n && n.inTree !== false;
    });
  }

  function assertHardRules(nodes, edges) {
    var e = resolveEdges(nodes, edges);
    var problems = [];
    if (!nodes.hms || nodes.hms.treeRole !== 'apex') problems.push('HMS must be tree apex');
    var founders = founderPeers(nodes, e, 'hms').map(function (x) { return x.to; });
    if (founders.indexOf('greene') === -1 || founders.indexOf('greenhalgh') === -1) {
      problems.push('Greene and Mike must be founder peers under HMS');
    }
    if (childrenOf(e, 'greene').length) problems.push('Greene lane must have no org-tree children');
    var greene = nodes.greene || {};
    if (!/do not contact/i.test(greene.role || '') && !/do-not-contact/i.test(greene.role || '')) {
      problems.push('Greene role must be do-not-contact');
    }
    if (!nodes.mily || nodes.mily.parentId !== 'greenhalgh') {
      problems.push('Mily must report to Mike (greenhalgh), not Rudy');
    }
    if (nodes.mily && nodes.mily.parentId === 'rudy') problems.push('Mily must not be under Rudy');
    var mkt = nodes.marketingOutreach || {};
    var members = mkt.members || [];
    ['rudy', 'stacey', 'nikhil'].forEach(function (id) {
      if (members.indexOf(id) === -1) problems.push('Marketing Outreach must include ' + id);
    });
    var rudyHomes = e.filter(function (x) { return x.to === 'rudy'; }).map(function (x) { return x.from; });
    if (rudyHomes.indexOf('greenhalgh') === -1 || rudyHomes.indexOf('marketingOutreach') === -1) {
      problems.push('Rudy must be multi-home (ops under Mike + Marketing Outreach)');
    }
    if (childrenOf(e, 'rudy').length) problems.push('Clinics must not hang as tree children under Rudy');
    return problems;
  }

  function personBox(node, attrs) {
    if (!node) return '';
    var extra = attrs || {};
    var cls = node.nodeClass || 'node-team';
    var nav = extra.navigateId || node.navigateId || node.id;
    var home = extra.home ? ' data-home="' + esc(extra.home) + '"' : '';
    return (
      '<div class="node ' + esc(cls) + '" data-id="' + esc(node.id) + '"' + home +
      ' onclick="navigatePm(\'' + esc(nav) + '\')">' +
      '<div class="n-name">' + esc(node.name) + '</div>' +
      '<div class="n-title">' + esc(node.title) + '</div>' +
      '</div>'
    );
  }

  function renderTree(nodes, orgEdges) {
    var edges = resolveEdges(nodes, orgEdges);
    var root = apexId(nodes, edges);
    var apex = nodes[root];
    if (!apex) return '';

    var founders = founderPeers(nodes, edges, root);
    var greeneEdge = founders.find(function (e) { return e.to === 'greene'; }) || founders[0];
    var mikeEdge = founders.find(function (e) { return e.to === 'greenhalgh'; }) || founders[1];

    var greene = greeneEdge ? nodes[greeneEdge.to] : null;
    var mike = mikeEdge ? nodes[mikeEdge.to] : null;
    var cols = mike ? subtreeColumns(nodes, edges, mike.id) : [];

    var hubDrops = cols.map(function (e) {
      var v = e.vlineClass || nodes[e.to] && nodes[e.to].vlineClass || 'vline-gray';
      return '<div class="vline ' + esc(v) + '" style="height:28px;"></div>';
    }).join('');

    var mgrs = cols.map(function (e) {
      var n = nodes[e.to];
      if (!n) return '';
      if (n.treeRole === 'group' || (n.members && n.members.length)) {
        var membersHtml = (n.members || childrenOf(edges, n.id).map(function (x) { return x.to; })).map(function (mid) {
          var memberEdge = childrenOf(edges, n.id).find(function (x) { return x.to === mid; }) || {};
          return personBox(nodes[mid], { home: memberEdge.home || 'marketing' });
        }).join('');
        var note = n.opsNote ? '<div class="ops-note">' + esc(n.opsNote) + '</div>' : '';
        return (
          '<div class="mg-col"><div class="node-group">' +
          '<div class="node-group-header" data-id="' + esc(n.id) + '" onclick="navigatePm(\'' + esc(n.navigateId || n.id) + '\')">' +
          esc(n.name) + '</div>' +
          '<div class="node-group-members">' + membersHtml + '</div>' +
          note +
          '</div></div>'
        );
      }
      var note = n.opsNote ? '<div class="ops-note">' + esc(n.opsNote) + '</div>' : '';
      return '<div class="mg-col">' + personBox(n, { home: e.home }) + note + '</div>';
    }).join('');

    var greeneCol = greene ? (
      '<div class="founder-col founder-col--' + esc(greene.lane || greene.id) + '">' +
      personBox(greene) +
      (greene.opsNote ? '<div class="ops-note">' + esc(greene.opsNote) + '</div>' : '') +
      '</div>'
    ) : '';

    var mikeCol = mike ? (
      '<div class="founder-col founder-col--' + esc(mike.lane || mike.id) + '">' +
      personBox(mike) +
      '</div>'
    ) : '';

    var subtree = mike && cols.length ? (
      '<div class="mike-subtree">' +
      '<div class="vline"></div>' +
      '<div class="hub-bar"></div>' +
      '<div class="hub-drops">' + hubDrops + '</div>' +
      '<div class="mgrs">' + mgrs + '</div>' +
      '</div>'
    ) : '';

    return (
      '<div class="tree tree-apex">' +
      personBox(apex, { navigateId: apex.navigateId || 'org' }) +
      '<div class="vline"></div>' +
      '<div class="founders-stage">' +
      '<div class="founders-connector">' +
      '<div class="founders-bar"></div>' +
      '<div class="founders-drops"><div class="vline"></div><div class="vline"></div></div>' +
      '</div>' +
      greeneCol +
      mikeCol +
      subtree +
      '</div></div>'
    );
  }

  return {
    esc: esc,
    resolveEdges: resolveEdges,
    deriveEdgesFromNodes: deriveEdgesFromNodes,
    childrenOf: childrenOf,
    apexId: apexId,
    founderPeers: founderPeers,
    subtreeColumns: subtreeColumns,
    assertHardRules: assertHardRules,
    renderTree: renderTree
  };
});
