"""AppleScript send into a group chat id, with chat.db delivery confirmation.

Text and chat GUID are passed as osascript argv so emoji (🤖) is never
JSON-escaped into AppleScript source (AppleScript has no \\u escapes).

``send_to_chat`` is only called when both config.dry_run is false and the
process was started with ``--live``.
"""

from __future__ import print_function

import subprocess
import time as time_mod


class SendError(Exception):
    pass


# Static source only — never interpolate message text into -e snippets.
OSASCRIPT_SEND_LINES = (
    "on run argv",
    'tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)',
    "end run",
)


def osascript_send_argv(chat_guid, text):
    """Build the osascript argv list: script via -e, payload after --."""
    args = ["osascript"]
    for line in OSASCRIPT_SEND_LINES:
        args.extend(["-e", line])
    args.extend(["--", text, chat_guid])
    return args


def send_to_chat(chat_guid, text, runner=None):
    argv = osascript_send_argv(chat_guid, text)
    invoke = runner or subprocess.run
    try:
        result = invoke(
            argv,
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
