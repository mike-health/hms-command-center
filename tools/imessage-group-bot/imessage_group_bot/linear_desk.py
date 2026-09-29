"""Pleasant Hill Linear Q&A and gated due-date proposals."""

from __future__ import print_function

import random
import re
from datetime import date, datetime, timedelta

from .guardrails import clamp_reply, local_now
from .linear_client import LinearClient, LinearError
from .logs import log_event
from .trigger import handle_allowed


DOLLAR_RE = re.compile(
    r"\$\s*[\d,]+(?:\.\d+)?|\bUSD\s*[\d,]+(?:\.\d+)?|\b\d[\d,]*\s*(?:dollars?|bucks)\b",
    re.IGNORECASE,
)
CONFIRM_RE = re.compile(r"^(?:confirm|ok)\s+([A-Za-z0-9]{2,8})\s*$", re.IGNORECASE)
DATE_CHANGE_RE = re.compile(
    r"^(?:please\s+)?(?:move|moved|reschedule|change)\s+(?P<what>.+?)\s+"
    r"(?:to|for|until)\s+(?P<when>.+?)\s*$",
    re.IGNORECASE,
)
MOVED_TO_RE = re.compile(
    r"^(?P<what>.+?)\s+moved\s+to\s+(?P<when>.+?)\s*$",
    re.IGNORECASE,
)
OWNER_WEEK_RE = re.compile(
    r"(?:what(?:'s| is|s)?|whats)\s+(?P<who>.+?)\s+doing\s+this\s+week",
    re.IGNORECASE,
)
NEXT_GATE_RE = re.compile(
    r"(?:what(?:'s| is|s)?\s+(?:the\s+)?)?next\s+gate",
    re.IGNORECASE,
)
NEXT_RE = re.compile(r"what(?:'s| is|s)?\s+next", re.IGNORECASE)
LATE_RE = re.compile(r"what(?:'s| is|s)?\s+late", re.IGNORECASE)
TITLE_OWNER_RE = re.compile(r"\s*\(\s*Owner:\s*([^)]+?)\s*\)\s*$", re.IGNORECASE)
GATE_RE = re.compile(r"\bM([1-4])\b", re.IGNORECASE)
MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}
CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"
CODE_DIGITS = "23456789"
DONE_STATES = frozenset(("completed", "canceled", "cancelled", "done"))


def strip_dollars(text):
    if not text:
        return text
    return " ".join(DOLLAR_RE.sub("", text).split())


def _short_date(value):
    if not value:
        return "?"
    if isinstance(value, date) and not isinstance(value, datetime):
        return "%d/%d" % (value.month, value.day)
    text = str(value)[:10]
    try:
        parsed = datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        return text
    return "%d/%d" % (parsed.month, parsed.day)


def parse_date_token(token, ref_date):
    raw = (token or "").strip().strip(".,")
    if not raw:
        return None
    raw = raw.replace(",", " ")
    iso = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", raw)
    if iso:
        try:
            return date(int(iso.group(1)), int(iso.group(2)), int(iso.group(3)))
        except ValueError:
            return None
    slash = re.match(r"^(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?$", raw)
    if slash:
        month, day = int(slash.group(1)), int(slash.group(2))
        year = slash.group(3)
        if year:
            year_i = int(year)
            if year_i < 100:
                year_i += 2000
        else:
            year_i = ref_date.year
            try:
                candidate = date(year_i, month, day)
            except ValueError:
                return None
            if candidate < ref_date - timedelta(days=45):
                year_i += 1
        try:
            return date(year_i, month, day)
        except ValueError:
            return None
    named = re.match(r"^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$", raw)
    if named:
        month = MONTHS.get(named.group(1).lower())
        if not month:
            return None
        day = int(named.group(2))
        year_i = int(named.group(3)) if named.group(3) else ref_date.year
        try:
            candidate = date(year_i, month, day)
        except ValueError:
            return None
        if named.group(3) is None and candidate < ref_date - timedelta(days=45):
            try:
                candidate = date(year_i + 1, month, day)
            except ValueError:
                return None
        return candidate
    return None


def parse_intent(rest):
    text = " ".join((rest or "").split())
    if not text:
        return None
    confirm = CONFIRM_RE.match(text)
    if confirm:
        return {"type": "confirm", "code": confirm.group(1).upper()}
    moved = MOVED_TO_RE.match(text) or DATE_CHANGE_RE.match(text)
    if moved:
        return {
            "type": "date_change",
            "what": moved.group("what").strip(),
            "when": moved.group("when").strip(),
        }
    owner_week = OWNER_WEEK_RE.search(text)
    if owner_week:
        return {"type": "owner_week", "who": owner_week.group("who").strip()}
    if LATE_RE.search(text):
        return {"type": "late"}
    if NEXT_GATE_RE.search(text):
        return {"type": "next_gate"}
    if NEXT_RE.search(text):
        return {"type": "next"}
    if "pleasant hill" in text.lower() or "pleasanton" in text.lower():
        return {"type": "next"}
    return None


def issue_open(issue):
    state = (issue.get("state_type") or "").lower()
    if state in DONE_STATES:
        return False
    return True


def due_date(issue):
    raw = issue.get("dueDate")
    if not raw:
        return None
    text = str(raw)[:10]
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        return None


def strip_owner_suffix(title):
    return TITLE_OWNER_RE.sub("", title or "").strip()


def title_owner_suffix(title):
    match = TITLE_OWNER_RE.search(title or "")
    return match.group(1).strip() if match else ""


def owner_blob(issue):
    title = issue.get("title") or ""
    assignee = (issue.get("assignee_name") or "").strip()
    parsed_owner = title_owner_suffix(title) if not assignee else ""
    parts = [
        assignee or parsed_owner,
        strip_owner_suffix(title),
        issue.get("description") or "",
        " ".join(issue.get("labels") or []),
    ]
    return " ".join(parts).lower()


def issue_gate(issue):
    match = GATE_RE.search(issue.get("title") or "")
    if not match:
        return None
    return int(match.group(1))


def issue_matches_owner(issue, owner_key, owner_map):
    names = owner_map.get(owner_key.lower()) or owner_map.get(owner_key) or []
    blob = owner_blob(issue)
    for name in names:
        token = (name or "").strip().lower()
        if not token:
            continue
        if re.search(r"(?<![a-z0-9])%s(?![a-z0-9])" % re.escape(token), blob):
            return True
    return False


def resolve_owner_key(who, owner_map):
    token = (who or "").strip().lower()
    if not token:
        return None
    if token in owner_map:
        return token
    for key, names in owner_map.items():
        if key.lower() == token:
            return key
        for name in names:
            if (name or "").strip().lower() == token:
                return key
    return None


def week_bounds(now_ts, tz_name):
    local = local_now(now_ts, tz_name).date()
    monday = local - timedelta(days=local.weekday())
    sunday = monday + timedelta(days=6)
    return monday, sunday, local


def short_title(title, prefix):
    text = strip_owner_suffix(title or "")
    pre = prefix or ""
    if pre and text.lower().startswith(pre.lower()):
        text = text[len(pre) :].lstrip(" :-")
    return text


def format_issue_bit(issue, prefix):
    ident = issue.get("identifier") or "?"
    title = short_title(issue.get("title") or "", prefix)
    due = _short_date(due_date(issue))
    return "%s %s due %s" % (ident, title, due)


def match_issues_by_phrase(issues, phrase, prefix):
    tokens = [t for t in re.findall(r"[a-z0-9]+", (phrase or "").lower()) if t not in ("the", "a", "an", "to", "on")]
    if not tokens:
        return []
    hits = []
    for issue in issues:
        hay = (strip_owner_suffix(issue.get("title") or "") + " " + (issue.get("identifier") or "")).lower()
        if prefix and hay.startswith(prefix.lower()):
            hay = hay[len(prefix) :]
        if all(token in hay for token in tokens):
            hits.append(issue)
    return hits


def make_code(existing):
    for _ in range(50):
        code = random.choice(CODE_LETTERS) + random.choice(CODE_DIGITS)
        if code not in existing:
            return code
    extra = "".join(random.choice(CODE_LETTERS + CODE_DIGITS) for _ in range(3))
    return extra


def expire_proposals(state, now_ts, events_log):
    proposals = list(state.get("linear_proposals") or [])
    changed = False
    for item in proposals:
        if item.get("status") != "pending":
            continue
        if float(item.get("expires_ts") or 0) <= now_ts:
            item["status"] = "expired"
            changed = True
            log_event(
                events_log,
                {
                    "event": "linear_proposal_expired",
                    "code": item.get("code"),
                    "identifier": item.get("identifier"),
                    "issue_id": item.get("issue_id"),
                },
                now_ts=now_ts,
            )
    state["linear_proposals"] = proposals
    return changed


def can_confirm(message, config):
    if config.linear_confirm_from_me and message.is_from_me:
        return True
    return handle_allowed(message.handle, False, config.linear_confirm_handles)


def _reply(config, body):
    cleaned = strip_dollars(body)
    return clamp_reply(cleaned, config.bot_prefix, config.max_reply_chars)


def handle_linear(
    config,
    rest,
    message,
    state,
    now_ts,
    client,
    events_log=None,
    code_factory=None,
):
    intent = parse_intent(rest)
    if intent is None:
        return None
    events_log = events_log or config.events_log
    expire_proposals(state, now_ts, events_log)
    try:
        if intent["type"] == "confirm":
            text, meta = _handle_confirm(config, intent, message, state, now_ts, client, events_log)
        elif intent["type"] == "date_change":
            text, meta = _handle_date_change(
                config, intent, state, now_ts, client, events_log, code_factory
            )
        else:
            text, meta = _handle_query(config, intent, now_ts, client)
    except LinearError as exc:
        return _reply(config, "Linear read failed: %s" % exc), {
            "responder": "linear_error",
            "error": str(exc),
        }
    return _reply(config, text), meta


def _load_issues(config, client):
    return client.list_issues(
        config.linear_team_key,
        config.linear_project_names,
        config.linear_title_prefix,
    )


def _open_issues(issues):
    return [i for i in issues if issue_open(i)]


def _handle_query(config, intent, now_ts, client):
    issues = _open_issues(_load_issues(config, client))
    tz = config.quiet_hours_timezone or "America/Los_Angeles"
    _monday, _sunday, today = week_bounds(now_ts, tz)
    prefix = config.linear_title_prefix
    if intent["type"] == "late":
        late = []
        for issue in issues:
            due = due_date(issue)
            if due is not None and due < today:
                late.append(issue)
        late.sort(key=lambda i: due_date(i) or date.max)
        if not late:
            return "nothing late on Pleasant Hill.", {"responder": "linear", "kind": "late"}
        bits = [format_issue_bit(i, prefix) for i in late[:2]]
        return "late: %s." % "; ".join(bits), {"responder": "linear", "kind": "late"}
    if intent["type"] == "owner_week":
        who = resolve_owner_key(intent.get("who"), config.linear_owner_map)
        if not who:
            return "unknown owner %s." % (intent.get("who") or ""), {
                "responder": "linear",
                "kind": "owner_week",
            }
        monday, sunday, _today = week_bounds(now_ts, tz)
        hits = []
        for issue in issues:
            if not issue_matches_owner(issue, who, config.linear_owner_map):
                continue
            due = due_date(issue)
            if due is None or due < monday or due > sunday:
                continue
            hits.append(issue)
        hits.sort(key=lambda i: due_date(i) or date.max)
        label = who.title()
        if not hits:
            return "%s has no Pleasant Hill due this week." % label, {
                "responder": "linear",
                "kind": "owner_week",
            }
        bits = [format_issue_bit(i, prefix) for i in hits[:2]]
        return "%s this week: %s." % (label, "; ".join(bits)), {
            "responder": "linear",
            "kind": "owner_week",
        }
    if intent["type"] == "next_gate":
        gates = [issue for issue in issues if issue_gate(issue) is not None]
        gates.sort(key=lambda i: (issue_gate(i), due_date(i) or date.max))
        if not gates:
            return "no open Pleasant Hill gates (M1-M4).", {
                "responder": "linear",
                "kind": "next_gate",
            }
        issue = gates[0]
        return "next gate: %s." % format_issue_bit(issue, prefix), {
            "responder": "linear",
            "kind": "next_gate",
            "gate": issue_gate(issue),
            "identifier": issue.get("identifier"),
        }
    # next / overview
    upcoming = []
    for issue in issues:
        due = due_date(issue)
        if due is not None and due >= today:
            upcoming.append(issue)
    upcoming.sort(key=lambda i: due_date(i) or date.max)
    if not upcoming:
        return "no upcoming dated Pleasant Hill issues.", {"responder": "linear", "kind": "next"}
    bits = [format_issue_bit(i, prefix) for i in upcoming[:2]]
    return "next: %s." % "; ".join(bits), {"responder": "linear", "kind": "next"}


def _handle_date_change(config, intent, state, now_ts, client, events_log, code_factory):
    tz = config.quiet_hours_timezone or "America/Los_Angeles"
    today = local_now(now_ts, tz).date()
    new_due = parse_date_token(intent.get("when"), today)
    if not new_due:
        return "couldn't parse that date.", {"responder": "linear", "kind": "date_parse_error"}
    issues = _open_issues(_load_issues(config, client))
    hits = match_issues_by_phrase(issues, intent.get("what"), config.linear_title_prefix)
    if not hits:
        return "no Pleasant Hill issue matched %s." % (intent.get("what") or "that"), {
            "responder": "linear",
            "kind": "date_no_match",
        }
    if len(hits) > 1:
        labels = ", ".join("%s %s" % (i.get("identifier"), short_title(i.get("title"), config.linear_title_prefix)) for i in hits[:3])
        return "which issue? %s." % labels, {"responder": "linear", "kind": "date_ambiguous"}
    issue = hits[0]
    old = due_date(issue)
    old_s = old.isoformat() if old else ""
    new_s = new_due.isoformat()
    existing = {
        p.get("code")
        for p in (state.get("linear_proposals") or [])
        if p.get("status") == "pending"
    }
    factory = code_factory or (lambda: make_code(existing))
    code = factory()
    if code in existing:
        code = make_code(existing)
    proposal = {
        "code": code,
        "issue_id": issue.get("id"),
        "identifier": issue.get("identifier"),
        "title": issue.get("title"),
        "old_due": old_s,
        "new_due": new_s,
        "created_ts": now_ts,
        "expires_ts": now_ts + float(config.linear_proposal_ttl_seconds),
        "status": "pending",
    }
    proposals = list(state.get("linear_proposals") or [])
    proposals.append(proposal)
    state["linear_proposals"] = proposals
    log_event(
        events_log,
        {
            "event": "linear_proposal",
            "code": code,
            "identifier": proposal["identifier"],
            "issue_id": proposal["issue_id"],
            "old_due": old_s,
            "new_due": new_s,
        },
        now_ts=now_ts,
    )
    hours = int(float(config.linear_proposal_ttl_seconds) / 3600) or 1
    return (
        "propose %s due %s -> %s. Confirm: @dev confirm %s (expires %sh)."
        % (proposal["identifier"], _short_date(old), _short_date(new_due), code, hours)
    ), {"responder": "linear", "kind": "proposal", "code": code}


def _handle_confirm(config, intent, message, state, now_ts, client, events_log):
    code = intent["code"]
    proposals = list(state.get("linear_proposals") or [])
    found = None
    for item in proposals:
        if (item.get("code") or "").upper() == code:
            found = item
            break
    if not found:
        return "no proposal %s." % code, {"responder": "linear", "kind": "confirm_unknown"}
    if found.get("status") == "expired":
        log_event(
            events_log,
            {"event": "linear_confirm_expired", "code": code, "identifier": found.get("identifier")},
            now_ts=now_ts,
        )
        return "proposal %s expired." % code, {"responder": "linear", "kind": "confirm_expired"}
    if found.get("status") != "pending":
        return "proposal %s already used." % code, {"responder": "linear", "kind": "confirm_used"}
    if not can_confirm(message, config):
        log_event(
            events_log,
            {
                "event": "linear_confirm_rejected",
                "code": code,
                "sender_handle": message.sender_label(),
                "is_from_me": message.is_from_me,
            },
            now_ts=now_ts,
        )
        return "only Mike or Todd can confirm.", {"responder": "linear", "kind": "confirm_rejected"}
    mutation = {
        "mutation": "issueUpdate",
        "id": found.get("issue_id"),
        "identifier": found.get("identifier"),
        "input": {"dueDate": found.get("new_due")},
    }
    wrote = False
    if config.linear_write_allowed():
        client.update_due_date(found["issue_id"], found["new_due"])
        wrote = True
        found["status"] = "applied"
        log_event(
            events_log,
            {"event": "linear_write", "code": code, "mutation": mutation},
            now_ts=now_ts,
        )
        body = "updated %s due %s -> %s." % (
            found.get("identifier"),
            _short_date(found.get("old_due")),
            _short_date(found.get("new_due")),
        )
    else:
        found["status"] = "logged_not_written"
        reason = []
        if config.dry_run:
            reason.append("dry_run")
        if not config.linear_allow_writes:
            reason.append("allow_writes_false")
        log_event(
            events_log,
            {
                "event": "linear_write_blocked",
                "code": code,
                "reason": ",".join(reason) or "blocked",
                "would_mutate": mutation,
            },
            now_ts=now_ts,
        )
        body = "would update %s due %s -> %s (not written)." % (
            found.get("identifier"),
            _short_date(found.get("old_due")),
            _short_date(found.get("new_due")),
        )
    state["linear_proposals"] = proposals
    log_event(
        events_log,
        {
            "event": "linear_confirm",
            "code": code,
            "identifier": found.get("identifier"),
            "wrote": wrote,
        },
        now_ts=now_ts,
    )
    return body, {"responder": "linear", "kind": "confirm", "wrote": wrote}


def client_from_config(config, http_post=None):
    key = config.linear_api_key()
    if not key:
        return None
    return LinearClient(
        config.linear_graphql_url,
        key,
        timeout=20,
        http_post=http_post,
    )
