"""AppleScript send into a group chat id, with chat.db delivery confirmation.

This module is never imported by dry-run send paths in a way that invokes
osascript: ``send_to_chat`` is only called when both config.dry_run is false
and the process was started with ``--live``.
"""

from __future__ import print_function

import json
import subprocess
import time as time_mod


class SendError(Exception):
    pass


def applescript_for_send(chat_guid, text):
    # json.dumps produces a quoted JS/JSON string that is also valid AppleScript.
    return (
        'tell application "Messages"\n'
        "    send %s to chat id %s\n"
        "end tell\n" % (json.dumps(text), json.dumps(chat_guid))
    )


def send_to_chat(chat_guid, text, runner=None):
    script = applescript_for_send(chat_guid, text)
    invoke = runner or subprocess.run
    try:
        result = invoke(
            ["osascript", "-e", script],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise SendError("osascript not found (not macOS?): %s" % exc)
    code = getattr(result, "returncode", 0)
    if code:
        err = (getattr(result, "stderr", None) or getattr(result, "stdout", None) or "").strip()
        raise SendError("osascript failed (%s): %s" % (code, err))
    return result


def confirm_delivery(chat_db, chat_guid, text, after_rowid, timeout_seconds, clock=None, sleeper=None):
    clock = clock or time_mod.time
    sleeper = sleeper or time_mod.sleep
    deadline = clock() + float(timeout_seconds)
    while clock() < deadline:
        found = chat_db.find_from_me_with_text(chat_guid, text, after_rowid)
        if found:
            return found
        remaining = deadline - clock()
        if remaining <= 0:
            break
        sleeper(min(0.5, remaining))
    return None


def send_and_confirm(
    chat_guid,
    text,
    chat_db,
    timeout_seconds,
    send_fn=None,
    clock=None,
    sleeper=None,
):
    """Send, wait for is_from_me row, retry once, then raise SendError."""
    send_fn = send_fn or send_to_chat
    before = chat_db.max_rowid(chat_guid)
    last_error = None
    for attempt in (1, 2):
        try:
            send_fn(chat_guid, text)
        except Exception as exc:
            last_error = exc
            if attempt == 2:
                break
            continue
        found = confirm_delivery(
            chat_db,
            chat_guid,
            text,
            before,
            timeout_seconds,
            clock=clock,
            sleeper=sleeper,
        )
        if found:
            return {"ok": True, "rowid": found, "attempt": attempt}
        last_error = SendError("no is_from_me row with matching text within %ss" % timeout_seconds)
        before = chat_db.max_rowid(chat_guid)
    raise SendError("delivery failed after retry: %s" % last_error)
