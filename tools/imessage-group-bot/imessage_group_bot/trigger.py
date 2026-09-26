"""Normalize handles, detect triggers, allowlist, and in-group kill commands."""

from __future__ import print_function

import re


from .config import DEFAULT_BOT_PREFIX

BOT_EMOJI = "🤖"
SENSITIVE_TERMS = (
    "lease",
    "leases",
    "partner",
    "partners",
    "greene",
    "jv",
    "joint venture",
    "money",
    "rent",
    "cap table",
)


def normalize_handle(value):
    if value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    if "@" in text:
        return text.lower()
    digits = re.sub(r"[^\d+]", "", text)
    if digits.startswith("00"):
        digits = "+" + digits[2:]
    if digits and not digits.startswith("+") and digits.isdigit():
        if len(digits) == 10:
            digits = "+1" + digits
        elif len(digits) == 11 and digits.startswith("1"):
            digits = "+" + digits
        else:
            digits = "+" + digits if digits else digits
    return digits or text.lower()


def handle_allowed(handle, is_from_me, allowlist_handles, owner_handle=None):
    if is_owner_message(handle, is_from_me, owner_handle):
        return True
    wanted = normalize_handle(handle)
    if not wanted:
        return False
    allowed = {normalize_handle(item) for item in allowlist_handles}
    return wanted in allowed


def is_owner_message(handle, is_from_me, owner_handle=None):
    if is_from_me:
        return True
    owner = normalize_handle(owner_handle)
    if not owner:
        return False
    return normalize_handle(handle) == owner


def sender_identity(handle, is_from_me, owner_handle=None):
    """Stable sender key for logs, queues, and cross-chat dedupe."""
    if is_from_me:
        owner = normalize_handle(owner_handle)
        return owner or "me"
    return normalize_handle(handle) or (handle or "")


def is_self_loop_text(text, bot_prefix=None):
    """True if the line looks like a bot send, derived from bot_prefix (must start with 🤖)."""
    if not text:
        return False
    prefix = (bot_prefix or DEFAULT_BOT_PREFIX).strip()
    stripped = text.lstrip()
    if prefix and stripped.startswith(prefix):
        return True
    # Prefix is required to start with 🤖; any 🤖-prefixed line is a self-loop.
    marker = prefix[: len(BOT_EMOJI)] if prefix.startswith(BOT_EMOJI) else BOT_EMOJI
    return stripped.startswith(marker)


# Separators allowed immediately after a trigger token before the question.
_TRIGGER_SEPS = " \t\r\n:,;-"


def _left_boundary_ok(text, index):
    """Reject matches inside emails/handles (jim@dev.com, foo@ops)."""
    if index <= 0:
        return True
    prev = text[index - 1]
    return not (prev.isalnum() or prev in "._")


def _right_boundary_ok(text, end):
    """Standalone token: next char must be whitespace or a separator, not a word char."""
    if end >= len(text):
        return False
    nxt = text[end]
    return nxt.isspace() or nxt in ":,;-"


def leading_trigger_rest(text, trigger_word):
    """Prefix-only rest after a leading trigger (used for stop/start). Empty rest allowed."""
    if not text or not trigger_word:
        return None
    stripped = text.strip()
    trigger = trigger_word.strip()
    if not trigger or not stripped.lower().startswith(trigger.lower()):
        return None
    if not _left_boundary_ok(stripped, 0):
        return None
    rest = stripped[len(trigger) :]
    if rest and not _right_boundary_ok(stripped, len(trigger)):
        return None
    return rest.lstrip(_TRIGGER_SEPS)


def find_trigger(text, trigger_word):
    """Return (start_index, rest) for the earliest standalone trigger with a non-empty question."""
    if not text or not trigger_word:
        return None
    stripped = text.strip()
    trigger = trigger_word.strip()
    if not trigger:
        return None
    hay = stripped.lower()
    needle = trigger.lower()
    start = 0
    while True:
        idx = hay.find(needle, start)
        if idx < 0:
            return None
        end = idx + len(trigger)
        if _left_boundary_ok(stripped, idx) and _right_boundary_ok(stripped, end):
            rest = stripped[end:].lstrip(_TRIGGER_SEPS)
            if rest.strip():
                return idx, rest
        start = idx + 1


def trigger_match(text, trigger_word, bot_prefix=None):
    """Return remaining text after the trigger, or None if not a trigger."""
    if not text or not trigger_word:
        return None
    stripped = text.strip()
    if is_self_loop_text(stripped, bot_prefix=bot_prefix):
        return None
    found = find_trigger(stripped, trigger_word)
    if found is None:
        return None
    return found[1]


def match_desk(text, desks):
    """Return (desk, rest) for the earliest matching trigger, or (None, None)."""
    if not text or not desks:
        return None, None
    stripped = text.strip()
    if is_self_loop_text(stripped):
        return None, None
    best = None
    for desk in desks:
        found = find_trigger(stripped, desk.trigger_word)
        if found is None:
            continue
        start, rest = found
        # Earliest index wins; at the same index, the longer trigger word wins.
        key = (start, -len(desk.trigger_word or ""))
        if best is None or key < best[0]:
            best = (key, desk, rest)
    if best is None:
        return None, None
    return best[1], best[2]


def match_kill_command(text, desks):
    """Return (desk, 'stop'|'start') only when the whole message is that command."""
    if not text or not desks:
        return None, None
    stripped = text.strip()
    if is_self_loop_text(stripped):
        return None, None
    ranked = sorted(desks, key=lambda desk: len(desk.trigger_word or ""), reverse=True)
    for desk in ranked:
        rest = leading_trigger_rest(stripped, desk.trigger_word)
        if rest is None:
            continue
        command = parse_kill_command(rest)
        if command:
            return desk, command
    return None, None


def parse_kill_command(rest):
    if rest is None:
        return None
    token = rest.strip().lower()
    if token == "stop":
        return "stop"
    if token == "start":
        return "start"
    return None


_HEALTH_CHECK_WORD = "test"
_HEALTH_TRAILING_PUNCT = ".!?"


def is_health_check(rest):
    """True when the text after the trigger is only the word 'test'."""
    if rest is None:
        return False
    token = str(rest).strip()
    token = token.rstrip(_HEALTH_TRAILING_PUNCT).strip()
    return token.lower() == _HEALTH_CHECK_WORD


def looks_sensitive(text):
    if not text:
        return False
    lowered = text.lower()
    for term in SENSITIVE_TERMS:
        if re.search(r"(?<![a-z0-9])%s(?![a-z0-9])" % re.escape(term), lowered):
            return True
    return False
