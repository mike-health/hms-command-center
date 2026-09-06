'use strict';

const crypto = require('crypto');
const opsCadence = require('./ops-cadence');

const { DEFAULT_TEAM_ID } = opsCadence;

const SENSITIVE_PATTERN =
  /\b(pay(?:ment|ment)?|invoice|bill(?:ing)?|charge|refund|wire|ach|stripe|venmo|zelle|purchase|buy|expense|reimburse|send\s+email|email\s+(?:to|the|patient|client|vendor)|mail\s+(?:to|the)|notify\s+by\s+email|payment\s+link)\b/i;

const CREATE_PATTERN = /^(?:create|add|new)\s+(?:task|issue)?\s*:?\s*(.+)$/i;
const UPDATE_ID_PATTERN = /^(?:update|edit)\s+(HEA-\d+)\s*:?\s*(.*)$/i;

const STATUS_ALIASES = {
  done: ['done', 'complete', 'completed'],
  progress: ['in progress', 'progress', 'started'],
  todo: ['todo', 'to do'],
  backlog: ['backlog'],
  blocked: ['blocked', 'block'],
  canceled: ['canceled', 'cancelled', 'cancel']
};

function normalizeText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function detectSensitiveKeywords(text) {
  return SENSITIVE_PATTERN.test(text);
}

function parseDueDate(text) {
  const m = text.match(/\bdue(?:\s+date)?(?:\s+to|\s+on|\s+by)?\s+(.+?)(?:\s+(?:assign|owner|priority|move|mark|set)\b|$)/i);
  if (!m) return null;
  const raw = m[1].trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const lower = raw.toLowerCase();
  const today = new Date();
  if (lower === 'today') return today.toISOString().slice(0, 10);
  if (lower === 'tomorrow') {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return raw;
}

function parsePriority(text) {
  const m = text.match(/\b(?:priority|prio)\s+(?:to\s+)?(urgent|high|medium|low)\b/i);
  if (!m) return null;
  const map = { urgent: 1, high: 2, medium: 3, low: 4 };
  return map[m[1].toLowerCase()] || null;
}

function parseOwner(text, ownerLabels) {
  const assign = text.match(/\b(?:assign(?:ee)?|owner)\s+(?:to\s+)?([A-Za-z]+)\b/i);
  if (assign) {
    const name = assign[1];
    const match = (ownerLabels || []).find((l) => l.toLowerCase() === name.toLowerCase());
    return match || name;
  }
  return null;
}

function parseCadence(text, fallback) {
  const move = text.match(/\bmove(?:\s+to)?\s+(daily|weekly|monthly)\b/i);
  if (move) return move[1].charAt(0).toUpperCase() + move[1].slice(1).toLowerCase();
  const inline = text.match(/\b(daily|weekly|monthly)\b/i);
  if (inline) return inline[1].charAt(0).toUpperCase() + inline[1].slice(1).toLowerCase();
  return fallback || null;
}

function parseStatus(text) {
  const m = text.match(
    /\b(?:mark|set|move(?:\s+\w+)*?\s+to|status(?:\s+to)?)\s+(done|complete|completed|in progress|progress|started|todo|to do|backlog|blocked|block|canceled|cancelled|cancel)\b/i
  );
  if (!m) {
    if (/^mark\s+done$/i.test(text.trim())) return 'done';
    return null;
  }
  const target = m[1].toLowerCase();
  for (const [key, aliases] of Object.entries(STATUS_ALIASES)) {
    if (aliases.includes(target)) return key;
  }
  return null;
}

function parseTitleUpdate(text) {
  const rename = text.match(/\b(?:rename|title)\s+(?:to\s+)?(.+)$/i);
  return rename ? rename[1].trim() : null;
}

function extractCreateTitle(text) {
  let title = text
    .replace(/\b(?:daily|weekly|monthly)\b/gi, '')
    .replace(/\b(?:assign(?:ee)?|owner)\s+(?:to\s+)?[A-Za-z]+\b/gi, '')
    .replace(/\bdue(?:\s+date)?(?:\s+to|\s+on|\s+by)?\s+[^,]+/gi, '')
    .replace(/\b(?:priority|prio)\s+(?:to\s+)?(?:urgent|high|medium|low)\b/gi, '')
    .trim();
  title = title.replace(/^["']|["']$/g, '').trim();
  return title || null;
}

function resolveIssue(instruction, context, issues) {
  const updateMatch = instruction.match(UPDATE_ID_PATTERN);
  if (updateMatch) {
    const identifier = updateMatch[1].toUpperCase();
    const issue = (issues || []).find((i) => i.identifier === identifier);
    return { issue, remainder: updateMatch[2] || '' };
  }
  if (context && context.issueId) {
    const issue = (issues || []).find((i) => i.id === context.issueId);
    return { issue, remainder: instruction };
  }
  const idInline = instruction.match(/\b(HEA-\d+)\b/i);
  if (idInline) {
    const identifier = idInline[1].toUpperCase();
    const issue = (issues || []).find((i) => i.identifier === identifier);
    return { issue, remainder: instruction.replace(idInline[0], '').trim() };
  }
  return { issue: null, remainder: instruction };
}

function buildPreviewLines(plan) {
  const lines = [];
  lines.push(`Action: ${plan.action}`);
  if (plan.targetIdentifier) lines.push(`Issue: ${plan.targetIdentifier}`);
  if (plan.changes.title) lines.push(`Title → ${plan.changes.title}`);
  if (plan.changes.status) lines.push(`Status → ${plan.changes.status}`);
  if (plan.changes.owner) lines.push(`Owner label → ${plan.changes.owner}`);
  if (plan.changes.cadence) lines.push(`Cadence label → ${plan.changes.cadence}`);
  if (plan.changes.dueDate) lines.push(`Due date → ${plan.changes.dueDate}`);
  if (plan.changes.priority) lines.push(`Priority → ${plan.changes.priority}`);
  if (plan.changes.description) lines.push(`Description → ${plan.changes.description}`);
  return lines;
}

function parseOpsInstruction(instruction, context, issues) {
  const text = normalizeText(instruction);
  if (!text) {
    return { ok: false, error: 'Enter an instruction (e.g. "create Review chamber logs weekly assign Stacey").' };
  }

  const ownerLabels = (context && context.ownerLabels) || [];
  const defaultCadence = (context && context.cadence) || 'Daily';
  const sensitive = detectSensitiveKeywords(text);

  const createMatch = text.match(CREATE_PATTERN);
  if (createMatch) {
    const body = createMatch[1];
    const title = extractCreateTitle(body);
    if (!title) {
      return { ok: false, error: 'Could not parse a title for the new issue.' };
    }
    const plan = {
      action: 'create',
      changes: {
        title,
        cadence: parseCadence(body, defaultCadence),
        owner: parseOwner(body, ownerLabels),
        dueDate: parseDueDate(body),
        priority: parsePriority(body)
      }
    };
    return {
      ok: true,
      plan,
      previewLines: buildPreviewLines(plan),
      requiresConfirm: sensitive,
      sensitiveNote: sensitive
        ? 'This instruction mentions payment or email. Confirm only after you verify no automatic payment or email will be sent — this board only updates Linear.'
        : null
    };
  }

  const { issue, remainder } = resolveIssue(text, context, issues);
  if (!issue) {
    return {
      ok: false,
      error:
        'No matching issue. Open a card, include HEA-###, or say "update HEA-82 …".'
    };
  }

  const work = remainder || text;
  const changes = {};
  const title = parseTitleUpdate(work);
  if (title) changes.title = title;
  const status = parseStatus(work);
  if (status) changes.status = status;
  const owner = parseOwner(work, ownerLabels);
  if (owner) changes.owner = owner;
  const cadenceLabel = parseCadence(work, null);
  if (cadenceLabel && opsCadence.CADENCE_NAMES.includes(cadenceLabel)) changes.cadence = cadenceLabel;
  const dueDate = parseDueDate(work);
  if (dueDate) changes.dueDate = dueDate;
  const priority = parsePriority(work);
  if (priority) changes.priority = priority;

  if (!Object.keys(changes).length) {
    return {
      ok: false,
      error:
        'Could not parse an update. Try "mark done", "assign Mike", "move to Weekly", or "due 2026-09-15".'
    };
  }

  const plan = {
    action: 'update',
    issueId: issue.id,
    targetIdentifier: issue.identifier,
    changes
  };

  return {
    ok: true,
    plan,
    previewLines: buildPreviewLines(plan),
    requiresConfirm: sensitive,
    sensitiveNote: sensitive
      ? 'This instruction mentions payment or email. Confirm only after you verify no automatic payment or email will be sent — this board only updates Linear.'
      : null
  };
}

function signPlan(plan) {
  const payload = JSON.stringify(plan);
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

async function previewOpsInstruction(body) {
  const instruction = body && body.instruction;
  const context = {
    issueId: body && body.issueId,
    cadence: body && body.cadence,
    ownerLabels: body && body.ownerLabels
  };

  let issues = body && body.issues;
  if (!issues || !issues.length) {
    const board = await opsCadence.getOpsCadenceBoard();
    issues = board.issues || [];
    if (!context.ownerLabels || !context.ownerLabels.length) {
      context.ownerLabels = board.ownerLabels || [];
    }
  }

  const parsed = parseOpsInstruction(instruction, context, issues);
  if (!parsed.ok) return parsed;

  const planId = signPlan(parsed.plan);
  return {
    ok: true,
    planId,
    plan: parsed.plan,
    previewLines: parsed.previewLines,
    requiresConfirm: parsed.requiresConfirm,
    sensitiveNote: parsed.sensitiveNote
  };
}

async function applyOpsPlan(body) {
  const plan = body && body.plan;
  const planId = body && body.planId;
  const confirmed = body && body.confirmed;

  if (!plan || !planId) {
    return { ok: false, error: 'Missing plan. Run preview first.' };
  }
  if (signPlan(plan) !== planId) {
    return { ok: false, error: 'Plan mismatch. Preview again before applying.' };
  }
  if (!confirmed) {
    return { ok: false, error: 'Confirmation required before applying changes to Linear.' };
  }

  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    return {
      ok: true,
      mock: true,
      message: 'Demo mode — set LINEAR_API_KEY on the server to apply changes to Linear.',
      issue: {
        identifier: plan.targetIdentifier || 'HEA-NEW',
        title: plan.changes && plan.changes.title
      }
    };
  }

  const result = await opsCadence.applyOpsMutation(apiKey, plan);
  return { ok: true, ...result };
}

module.exports = {
  DEFAULT_TEAM_ID,
  SENSITIVE_PATTERN,
  applyOpsPlan,
  buildPreviewLines,
  detectSensitiveKeywords,
  parseOpsInstruction,
  previewOpsInstruction,
  signPlan
};
