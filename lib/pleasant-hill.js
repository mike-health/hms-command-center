'use strict';

const { linearGraphql } = require('./ops-cadence');
const { stripFinancials, scrubString, deepStrip, looksFinancial, sanitizeForView } = require('../public/js/strip-financials');
const { failClosed } = require('./ph-view-gate');

const fs = require('fs');
const path = require('path');

const TITLE_PREFIX = 'Pleasant Hill:';
const DEFAULT_PROJECT_NAME = 'Clinic Development - Todd';
const SUPERVISION_PROJECT_NAME = 'Supervision Standard Rollout';
const DEFAULT_PROJECT_NAMES = [DEFAULT_PROJECT_NAME, SUPERVISION_PROJECT_NAME];
const DEFAULT_TEAM_KEY = 'HEA';
const OWNER_SUFFIX_RE = /\s*\(\s*Owner:\s*([^)]+)\)\s*$/i;
const FIXTURE_PATH = path.join(__dirname, '..', 'data', 'pleasant-hill-fixture.json');
const VIEWER_LOAD_ERROR = 'The schedule could not be loaded. Try again later.';
const CACHE_TTL_MS = 3 * 60 * 1000;
const ERROR_CACHE_TTL_MS = 60 * 1000;
const TZ = 'America/Los_Angeles';
const SITE = {
  name: 'Pleasant Hill six-chamber HBOT clinic',
  address: '400 Taylor Blvd, Suite 103, Pleasant Hill, CA'
};

const PHASES = [
  { key: 'phase-0', name: 'Kickoff & site facts', start: '2026-09-29', end: '2026-10-16' },
  { key: 'phase-1', name: 'Proposal & design', start: '2026-10-19', end: '2026-11-13' },
  { key: 'phase-2', name: 'Permit & procurement', start: '2026-11-16', end: '2027-02-19' },
  { key: 'phase-3', name: 'Build & install', start: '2027-02-22', end: '2027-04-16' },
  { key: 'phase-4', name: 'Commission & open', start: '2027-04-19', end: '2027-05-17' },
  { key: 'ops-midpoint', name: 'Ops midpoint track', start: '2027-02-15', end: '2027-05-17' }
];

const GATE_DEFAULTS = [
  { code: 'M1', name: 'Agreement signed', targetDate: '2026-11-06' },
  { code: 'M2', name: 'Equipment delivered', targetDate: '2027-03-19' },
  { code: 'M3', name: 'Rough-in complete', targetDate: '2027-03-26' },
  { code: 'M4', name: 'Startup / first-patient ready', targetDate: '2027-05-07' }
];

const OWNER_ALIASES = [
  { match: /\bleddy\b/i, name: 'Leddy' },
  { match: /\btodd\b/i, name: 'Todd' },
  { match: /\brudy\b/i, name: 'Rudy' },
  { match: /\bstacey\b/i, name: 'Stacey' },
  { match: /\barchitect\b/i, name: 'Architect' },
  { match: /\bowner[- ]side\b|\bdr\.?\s*son\b|\bschropp\b|\blandlord\b/i, name: 'Owner-side' },
  { match: /\bmike\b|\bgreenhalgh\b|\bmichael\b/i, name: 'Mike' },
  { match: /\bahj\b|\bfire\b|\bbuilding division\b/i, name: 'AHJ' },
  { match: /\b\bgc\b|\bcontractor\b/i, name: 'GC' },
  { match: /\bpersonnel\b/i, name: 'Personnel' },
  { match: /\bops director\b|\boperations director\b/i, name: 'Rudy' },
  { match: /\bmanaging director\b/i, name: 'Mike' }
];

let cache = { key: null, at: 0, data: null };

function projectConfig() {
  const extra = process.env.LINEAR_PLEASANT_HILL_PROJECTS;
  const names = extra
    ? extra.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_PROJECT_NAMES.slice();
  const primary = process.env.LINEAR_PLEASANT_HILL_PROJECT || names[0] || DEFAULT_PROJECT_NAME;
  if (!names.includes(primary)) names.unshift(primary);
  return {
    name: primary,
    names: [...new Set(names)],
    teamKey: process.env.LINEAR_TEAM_KEY || DEFAULT_TEAM_KEY,
    titlePrefix: process.env.LINEAR_PLEASANT_HILL_TITLE_PREFIX || TITLE_PREFIX,
    supervisionProject: SUPERVISION_PROJECT_NAME
  };
}

function ymdInTz(date, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function parseYmd(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDaysYmd(ymd, days) {
  const t = parseYmd(ymd);
  if (t == null) return null;
  const next = new Date(t);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function weekBounds(now, tz) {
  const today = ymdInTz(now, tz);
  const utc = parseYmd(today);
  const dow = new Date(utc).getUTCDay(); // 0 Sun
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const start = addDaysYmd(today, mondayOffset);
  const end = addDaysYmd(start, 6);
  return { start, end, today };
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  const as = parseYmd(aStart);
  const ae = parseYmd(aEnd);
  const bs = parseYmd(bStart);
  const be = parseYmd(bEnd);
  if (as == null || ae == null || bs == null || be == null) return false;
  return as <= be && ae >= bs;
}

function hasDollarFigure(text) {
  return looksFinancial(text);
}

function gateCodeFromText(text) {
  const m = String(text || '').match(/\bM([1-4])\b/i);
  return m ? `M${m[1]}` : null;
}

function uniq(list) {
  return [...new Set((list || []).filter(Boolean))];
}

function ownersFromText(text) {
  const owners = [];
  const src = String(text || '');
  OWNER_ALIASES.forEach((row) => {
    if (row.match.test(src)) owners.push(row.name);
  });
  return owners;
}

function parseOwnerSuffix(title) {
  const m = String(title || '').match(OWNER_SUFFIX_RE);
  if (!m) return [];
  return uniq(
    m[1]
      .split(/[/+,]| and /i)
      .map((part) => part.trim())
      .flatMap((part) => ownersFromText(part))
  );
}

function stripOwnerSuffix(title) {
  return String(title || '').replace(OWNER_SUFFIX_RE, '').trim();
}

function roleOwnersFromTitle(title) {
  const t = String(title || '');
  if (/\(\s*Ops Director\s*\)/i.test(t) || /\(\s*Operations Director\s*\)/i.test(t)) return ['Rudy'];
  if (/\(\s*Managing Director\s*\)/i.test(t)) return ['Mike'];
  return [];
}

function displayTitle(title) {
  return scrubString(stripOwnerSuffix(String(title || '').replace(/^Pleasant Hill:\s*/i, '')));
}

function dedupeIssues(issues) {
  const seen = new Set();
  const out = [];
  (issues || []).forEach((issue) => {
    const key = String((issue && (issue.id || issue.identifier)) || '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(issue);
  });
  return out;
}

function projectNameOf(issue) {
  if (!issue) return '';
  if (typeof issue.project === 'string') return issue.project;
  return (issue.project && issue.project.name) || '';
}

function isSupervisionProject(name) {
  return String(name || '').toLowerCase() === SUPERVISION_PROJECT_NAME.toLowerCase();
}

function includeIssue(issue, cfg) {
  const config = cfg || projectConfig();
  const title = issue && issue.title;
  const projectName = projectNameOf(issue);
  const allowed = (config.names || DEFAULT_PROJECT_NAMES).some(
    (n) => n.toLowerCase() === String(projectName).toLowerCase()
  );
  if (projectName && !allowed) return false;
  if (titleMatchesPrefix(title, config.titlePrefix)) return true;
  if (isSupervisionProject(projectName) && /pleasant hill/i.test(String(title || ''))) return true;
  return false;
}

function ownersFromIssue(issue) {
  const ownerLabels = ((issue.labels && issue.labels.nodes) || [])
    .filter((l) => l.parent && l.parent.name === 'Owner')
    .map((l) => l.name);
  if (ownerLabels.length) return uniq(ownerLabels);

  const suffixOwners = parseOwnerSuffix(issue.title);
  if (suffixOwners.length) return suffixOwners;

  const roleOwners = roleOwnersFromTitle(issue.title);
  if (roleOwners.length) return roleOwners;

  const assignee = issue.assignee || {};
  const hasAssignee = Boolean(assignee.name || assignee.displayName || assignee.email);
  if (hasAssignee) {
    const assigneeOwners = ownersFromText(
      [assignee.name, assignee.displayName, assignee.email].filter(Boolean).join(' ')
    );
    if (assigneeOwners.length) return assigneeOwners;
    return [assignee.displayName || assignee.name];
  }

  const descLine = String(issue.description || '').split('\n')[0] || '';
  if (/^owner\s*:/i.test(descLine)) {
    const descOwners = ownersFromText(descLine);
    if (descOwners.length) return descOwners;
  }
  return ['Unassigned'];
}

function parseStartDate(issue) {
  const desc = String(issue.description || '');
  const titled = desc.match(/\bStart(?:ed)?(?:\s+date)?\s*[:\-]\s*(\d{4}-\d{2}-\d{2})/i);
  if (titled) return titled[1];
  if (issue.startDate && /^\d{4}-\d{2}-\d{2}/.test(issue.startDate)) {
    return String(issue.startDate).slice(0, 10);
  }
  const iso = desc.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso && issue.dueDate && iso[1] < issue.dueDate) return iso[1];
  return null;
}

function phaseFromMilestoneName(name) {
  const raw = String(name || '');
  const numbered = raw.match(/phase\s*([0-4])/i);
  if (numbered) {
    const key = `phase-${numbered[1]}`;
    return PHASES.find((p) => p.key === key) || { key, name: raw };
  }
  const lower = raw.toLowerCase();
  if (/kickoff|site fact/.test(lower)) return PHASES[0];
  if (/proposal|design|schematic/.test(lower)) return PHASES[1];
  if (/permit|procurement|document/.test(lower)) return PHASES[2];
  if (/build|install|rough/.test(lower)) return PHASES[3];
  if (/commission|open|pre-opening/.test(lower)) return PHASES[4];
  if (/ops|recruit|market/.test(lower)) return PHASES[5];
  return null;
}

function phaseFromDate(ymd) {
  if (!ymd) return { key: 'unscheduled', name: 'Unscheduled' };
  for (const phase of PHASES) {
    if (ymd >= phase.start && ymd <= phase.end) return phase;
  }
  if (ymd < PHASES[0].start) return PHASES[0];
  return PHASES[PHASES.length - 1];
}

function mapIssue(raw, todayYmd) {
  const labels = ((raw.labels && raw.labels.nodes) || []).map((l) => l.name).filter(Boolean);
  const dueDate = raw.dueDate || null;
  const startDate = parseStartDate(raw) || dueDate;
  const statusType = (raw.state && raw.state.type) || '';
  const done = statusType === 'completed' || statusType === 'canceled';
  const late = Boolean(dueDate && dueDate < todayYmd && !done);
  const milestone = raw.projectMilestone || null;
  const phase =
    phaseFromMilestoneName(milestone && milestone.name) ||
    phaseFromMilestoneName(labels.join(' ')) ||
    phaseFromDate(startDate || dueDate);
  const gate = gateCodeFromText(raw.title) || gateCodeFromText(milestone && milestone.name) || gateCodeFromText(labels.join(' '));
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: displayTitle(raw.title || ''),
    projectName: projectNameOf(raw),
    url: raw.url || null,
    startDate,
    dueDate,
    status: (raw.state && raw.state.name) || '',
    statusType,
    done,
    late,
    owners: ownersFromIssue(raw),
    phaseKey: phase.key,
    phaseName: phase.name,
    gate
  };
}

function titleMatchesPrefix(title, prefix) {
  return String(title || '').trim().toLowerCase().startsWith(String(prefix).toLowerCase());
}

function buildGates(projectMilestones, issues, todayYmd) {
  return GATE_DEFAULTS.map((def) => {
    const ms = (projectMilestones || []).find((m) => gateCodeFromText(m.name) === def.code);
    const linked = (issues || []).filter((i) => i.gate === def.code);
    const source = ms ? 'project-milestone' : linked.length ? 'issue-title' : 'convention';
    const targetDate = (ms && (ms.targetDate || ms.targetDate || null)) || (linked[0] && linked[0].dueDate) || def.targetDate;
    let status = 'upcoming';
    const msStatus = String((ms && (ms.status || ms.state)) || '').toLowerCase();
    const allDone = linked.length > 0 && linked.every((i) => i.done);
    const anyLate = linked.some((i) => i.late);
    if (msStatus.includes('complet') || allDone) status = 'done';
    else if (anyLate || (targetDate && targetDate < todayYmd && status !== 'done')) status = 'late';
    else if (linked.some((i) => i.statusType === 'started')) status = 'in-progress';
    const fromIssue = linked[0] && linked[0].title;
    let name = displayTitle((ms && ms.name) || fromIssue || def.name);
    name = String(name || '').replace(/^\s*M[1-4]\s*[—–-]+\s*/i, '').trim();
    if (!name || /^M[1-4]$/i.test(name)) name = def.name;
    return {
      code: def.code,
      name,
      targetDate,
      status,
      source,
      issueIds: linked.map((i) => i.identifier || i.id)
    };
  });
}

function thisWeekItems(issues, week) {
  return (issues || []).filter((issue) => {
    const start = issue.startDate || issue.dueDate;
    const end = issue.dueDate || issue.startDate;
    if (!start || !end) return false;
    return rangesOverlap(start, end, week.start, week.end);
  });
}

function groupByPhase(issues) {
  const order = [...PHASES.map((p) => p.key), 'unscheduled'];
  const map = new Map();
  order.forEach((key) => map.set(key, { key, name: (PHASES.find((p) => p.key === key) || { name: 'Unscheduled' }).name, issues: [] }));
  (issues || []).forEach((issue) => {
    const key = issue.phaseKey || 'unscheduled';
    if (!map.has(key)) map.set(key, { key, name: issue.phaseName || 'Unscheduled', issues: [] });
    map.get(key).issues.push(issue);
  });
  [...map.values()].forEach((g) => {
    g.issues.sort((a, b) => String(a.startDate || a.dueDate || '').localeCompare(String(b.startDate || b.dueDate || '')));
  });
  return [...map.values()].filter((g) => g.issues.length);
}

function ganttWindow(issues) {
  let min = '2026-10-01';
  let max = '2027-05-31';
  (issues || []).forEach((issue) => {
    const s = issue.startDate || issue.dueDate;
    const e = issue.dueDate || issue.startDate;
    if (s && s < min) min = s;
    if (e && e > max) max = e;
  });
  return { start: min, end: max };
}

function unconfiguredBoard() {
  return sanitizeForView({
    configured: false,
    source: 'unconfigured',
    message: 'Linear not configured',
    site: SITE,
    project: { name: projectConfig().name, url: null },
    fetchedAt: null,
    week: null,
    issues: [],
    phases: [],
    thisWeek: [],
    late: [],
    gates: GATE_DEFAULTS.map((g) => ({ ...g, status: 'unknown', source: 'convention', issueIds: [] })),
    gantt: { start: '2026-10-01', end: '2027-05-31' }
  });
}

function assembleBoard({ issues, project, milestones, source, now }) {
  const week = weekBounds(now, TZ);
  const mapped = dedupeIssues((issues || []).map((issue) => mapIssue(issue, week.today)));
  mapped.sort((a, b) => String(a.startDate || a.dueDate || '').localeCompare(String(b.startDate || b.dueDate || '')));
  const gates = buildGates(milestones || [], mapped, week.today);
  const board = {
    configured: source !== 'unconfigured',
    source,
    message: source === 'unconfigured' ? 'Linear not configured' : null,
    site: SITE,
    project: project || { name: projectConfig().name, url: null },
    fetchedAt: now.toISOString(),
    week,
    issues: mapped,
    phases: groupByPhase(mapped),
    thisWeek: thisWeekItems(mapped, week),
    late: mapped.filter((i) => i.late),
    gates,
    gantt: ganttWindow(mapped)
  };
  return sanitizeForView(board);
}

function fixtureIssueToLinear(row) {
  return {
    id: row.identifier,
    identifier: row.identifier,
    title: row.title,
    description: row.description || '',
    url: row.url,
    dueDate: row.dueDate || null,
    startDate: row.startDate || null,
    state: { name: row.status || 'Backlog', type: row.statusType || 'backlog' },
    assignee: row.assignee || null,
    labels: { nodes: [] },
    projectMilestone: null,
    project: { name: row.project }
  };
}

function loadFixtureFile() {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  return (raw.issues || []).map(fixtureIssueToLinear);
}

function fixtureLinearIssues() {
  return loadFixtureFile();
}

function fixtureBoard(now) {
  const cfg = projectConfig();
  const issues = fixtureLinearIssues().filter((issue) => includeIssue(issue, cfg));
  return assembleBoard({
    issues,
    project: {
      name: DEFAULT_PROJECT_NAME,
      url: null
    },
    milestones: [],
    source: 'fixture',
    now
  });
}

async function fetchProjectIssues(apiKey, graphql, projectName, teamKey) {
  const query = `query PleasantHillProjectIssues($after: String, $teamKey: String!, $projectName: String!) {
    issues(
      first: 100
      after: $after
      filter: {
        team: { key: { eq: $teamKey } }
        project: { name: { eqIgnoreCase: $projectName } }
      }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        title
        description
        url
        dueDate
        state { name type }
        assignee { name displayName email }
        labels { nodes { name parent { name } } }
        projectMilestone { id name targetDate }
        project { id name url }
      }
    }
  }`;
  const issues = [];
  let after = null;
  do {
    const data = await graphql(apiKey, query, { after, teamKey, projectName });
    const conn = data.issues || { nodes: [], pageInfo: {} };
    issues.push(...(conn.nodes || []));
    after = conn.pageInfo && conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return issues;
}

async function fetchPleasantHillFromLinear(apiKey, graphql) {
  const cfg = projectConfig();
  const issues = [];
  for (const projectName of cfg.names) {
    const batch = await fetchProjectIssues(apiKey, graphql, projectName, cfg.teamKey);
    issues.push(...batch);
  }

  const milestones = [];
  const projects = [];
  for (const projectName of cfg.names) {
    const pdata = await graphql(
      apiKey,
      `query PleasantHillProject($name: String!) {
        projects(first: 5, filter: { name: { eqIgnoreCase: $name } }) {
          nodes {
            id name url
            projectMilestones(first: 50) { nodes { id name targetDate } }
          }
        }
      }`,
      { name: projectName }
    );
    const nodes = (pdata.projects && pdata.projects.nodes) || [];
    nodes.forEach((p) => {
      projects.push(p);
      (p.projectMilestones && p.projectMilestones.nodes || []).forEach((m) => milestones.push(m));
    });
  }

  const project = projects.find((p) => p.name === cfg.name) || projects[0] || null;
  const filtered = issues.filter((issue) => includeIssue(issue, cfg));
  return {
    project: project
      ? { id: project.id, name: project.name, url: project.url }
      : { name: cfg.name, url: null },
    projects: projects.map((p) => ({ id: p.id, name: p.name, url: p.url })),
    milestones,
    issues: filtered
  };
}

async function getPleasantHillBoard(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const production = options.production !== undefined
    ? Boolean(options.production)
    : process.env.NODE_ENV === 'production';
  if (options.fixture && !production) return fixtureBoard(now);

  const apiKey = options.apiKey !== undefined ? options.apiKey : process.env.LINEAR_API_KEY;
  if (!apiKey) return unconfiguredBoard();
  if (options.checkGate !== false && failClosed()) {
    console.error('PH_VIEW_PASSWORD missing; refusing live Linear');
    return sanitizeForView({
      configured: true,
      source: 'gated',
      message: VIEWER_LOAD_ERROR,
      site: SITE,
      project: { name: projectConfig().name, url: null },
      fetchedAt: now.toISOString(),
      week: weekBounds(now, TZ),
      issues: [],
      phases: [],
      thisWeek: [],
      late: [],
      gates: GATE_DEFAULTS.map((g) => ({ ...g, status: 'unknown', source: 'convention', issueIds: [] })),
      gantt: { start: '2026-10-01', end: '2027-05-31' }
    });
  }

  const cfg = projectConfig();
  const cacheKey = `${cfg.teamKey}|${cfg.names.join(',')}|${cfg.titlePrefix}`;
  const ttlDefault = Number(process.env.LINEAR_PLEASANT_HILL_CACHE_MS || CACHE_TTL_MS);
  if (!options.bypassCache && cache.data && cache.key === cacheKey && Date.now() - cache.at < (cache.ttl || ttlDefault)) {
    return cache.data;
  }

  const graphql = options.graphql || linearGraphql;
  try {
    const fetched = await fetchPleasantHillFromLinear(apiKey, graphql);
    const board = assembleBoard({
      issues: fetched.issues,
      project: fetched.project,
      milestones: fetched.milestones,
      source: 'linear',
      now
    });
    cache = { key: cacheKey, at: Date.now(), data: board, ttl: ttlDefault };
    return board;
  } catch (err) {
    console.error('Pleasant Hill Linear fetch failed:', err && err.message);
    const board = sanitizeForView({
      configured: true,
      source: 'error',
      message: VIEWER_LOAD_ERROR,
      site: SITE,
      project: { name: cfg.name, url: null },
      fetchedAt: now.toISOString(),
      week: weekBounds(now, TZ),
      issues: [],
      phases: [],
      thisWeek: [],
      late: [],
      gates: GATE_DEFAULTS.map((g) => ({ ...g, status: 'unknown', source: 'convention', issueIds: [] })),
      gantt: { start: '2026-10-01', end: '2027-05-31' }
    });
    cache = { key: cacheKey, at: Date.now(), data: board, ttl: ERROR_CACHE_TTL_MS };
    return board;
  }
}

function resetPleasantHillCache() {
  cache = { key: null, at: 0, data: null, ttl: 0 };
}

module.exports = {
  CACHE_TTL_MS,
  ERROR_CACHE_TTL_MS,
  DEFAULT_PROJECT_NAME,
  DEFAULT_PROJECT_NAMES,
  DEFAULT_TEAM_KEY,
  SUPERVISION_PROJECT_NAME,
  TITLE_PREFIX,
  assembleBoard,
  buildGates,
  deepStrip,
  displayTitle,
  dedupeIssues,
  fixtureBoard,
  fixtureLinearIssues,
  gateCodeFromText,
  getPleasantHillBoard,
  groupByPhase,
  hasDollarFigure,
  includeIssue,
  mapIssue,
  ownersFromIssue,
  parseOwnerSuffix,
  parseStartDate,
  projectConfig,
  rangesOverlap,
  resetPleasantHillCache,
  stripFinancials,
  stripOwnerSuffix,
  thisWeekItems,
  titleMatchesPrefix,
  unconfiguredBoard,
  VIEWER_LOAD_ERROR,
  weekBounds,
  ymdInTz
};
