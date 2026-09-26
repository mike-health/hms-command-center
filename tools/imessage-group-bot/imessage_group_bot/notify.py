"""Notify queued questions via webhook and/or a GitHub PR comment (`gh`)."""

from __future__ import print_function

import json
import os
import secrets
import subprocess
import urllib.error
import urllib.request

from .logs import iso_now


DEFAULT_URL_ENV = "HMS_BOT_WEBHOOK_URL"
DEFAULT_KEY_ENV = "HMS_BOT_WEBHOOK_KEY"
DEFAULT_KEY_HEADER = "Authorization"
DEFAULT_KEY_PREFIX = "Bearer "
DEFAULT_TIMEOUT = 10.0
DEFAULT_ENV_FILE = os.path.join("var", "webhook.env")
DEFAULT_GH_TIMEOUT = 15.0
DEFAULT_GH_CANDIDATES = (
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "gh",
)
DEFAULT_GITHUB_REPO = "mike-health/hms-command-center"
CONTENT_MINIMAL = "minimal"
CONTENT_FULL = "full"
VALID_GITHUB_CONTENT = (CONTENT_MINIMAL, CONTENT_FULL)


def load_key_value_env(path):
    """Parse KEY=VALUE lines. Comments and blank lines ignored."""
    data = {}
    if not path or not os.path.isfile(path):
        return data
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if key:
                data[key] = value
    return data


def lookup_env(name, file_map, environ=None):
    if not name:
        return ""
    env = environ if environ is not None else os.environ
    value = env.get(name)
    if value:
        return str(value)
    return str(file_map.get(name) or "")


def new_ping_id():
    """12 hex characters, unique per queued question."""
    return secrets.token_hex(6)


def build_notify_payload(config, desk, message, question, now_ts=None, ping_id=None):
    source = getattr(message, "chat_guid", None) or config.group_guid
    from .trigger import sender_identity

    return {
        "desk": desk.trigger_word if desk else config.trigger_word,
        "question": question,
        "trigger_text": message.text,
        "reply_to": message.guid,
        "chat_guid": config.group_guid,
        "source_chat_guid": source,
        "sender_handle": sender_identity(
            message.handle, message.is_from_me, config.from_me_handle
        ),
        "ts": iso_now(now_ts),
        "ping_id": ping_id or "",
    }


def sample_payload(config):
    class _Sample(object):
        guid = "notify-test-guid"
        text = "@ops notify-test sample"
        handle = config.from_me_handle or "me"
        is_from_me = True
        chat_guid = config.group_guid

    desk = config.desk_for_trigger("@ops") or config.desks[0]
    return build_notify_payload(config, desk, _Sample(), "notify-test sample")


def post_webhook(config, payload, http_post=None, sleeper=None):
    """POST JSON once, retry once on failure. Returns HTTP status (int).

    Raises Exception if both attempts fail.
    """
    url = config.notify_url()
    if not url:
        raise ValueError("notify webhook URL is empty")
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    key = config.notify_key()
    header_name = config.notify_key_header
    if key and header_name:
        headers[header_name] = "%s%s" % (config.notify_key_prefix, key)
    poster = http_post or _default_http_post
    timeout = float(config.notify_timeout_seconds or DEFAULT_TIMEOUT)
    last_error = None
    for attempt in (1, 2):
        try:
            status = poster(url, body, headers, timeout)
            if status is None:
                status = 200
            status = int(status)
            if status < 400:
                return status
            last_error = RuntimeError("webhook HTTP %s" % status)
        except Exception as exc:
            last_error = exc
        if attempt == 1:
            if sleeper:
                sleeper(0.2)
    raise last_error


def _default_http_post(url, body, headers, timeout):
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return getattr(response, "status", None) or response.getcode()
    except urllib.error.HTTPError as exc:
        return int(exc.code)
    except urllib.error.URLError as exc:
        raise RuntimeError("webhook HTTP error: %s" % exc)


def resolve_gh_path(configured=None):
    """Prefer an explicit path, then Homebrew, then /usr/local, then `gh`."""
    wanted = str(configured or "").strip()
    if wanted and os.path.isabs(wanted):
        return wanted
    for candidate in DEFAULT_GH_CANDIDATES:
        if candidate == "gh":
            continue
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return wanted or "gh"


def format_github_comment(config, payload=None, test=False):
    mode = getattr(config, "notify_github_content", CONTENT_MINIMAL) or CONTENT_MINIMAL
    mode = str(mode).strip().lower()
    if mode != CONTENT_FULL:
        if test:
            return "bot-ping TEST"
        ping = str((payload or {}).get("ping_id") or "").strip()
        return "bot-ping %s" % ping
    payload = payload or {}
    desk = payload.get("desk") or ""
    question = (payload.get("question") or "").replace("\n", " ").strip()
    sender = payload.get("sender_handle") or ""
    if test:
        headline = (
            "TEST — HMS bot notify-test (do not treat as a real queue item). "
            "desk=%s from %s: %s" % (desk, sender, question)
        )
    else:
        headline = "HMS bot queued %s from %s: %s" % (desk, sender, question)
    blob = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    return "%s\n\n```json\n%s\n```\n" % (headline, blob)


def github_comment_argv(config, payload, test=False):
    repo = config.notify_github_repo
    pr = int(config.notify_github_pr)
    path = resolve_gh_path(config.notify_github_gh_path)
    body = format_github_comment(config, payload, test=test)
    return [
        path,
        "api",
        "repos/%s/issues/%s/comments" % (repo, pr),
        "-f",
        "body=%s" % body,
    ]


def post_github_comment(config, payload, gh_run=None, sleeper=None, test=False):
    """Post one issue comment via `gh api ... -f body=`. Retry once on failure."""
    if not config.notify_github_active():
        raise ValueError("notify_github is not configured")
    argv = github_comment_argv(config, payload, test=test)
    timeout = float(config.notify_github_timeout_seconds or DEFAULT_GH_TIMEOUT)
    runner = gh_run or _default_gh_run
    last_error = None
    for attempt in (1, 2):
        try:
            runner(argv, timeout)
            return 0
        except Exception as exc:
            last_error = exc
        if attempt == 1:
            if sleeper:
                sleeper(0.2)
    raise last_error


def _default_gh_run(argv, timeout):
    try:
        result = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("gh comment timed out after %ss" % timeout) from exc
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "").strip()
        raise RuntimeError("gh comment failed (%s): %s" % (result.returncode, err[:500]))
    return result.returncode
