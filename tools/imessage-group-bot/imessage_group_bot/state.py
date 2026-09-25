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


def _key(rowid, guid):
    return "%s:%s" % (rowid, guid or "")
