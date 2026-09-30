"""JSONL event, alert, and desk-queue writers."""

from __future__ import print_function

import json
import os
import shlex
import subprocess
from datetime import datetime, timezone


def append_jsonl(path, record):
    if not path:
        return
    directory = os.path.dirname(path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory)
    line = json.dumps(record, ensure_ascii=False, sort_keys=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(line)
        handle.write("\n")


def iso_now(now_ts=None):
    if now_ts is None:
        dt = datetime.now(timezone.utc)
    else:
        dt = datetime.fromtimestamp(now_ts, tz=timezone.utc)
    return dt.isoformat()


def log_event(path, record, now_ts=None):
    payload = dict(record)
    payload.setdefault("ts", iso_now(now_ts))
    append_jsonl(path, payload)
    return payload


def raise_alert(alerts_path, message, hook_command, extra=None, now_ts=None, runner=None):
    record = {
        "ts": iso_now(now_ts),
        "level": "alert",
        "message": message,
    }
    if extra:
        record.update(extra)
    append_jsonl(alerts_path, record)
    if hook_command:
        run_hook(hook_command, record, runner=runner)
    return record


def run_hook(command, record, runner=None):
    """Run an optional local hook. Never used to send iMessage."""
    if not command:
        return
    if isinstance(command, (list, tuple)):
        args = list(command)
    else:
        args = shlex.split(str(command))
    env = os.environ.copy()
    env["IMESSAGE_BOT_ALERT"] = json.dumps(record)
    invoke = runner or subprocess.run
    invoke(args, env=env, check=False)
