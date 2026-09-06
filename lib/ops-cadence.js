'use strict';

const LINEAR_GRAPHQL = 'https://api.linear.app/graphql';
const DEFAULT_PROJECT_ID = '91532ea3-24e8-4e10-981e-03b6fb245cd6';
const DEFAULT_PROJECT_NAME = 'Ops cadence';
const DEFAULT_TEAM_ID = '09dda024-9314-4019-9c18-5185757e3edd';
const DEFAULT_PROJECT_URL = 'https://linear.app/healthi/project/ops-cadence-ebb195e01b21';
const CADENCE_NAMES = ['Daily', 'Weekly', 'Monthly'];
const CADENCE_SET = new Set(CADENCE_NAMES);

const MOCK_OWNER_LABELS = ['Mike', 'Rudy', 'Stacey'];

const PRIORITY_LABELS = {
  0: null,
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low'
};

const MOCK_ISSUES = [
  {
    id: 'mock-hea-82',
    identifier: 'HEA-82',
    title: 'Oceanside — Skip machine-room door / PVC punch',
    url: 'https://linear.app/healthi/issue/HEA-82/oceanside-skip-machine-room-door-pvc-punch',
    status: 'Backlog',
    statusType: 'backlog',
    dueDate: null,
    cadenceLabels: ['Daily'],
    ownerLabels: ['Rudy'],
    streamLabel: 'Equipment',
    priority: 'High',
    description: 'Coordinate with facilities on skip door access. Confirm PVC punch list before chamber install week.'
  },
  {
    id: 'mock-hea-81',
    identifier: 'HEA-81',
    title: 'Ship Ops cadence URL board (Daily/Weekly/Monthly + people filter)',
    url: 'https://linear.app/healthi/issue/HEA-81/ship-ops-cadence-url-board-dailyweeklymonthly-people-filter',
    status: 'Backlog',
    statusType: 'backlog',
    dueDate: null,
    cadenceLabels: ['Daily'],
    ownerLabels: ['Mike'],
    streamLabel: null,
    priority: 'Medium',
    description: 'Ops cadence board lives at /modules/ops-board.html. Filter by Daily/Weekly/Monthly tabs and Owner chips. Linear is system of record.'
  },
  {
    id: 'mock-weekly-1',
    identifier: 'HEA-00',
    title: 'Weekly clinic ops review (sample)',
    url: DEFAULT_PROJECT_URL,
    status: 'Todo',
    statusType: 'unstarted',
    dueDate: '2026-09-08',
    cadenceLabels: ['Weekly'],
    ownerLabels: ['Stacey'],
    streamLabel: 'Clinical',
    priority: 'High',
    description: 'Review open clinic ops items, staffing gaps, and chamber utilization for the week.'
  },
  {
    id: 'mock-monthly-1',
    identifier: 'HEA-00M',
    title: 'Monthly close-out and staffing plan (sample)',
    url: DEFAULT_PROJECT_URL,
    status: 'Todo',
    statusType: 'unstarted',
    dueDate: '2026-09-30',
    cadenceLabels: ['Monthly'],
    ownerLabels: ['Rudy', 'Mike'],
    streamLabel: 'Staffing',
    priority: 'Medium',
    description: 'Monthly close-out checklist plus next-month staffing plan and PTO coverage.'
  }
];

function projectConfig() {
  return {
    id: process.env.LINEAR_PROJECT_ID || DEFAULT_PROJECT_ID,
    name: process.env.LINEAR_PROJECT_NAME || DEFAULT_PROJECT_NAME,
    url: DEFAULT_PROJECT_URL
  };
}

function labelNodes(issue) {
  return (issue.labels && issue.labels.nodes) || [];
}

function mapPriority(value) {
  if (value == null || value === 0) return null;
  return PRIORITY_LABELS[value] || null;
}

function streamFromLabels(labels) {
  const fromGroup = labels
    .filter((l) => l.parent && l.parent.name === 'Stream')
    .map((l) => l.name)
    .filter(Boolean);
  return fromGroup[0] || null;
}

function mapLinearIssue(issue, ownerNameSet) {
  const labels = labelNodes(issue);
  const names = labels.map((l) => l.name).filter(Boolean);
  const cadenceLabels = [...new Set(names.filter((n) => CADENCE_SET.has(n)))];
  let ownerLabels = names.filter((n) => ownerNameSet.has(n));
  if (!ownerLabels.length) {
    ownerLabels = labels
      .filter((l) => l.parent && l.parent.name === 'Owner')
      .map((l) => l.name)
      .filter((n) => n && !CADENCE_SET.has(n));
  }
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    status: (issue.state && issue.state.name) || '',
    statusType: (issue.state && issue.state.type) || '',
    dueDate: issue.dueDate || null,
    cadenceLabels,
    ownerLabels: [...new Set(ownerLabels)],
    streamLabel: streamFromLabels(labels),
    priority: mapPriority(issue.priority),
    description: issue.description || null
  };
}

function filterOpsIssues(issues, cadence, owners) {
  const ownerFilter = (owners || []).filter(Boolean);
  return (issues || []).filter((issue) => {
    if (!issue.cadenceLabels || !issue.cadenceLabels.includes(cadence)) return false;
    if (!ownerFilter.length) return true;
    return (issue.ownerLabels || []).some((name) => ownerFilter.includes(name));
  });
}

function collectOwnerLabels(workspaceLabels, issues) {
  const fromGroup = (workspaceLabels || [])
    .filter((l) => l.parent && l.parent.name === 'Owner')
    .map((l) => l.name)
    .filter(Boolean);
  if (fromGroup.length) return [...new Set(fromGroup)].sort((a, b) => a.localeCompare(b));
  const fromIssues = new Set();
  (issues || []).forEach((issue) => {
    (issue.ownerLabels || []).forEach((n) => fromIssues.add(n));
  });
  if (fromIssues.size) return [...fromIssues].sort((a, b) => a.localeCompare(b));
  return [...MOCK_OWNER_LABELS];
}

async function linearGraphql(apiKey, query, variables) {
  const res = await fetch(LINEAR_GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey
    },
    body: JSON.stringify({ query, variables })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body.errors && body.errors[0] && body.errors[0].message) || res.statusText;
    throw new Error(`Linear HTTP ${res.status}: ${msg}`);
  }
  if (body.errors && body.errors.length) {
    throw new Error(body.errors[0].message || 'Linear GraphQL error');
  }
  return body.data;
}

async function fetchOwnerLabels(apiKey) {
  const data = await linearGraphql(
    apiKey,
    `query OwnerLabels {
      issueLabels(first: 250) {
        nodes { id name parent { name } }
      }
    }`
  );
  const nodes = (data.issueLabels && data.issueLabels.nodes) || [];
  return nodes.filter((l) => l.parent && l.parent.name === 'Owner');
}

async function fetchProjectIssues(apiKey, projectId) {
  const query = `query OpsCadenceIssues($projectId: ID!, $after: String) {
    project(id: $projectId) {
      id
      name
      url
      issues(
        first: 100
        after: $after
        filter: { state: { type: { nin: ["completed", "canceled"] } } }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          identifier
          title
          description
          url
          dueDate
          priority
          state { name type }
          labels { nodes { id name parent { name } } }
        }
      }
    }
  }`;

  const issues = [];
  let after = null;
  let project = null;
  do {
    const data = await linearGraphql(apiKey, query, { projectId, after });
    project = data.project;
    if (!project) throw new Error('Linear project not found. Check LINEAR_PROJECT_ID.');
    const conn = project.issues || { nodes: [], pageInfo: {} };
    issues.push(...(conn.nodes || []));
    after = conn.pageInfo && conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return { project, issues };
}

function mockBoard() {
  const project = projectConfig();
  return {
    configured: false,
    source: 'mock',
    project,
    ownerLabels: MOCK_OWNER_LABELS,
    cadenceLabels: CADENCE_NAMES,
    issues: MOCK_ISSUES
  };
}

function teamConfig() {
  return {
    id: process.env.LINEAR_TEAM_ID || DEFAULT_TEAM_ID
  };
}

async function fetchWorkflowStates(apiKey, teamId) {
  const data = await linearGraphql(
    apiKey,
    `query TeamStates($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name type } }
      }
    }`,
    { teamId }
  );
  return ((data.team && data.team.states && data.team.states.nodes) || []).slice();
}

async function fetchLabelIndex(apiKey) {
  const data = await linearGraphql(
    apiKey,
    `query IssueLabels {
      issueLabels(first: 250) {
        nodes { id name parent { name } }
      }
    }`
  );
  const nodes = (data.issueLabels && data.issueLabels.nodes) || [];
  const byName = new Map();
  nodes.forEach((l) => {
    if (l.name) byName.set(l.name.toLowerCase(), l);
  });
  return { nodes, byName };
}

function resolveStateId(states, statusKey) {
  const aliases = {
    done: ['done', 'complete', 'completed'],
    progress: ['in progress', 'progress', 'started'],
    todo: ['todo', 'to do'],
    backlog: ['backlog'],
    blocked: ['blocked', 'block'],
    canceled: ['canceled', 'cancelled', 'cancel']
  };
  const wanted = aliases[statusKey] || [statusKey];
  const match = states.find((s) => wanted.includes((s.name || '').toLowerCase()));
  if (match) return match.id;
  const byType = {
    done: 'completed',
    progress: 'started',
    todo: 'unstarted',
    backlog: 'backlog',
    blocked: 'started',
    canceled: 'canceled'
  };
  const type = byType[statusKey];
  if (type) {
    const typed = states.find((s) => s.type === type);
    if (typed) return typed.id;
  }
  return null;
}

function resolveLabelIds(labelIndex, names) {
  const ids = [];
  (names || []).forEach((name) => {
    const label = labelIndex.byName.get(String(name).toLowerCase());
    if (label) ids.push(label.id);
  });
  return ids;
}

function priorityLabel(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return PRIORITY_LABELS[value] || null;
}

async function applyOpsMutation(apiKey, plan) {
  const team = teamConfig();
  const project = projectConfig();
  const [states, labelIndex] = await Promise.all([
    fetchWorkflowStates(apiKey, team.id),
    fetchLabelIndex(apiKey)
  ]);

  if (plan.action === 'create') {
    const changes = plan.changes || {};
    const labelNames = [changes.cadence, changes.owner].filter(Boolean);
    const labelIds = resolveLabelIds(labelIndex, labelNames);
    const input = {
      teamId: team.id,
      projectId: project.id,
      title: changes.title
    };
    if (changes.dueDate) input.dueDate = changes.dueDate;
    if (changes.priority) input.priority = changes.priority;
    if (labelIds.length) input.labelIds = labelIds;

    const data = await linearGraphql(
      apiKey,
      `mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier title url state { name type } dueDate priority labels { nodes { id name parent { name } } } }
        }
      }`,
      { input }
    );
    const issue = data.issueCreate && data.issueCreate.issue;
    if (!issue) throw new Error('Linear did not return the created issue.');
    const ownerNameSet = new Set(
      (labelIndex.nodes || [])
        .filter((l) => l.parent && l.parent.name === 'Owner')
        .map((l) => l.name)
    );
    return { issue: mapLinearIssue(issue, ownerNameSet), action: 'create' };
  }

  if (plan.action === 'update') {
    const changes = plan.changes || {};
    const input = {};
    if (changes.title) input.title = changes.title;
    if (changes.dueDate) input.dueDate = changes.dueDate;
    if (changes.priority) input.priority = changes.priority;
    if (changes.description) input.description = changes.description;
    if (changes.status) {
      const stateId = resolveStateId(states, changes.status);
      if (!stateId) throw new Error(`Could not resolve Linear status for "${changes.status}".`);
      input.stateId = stateId;
    }

    const addLabelNames = [changes.cadence, changes.owner].filter(Boolean);
    const addLabelIds = resolveLabelIds(labelIndex, addLabelNames);
    if (addLabelIds.length) input.addLabelIds = addLabelIds;

    const data = await linearGraphql(
      apiKey,
      `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            id identifier title url dueDate priority description
            state { name type }
            labels { nodes { id name parent { name } } }
          }
        }
      }`,
      { id: plan.issueId, input }
    );
    const issue = data.issueUpdate && data.issueUpdate.issue;
    if (!issue) throw new Error('Linear did not return the updated issue.');
    const ownerNameSet = new Set(
      (labelIndex.nodes || [])
        .filter((l) => l.parent && l.parent.name === 'Owner')
        .map((l) => l.name)
    );
    return {
      issue: mapLinearIssue(issue, ownerNameSet),
      action: 'update',
      priorityLabel: priorityLabel(issue.priority)
    };
  }

  throw new Error(`Unsupported action: ${plan.action}`);
}

async function getOpsCadenceBoard() {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return mockBoard();

  const project = projectConfig();
  const [ownerGroup, fetched] = await Promise.all([
    fetchOwnerLabels(apiKey),
    fetchProjectIssues(apiKey, project.id)
  ]);
  const ownerNameSet = new Set(ownerGroup.map((l) => l.name));
  const issues = fetched.issues.map((issue) => mapLinearIssue(issue, ownerNameSet));
  const ownerLabels = collectOwnerLabels(ownerGroup, issues);
  return {
    configured: true,
    source: 'linear',
    project: {
      id: fetched.project.id || project.id,
      name: fetched.project.name || project.name,
      url: fetched.project.url || project.url
    },
    ownerLabels,
    cadenceLabels: CADENCE_NAMES,
    issues
  };
}

module.exports = {
  CADENCE_NAMES,
  DEFAULT_PROJECT_ID,
  DEFAULT_TEAM_ID,
  MOCK_ISSUES,
  PRIORITY_LABELS,
  applyOpsMutation,
  collectOwnerLabels,
  filterOpsIssues,
  getOpsCadenceBoard,
  linearGraphql,
  mapLinearIssue,
  mapPriority,
  mockBoard,
  projectConfig,
  resolveStateId,
  streamFromLabels,
  teamConfig
};
