"""Normalize handles, detect triggers, allowlist, and in-group kill commands."""

from __future__ import print_function

import re


BOT_PREFIX_START = "🤖"
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


def handle_allowed(handle, is_from_me, allowlist_handles):
    if is_from_me:
        return True
    wanted = normalize_handle(handle)
    if not wanted:
        return False
    allowed = {normalize_handle(item) for item in allowlist_handles}
    return wanted in allowed


def is_self_loop_text(text):
    if not text:
        return False
    stripped = text.lstrip()
    return stripped.startswith(BOT_PREFIX_START)


def trigger_match(text, trigger_word):
    """Return remaining text after the trigger, or None if not a trigger."""
    if not text or not trigger_word:
        return None
    stripped = text.strip()
    if is_self_loop_text(stripped):
        return None
    trigger = trigger_word.strip()
    if not stripped.lower().startswith(trigger.lower()):
        return None
    rest = stripped[len(trigger) :]
    if rest and rest[0] not in " \t:,;-":
        # Require a boundary so '@devastated' is not a hit for '@dev'.
        return None
    return rest.lstrip(" \t:,;-")


def parse_kill_command(rest):
    if rest is None:
        return None
    token = rest.strip().lower()
    if token == "stop":
        return "stop"
    if token == "start":
        return "start"
    return None


def looks_sensitive(text):
    if not text:
        return False
    lowered = text.lower()
    for term in SENSITIVE_TERMS:
        if re.search(r"(?<![a-z0-9])%s(?![a-z0-9])" % re.escape(term), lowered):
            return True
    return False
