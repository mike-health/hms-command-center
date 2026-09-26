"""Parse desk outbox JSONL lines and load queued trigger guids."""

from __future__ import print_function

import json
import os


OUTCOME_SENT = "sent"
OUTCOME_HELD = "held"
OUTCOME_REJECTED = "rejected"

REASON_WRONG_CHAT = "wrong_chat_guid"
REASON_UNKNOWN_REPLY_TO = "unknown_reply_to"
REASON_DUPLICATE = "duplicate"
REASON_INVALID_JSON = "invalid_json"
REASON_MISSING_FIELDS = "missing_fields"
REASON_QUIET_HOURS = "quiet_hours"
REASON_KILL_SWITCH = "kill_switch"
REASON_RATE_CAP = "rate_cap"
REASON_DRY_RUN = "dry_run"
REASON_LIVE_SEND = "live_send"


def load_queue_guids(path):
    """Return message guids queued for a desk (from that desk's queue JSONL)."""
    guids = set()
    if not path or not os.path.exists(path):
        return guids
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not isinstance(row, dict):
                continue
            guid = row.get("guid") or row.get("message_guid")
            if guid:
                guids.add(str(guid))
    return guids


def load_queue_reply_chats(path):
    """message guid -> reply chat guid recorded when the question was queued."""
    out = {}
    for row in iter_queue_rows(path):
        guid = row.get("guid") or row.get("message_guid")
        if not guid:
            continue
        out[str(guid)] = str(row.get("reply_chat_guid") or row.get("chat_guid") or "")
    return out


def parse_outbox_record(line):
    """Return (record, reject_reason). record is a dict on success."""
    text = (line or "").strip()
    if not text:
        return None, None
    try:
        row = json.loads(text)
    except ValueError:
        return None, REASON_INVALID_JSON
    if not isinstance(row, dict):
        return None, REASON_INVALID_JSON
    reply_to = str(row.get("reply_to") or "").strip()
    chat_guid = str(row.get("chat_guid") or "").strip()
    body = row.get("text")
    if not reply_to or not chat_guid or body is None:
        return None, REASON_MISSING_FIELDS
    record = {
        "reply_to": reply_to,
        "chat_guid": chat_guid,
        "text": body if isinstance(body, str) else str(body),
        "ts": str(row.get("ts") or ""),
    }
    return record, None


def iter_outbox_lines(path, offset):
    """Yield (start_offset, end_offset, raw_text) for complete lines after offset.

    Incomplete last lines (no trailing newline) are not yielded so a concurrent
    writer can finish them. If the file shrank, offset is treated as 0.
    """
    if not path or not os.path.exists(path):
        return
    size = os.path.getsize(path)
    start_at = 0 if offset < 0 or offset > size else int(offset)
    with open(path, "rb") as handle:
        handle.seek(start_at)
        while True:
            start = handle.tell()
            raw = handle.readline()
            if not raw:
                break
            if not raw.endswith(b"\n"):
                break
            end = handle.tell()
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("utf-8", errors="replace")
            yield start, end, text


def iter_queue_rows(path):
    """Yield dicts from a desk queue JSONL (skip bad lines)."""
    if not path or not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict):
                yield row


def load_outbox_reply_tos(path):
    """reply_to values present in complete outbox lines (answer already written)."""
    found = set()
    if not path or not os.path.exists(path):
        return found
    for _start, _end, text in iter_outbox_lines(path, 0):
        record, reason = parse_outbox_record(text)
        if record and not reason:
            found.add(record["reply_to"])
    return found


def list_pending(config, state=None):
    """Queued desk entries that do not yet have an outbox answer (or sent mark)."""
    from .state import already_answered, load_state

    if state is None:
        state = load_state(config.state_file)
    rows = []
    for desk in config.desks:
        answered_outbox = load_outbox_reply_tos(desk.outbox_file)
        for row in iter_queue_rows(desk.queue_file):
            guid = row.get("guid") or row.get("message_guid")
            if not guid:
                continue
            guid = str(guid)
            if already_answered(state, guid) or guid in answered_outbox:
                continue
            rows.append(
                {
                    "desk": row.get("desk") or desk.trigger_word,
                    "question": row.get("question") or "",
                    "reply_to": guid,
                    "chat_guid": row.get("reply_chat_guid")
                    or row.get("chat_guid")
                    or config.group_guid,
                    "ping_id": row.get("ping_id") or "",
                    "sender_handle": row.get("sender_handle") or "",
                    "ts": row.get("ts") or row.get("timestamp") or "",
                }
            )
    return rows
