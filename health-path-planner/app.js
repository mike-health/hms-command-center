(function () {
  "use strict";

  var FACTOR_ORDER = [
    "Genomics",
    "Lab markers",
    "Symptoms",
    "Medications",
    "Lifestyle"
  ];

  var EMPTY_FACTORS = {
    Genomics: ["Not a primary driver at this step (illustrative)."],
    "Lab markers": ["No additional labs at this step (illustrative)."],
    Symptoms: ["No new symptom target at this step (illustrative)."],
    Medications: ["No medication change at this step (illustrative)."],
    Lifestyle: ["No new lifestyle target at this step (illustrative)."]
  };

  var SEED_START = "type 2 diabetes";
  var SEED_GOAL = "normal glucose regulation";

  var SEED_PATH = [
    {
      id: "start",
      kind: "Start",
      title: "Type 2 diabetes",
      factors: {
        Genomics: ["TCF7L2 risk variant (illustrative)"],
        "Lab markers": ["A1C elevated (illustrative)", "Fasting glucose elevated"],
        Symptoms: ["Polyuria", "Fatigue"],
        Medications: ["No glucose-lowering therapy started yet (illustrative)"],
        Lifestyle: ["Sedentary pattern", "High glycemic-load diet (illustrative)"]
      }
    },
    {
      id: "a1c",
      kind: "Milestone",
      title: "A1C baseline",
      factors: {
        Genomics: ["TCF7L2 risk variant (illustrative)"],
        "Lab markers": ["A1C", "Fasting glucose", "Lipid panel"],
        Symptoms: ["Interval symptom inventory"],
        Medications: ["Current medication list review"],
        Lifestyle: ["Diet and activity snapshot"]
      }
    },
    {
      id: "nutrition",
      kind: "Intervention",
      title: "Nutrition plan",
      factors: {
        Genomics: ["Not used for meal design in this demo"],
        "Lab markers": ["Postprandial glucose pattern (illustrative)"],
        Symptoms: ["Satiety", "Daytime energy"],
        Medications: ["Coordinate meal timing with future metformin"],
        Lifestyle: ["Carbohydrate distribution", "Fiber target", "Meal timing"]
      }
    },
    {
      id: "exercise",
      kind: "Intervention",
      title: "Exercise prescription",
      factors: {
        Genomics: ["PPARG exercise-response variant (illustrative)"],
        "Lab markers": ["Insulin-sensitivity proxies (illustrative)"],
        Symptoms: ["Stamina", "Sleep quality"],
        Medications: ["Hypoglycemia precautions if therapy starts"],
        Lifestyle: ["150 min moderate aerobic activity", "Resistance training 2x/week (illustrative)"]
      }
    },
    {
      id: "metformin",
      kind: "Intervention",
      title: "Metformin titration",
      factors: {
        Genomics: ["SLC22A1 transporter variant (illustrative)"],
        "Lab markers": ["A1C", "eGFR", "Vitamin B12"],
        Symptoms: ["GI-tolerability watch"],
        Medications: ["Metformin extended-release titration (illustrative)"],
        Lifestyle: ["Take with meals"]
      }
    },
    {
      id: "cgm",
      kind: "Milestone",
      title: "Continuous glucose monitoring",
      factors: {
        Genomics: ["Not a primary driver at this step (illustrative)"],
        "Lab markers": ["Time-in-range", "Glycemic variability"],
        Symptoms: ["Hypoglycemia awareness"],
        Medications: ["Correlate readings with metformin timing"],
        Lifestyle: ["Meal and activity tagging"]
      }
    },
    {
      id: "retest",
      kind: "Milestone",
      title: "Six-month retest",
      factors: {
        Genomics: ["Residual polygenic risk counseling (illustrative)"],
        "Lab markers": ["A1C", "Fasting glucose", "Lipid panel", "Urine ACR (illustrative)"],
        Symptoms: ["Interval history"],
        Medications: ["Adherence and dose review"],
        Lifestyle: ["Maintenance nutrition and activity plan"]
      }
    },
    {
      id: "goal",
      kind: "Goal",
      title: "Normal glucose regulation",
      factors: {
        Genomics: ["Residual risk counseling (illustrative)"],
        "Lab markers": ["A1C in target (illustrative)", "Fasting glucose in range (illustrative)"],
        Symptoms: ["Polyuria and fatigue resolved (illustrative)"],
        Medications: ["Lowest effective dose if still indicated (illustrative)"],
        Lifestyle: ["Sustainable nutrition and activity"]
      }
    }
  ];

  var els = {
    symbolic: document.getElementById("symbolic-mode"),
    real: document.getElementById("real-mode"),
    startText: document.getElementById("start-text"),
    goalText: document.getElementById("goal-text"),
    generate: document.getElementById("generate-path"),
    diagram: document.getElementById("path-diagram"),
    status: document.getElementById("path-status"),
    caption: document.getElementById("path-caption"),
    card: document.getElementById("detail-card"),
    detailTitle: document.getElementById("detail-title"),
    detailKind: document.getElementById("detail-kind"),
    detailFactors: document.getElementById("detail-factors")
  };

  var state = {
    nodes: [],
    selectedId: null
  };

  function normalize(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function isSeededExample(start, goal) {
    return normalize(start) === SEED_START && normalize(goal) === SEED_GOAL;
  }

  function genericFactors(label) {
    return {
      Genomics: ["Symbolic placeholder only — no genomic lookup"],
      "Lab markers": ["Relevant labs for " + label + " (illustrative)"],
      Symptoms: ["Tracked symptoms for " + label + " (illustrative)"],
      Medications: ["Therapy review at this step (illustrative)"],
      Lifestyle: ["Supporting routines for " + label + " (illustrative)"]
    };
  }

  function buildGenericPath(start, goal) {
    var startTitle = start.trim() || "Unspecified start";
    var goalTitle = goal.trim() || "Unspecified goal";
    return [
      {
        id: "start",
        kind: "Start",
        title: startTitle,
        factors: genericFactors(startTitle)
      },
      {
        id: "workup",
        kind: "Milestone",
        title: "Diagnostic workup",
        factors: {
          Genomics: ["Panel deferred until real mode (illustrative)"],
          "Lab markers": ["Baseline labs matched to the presenting state (illustrative)"],
          Symptoms: ["Structured history and review of systems"],
          Medications: ["Current medication reconciliation"],
          Lifestyle: ["Sleep, movement, and nutrition screen"]
        }
      },
      {
        id: "lifestyle",
        kind: "Intervention",
        title: "Lifestyle change",
        factors: {
          Genomics: EMPTY_FACTORS.Genomics,
          "Lab markers": ["Early response markers (illustrative)"],
          Symptoms: ["Energy, pain, or function targets"],
          Medications: EMPTY_FACTORS.Medications,
          Lifestyle: ["Nutrition, activity, and sleep prescription (illustrative)"]
        }
      },
      {
        id: "therapy",
        kind: "Intervention",
        title: "Therapy session or medication adjustment",
        factors: {
          Genomics: ["Pharmacogenomic placeholders only (illustrative)"],
          "Lab markers": ["Safety labs before titration (illustrative)"],
          Symptoms: ["Tolerability and target-symptom score"],
          Medications: ["Dose or modality adjustment (illustrative)"],
          Lifestyle: ["Adherence supports"]
        }
      },
      {
        id: "retest",
        kind: "Milestone",
        title: "Retest",
        factors: {
          Genomics: EMPTY_FACTORS.Genomics,
          "Lab markers": ["Repeat the workup markers that can change"],
          Symptoms: ["Compare to baseline"],
          Medications: ["Continue, taper, or switch (illustrative)"],
          Lifestyle: ["Reinforce what is working"]
        }
      },
      {
        id: "goal",
        kind: "Goal",
        title: goalTitle,
        factors: genericFactors(goalTitle)
      }
    ];
  }

  function arrowSvg() {
    return (
      '<svg viewBox="0 0 42 28" aria-hidden="true" focusable="false">' +
      '<path d="M4 14h28M24 6l12 8-12 8" fill="none" stroke="currentColor" ' +
      'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>"
    );
  }

  function renderPath(nodes, caption) {
    state.nodes = nodes;
    state.selectedId = null;
    els.diagram.replaceChildren();
    els.caption.textContent = caption;
    hideCard();

    nodes.forEach(function (node, index) {
      var item = document.createElement("li");
      item.className = "path-item";

      var button = document.createElement("button");
      button.type = "button";
      button.className = "path-node";
      button.id = "node-" + node.id;
      button.dataset.nodeId = node.id;
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", "detail-card");
      button.innerHTML =
        '<span class="step">' + escapeHtml(node.kind) + "</span>" +
        '<span class="title">' + escapeHtml(node.title) + "</span>";

      button.addEventListener("click", function () {
        selectNode(node.id);
      });
      button.addEventListener("mouseenter", function () {
        selectNode(node.id);
      });
      button.addEventListener("focus", function () {
        selectNode(node.id);
      });
      button.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          selectNode(node.id);
        }
      });

      item.appendChild(button);

      if (index < nodes.length - 1) {
        var connector = document.createElement("span");
        connector.className = "connector";
        connector.setAttribute("aria-hidden", "true");
        connector.innerHTML = arrowSvg();
        item.appendChild(connector);
      }

      els.diagram.appendChild(item);
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function findNode(id) {
    for (var i = 0; i < state.nodes.length; i += 1) {
      if (state.nodes[i].id === id) {
        return state.nodes[i];
      }
    }
    return null;
  }

  function hideCard() {
    els.card.hidden = true;
    els.detailTitle.textContent = "";
    els.detailKind.textContent = "";
    els.detailFactors.replaceChildren();
    Array.prototype.forEach.call(els.diagram.querySelectorAll(".path-node"), function (node) {
      node.classList.remove("is-active");
      node.setAttribute("aria-expanded", "false");
    });
  }

  function showCard(node) {
    els.detailTitle.textContent = node.title;
    els.detailKind.textContent = node.kind + " · health factors touched";
    els.detailFactors.replaceChildren();

    FACTOR_ORDER.forEach(function (group) {
      var items = (node.factors && node.factors[group]) || [];
      var section = document.createElement("section");
      section.className = "factor-group";
      var heading = document.createElement("h4");
      heading.textContent = group;
      var list = document.createElement("ul");
      items.forEach(function (item) {
        var li = document.createElement("li");
        li.textContent = item;
        list.appendChild(li);
      });
      section.appendChild(heading);
      section.appendChild(list);
      els.detailFactors.appendChild(section);
    });

    els.card.hidden = false;
  }

  function selectNode(id) {
    var node = findNode(id);
    if (!node) {
      return;
    }
    state.selectedId = id;
    Array.prototype.forEach.call(els.diagram.querySelectorAll(".path-node"), function (button) {
      var isActive = button.dataset.nodeId === id;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-expanded", isActive ? "true" : "false");
    });
    showCard(node);
  }

  function generate() {
    if (!els.symbolic.checked) {
      state.nodes = [];
      els.diagram.replaceChildren();
      hideCard();
      els.caption.textContent = "";
      els.status.textContent =
        "Turn Symbolic mode on to compute a path. Real mode is not available yet.";
      els.generate.disabled = true;
      return;
    }

    els.generate.disabled = false;
    var start = els.startText.value;
    var goal = els.goalText.value;
    var seeded = isSeededExample(start, goal);
    var nodes = seeded ? SEED_PATH : buildGenericPath(start, goal);
    var caption = seeded
      ? "Seeded symbolic graph · illustrative demo, not medical advice"
      : "Generic symbolic path · illustrative demo, not medical advice";
    renderPath(nodes, caption);
    els.status.textContent = seeded
      ? "Generated the type 2 diabetes to normal glucose regulation demo path."
      : "Inputs did not match the seeded example, so a generic symbolic path was generated.";
  }

  els.symbolic.addEventListener("change", function () {
    if (els.symbolic.checked) {
      generate();
    } else {
      generate();
    }
  });

  els.generate.addEventListener("click", generate);

  generate();
})();
