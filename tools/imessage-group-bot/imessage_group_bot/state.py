"""Persisted high-water mark, processed ids, rate-cap timestamps, runtime pause."""

from __future__ import print_function

import json
import os
import tempfile


DEFAULT_STATE = {
    "high_water_rowid": None,
    "processed": [],
    "send_times": [],
    "runtime_paused": False,
    "stop_ack_sent": False,
    "outbox_offsets": {},
    "answered_reply_tos": [],
}


def load_state(path):
    if not path or not os.path.exists(path):
        return dict(DEFAULT_STATE)
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    state = dict(DEFAULT_STATE)
    if isinstance(data, dict):
        state.update(data)
    if state["processed"] is None:
        state["processed"] = []
    if state["send_times"] is None:
        state["send_times"] = []
    if not isinstance(state.get("outbox_offsets"), dict):
        state["outbox_offsets"] = {}
    if state.get("answered_reply_tos") is None:
        state["answered_reply_tos"] = []
    return state


def save_state(path, state):
    directory = os.path.dirname(path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory)
    payload = json.dumps(state, indent=2, sort_keys=True)
    fd, tmp = tempfile.mkstemp(prefix="state.", suffix=".json", dir=directory or None)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def already_processed(state, rowid, guid):
    processed = state.get("processed") or []
    key = _key(rowid, guid)
    return key in processed or str(rowid) in processed


def mark_processed(state, rowid, guid, keep=400):
    processed = list(state.get("processed") or [])
    key = _key(rowid, guid)
    if key not in processed:
        processed.append(key)
    state["processed"] = processed[-keep:]
    current = state.get("high_water_rowid")
    if current is None or int(rowid) > int(current):
        state["high_water_rowid"] = int(rowid)


def already_answered(state, reply_to):
    if not reply_to:
        return False
    answered = state.get("answered_reply_tos") or []
    return str(reply_to) in answered


def mark_answered(state, reply_to, keep=2000):
    if not reply_to:
        return
    answered = list(state.get("answered_reply_tos") or [])
    key = str(reply_to)
    if key not in answered:
        answered.append(key)
    state["answered_reply_tos"] = answered[-keep:]


def outbox_offset(state, path):
    offsets = state.get("outbox_offsets") or {}
    try:
        return int(offsets.get(path, 0) or 0)
    except (TypeError, ValueError):
        return 0


def set_outbox_offset(state, path, offset):
    offsets = dict(state.get("outbox_offsets") or {})
    offsets[path] = int(offset)
    state["outbox_offsets"] = offsets


def _key(rowid, guid):
    return "%s:%s" % (rowid, guid or "")
