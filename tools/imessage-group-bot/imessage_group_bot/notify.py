"""POST queued questions to an answering-service webhook (stdlib urllib)."""

from __future__ import print_function

import json
import os
import urllib.error
import urllib.request

from .logs import iso_now


DEFAULT_URL_ENV = "HMS_BOT_WEBHOOK_URL"
DEFAULT_KEY_ENV = "HMS_BOT_WEBHOOK_KEY"
DEFAULT_KEY_HEADER = "Authorization"
DEFAULT_KEY_PREFIX = "Bearer "
DEFAULT_TIMEOUT = 10.0
DEFAULT_ENV_FILE = os.path.join("var", "webhook.env")


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


def build_notify_payload(config, desk, message, question, now_ts=None):
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
