"""Pluggable one-line responders (stub + OpenAI-compatible HTTP)."""

from __future__ import print_function

import json
import os
import urllib.error
import urllib.request

from .guardrails import clamp_reply
from .trigger import looks_sensitive

STUB_LEAD = "got it, routing to the dev desk:"
STUB_BARE = "got it, standing by at the dev desk"
SENSITIVE_REPLY_BODY = "Mike will answer that"
EXPLICIT_OPENAI_TYPE = "openai_compatible"


class ResponderError(Exception):
    pass


def build_stub_reply(question, prefix, max_chars):
    q = " ".join((question or "").split())
    if not q:
        body = STUB_BARE
    else:
        body = "%s %s" % (STUB_LEAD, q)
    return clamp_reply(body, prefix, max_chars)


def sensitive_reply(prefix, max_chars):
    return clamp_reply(SENSITIVE_REPLY_BODY, prefix, max_chars)


def generate_reply(config, question, http_post=None, prefix=None):
    """Return (text, meta) where meta notes which responder produced it."""
    prefix = prefix if prefix is not None else config.bot_prefix
    max_chars = config.max_reply_chars
    if looks_sensitive(question):
        return sensitive_reply(prefix, max_chars), {"responder": "sensitive_guard"}

    kind = (config.responder_type or "stub").strip().lower()
    if kind == EXPLICIT_OPENAI_TYPE:
        try:
            text = _openai_compatible(config, question, http_post=http_post)
            return clamp_reply(text, prefix, max_chars), {"responder": "openai_compatible"}
        except Exception as exc:
            fallback = build_stub_reply(question, prefix, max_chars)
            return fallback, {
                "responder": "stub_fallback",
                "openai_error": str(exc),
            }

    meta = {"responder": "stub"}
    if kind not in ("stub", "", "default"):
        meta["unknown_type"] = kind
    return build_stub_reply(question, prefix, max_chars), meta


def _openai_compatible(config, question, http_post=None):
    key_env = config.responder_api_key_env
    api_key = os.environ.get(key_env, "")
    if not api_key:
        raise ResponderError("missing env var %s" % key_env)
    if not config.responder_base_url:
        raise ResponderError("responder.base_url is empty")
    url = config.responder_base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": config.responder_model,
        "temperature": 0.2,
        "max_tokens": 120,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are the Todd Dev Manager desk bot in a private iMessage group. "
                    "Reply in ONE line, no markdown, no newlines, at most 180 characters "
                    "of body. Do not discuss money, leases, partners, Greene, or the JV; "
                    "if asked, say Mike will answer that. Prefix is added later."
                ),
            },
            {"role": "user", "content": question or ""},
        ],
    }
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer %s" % api_key,
    }
    poster = http_post or _default_http_post
    raw = poster(url, body, headers, config.responder_timeout_seconds)
    try:
        data = json.loads(raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
    except Exception as exc:
        raise ResponderError("invalid JSON from model: %s" % exc)
    try:
        content = data["choices"][0]["message"]["content"]
    except Exception:
        raise ResponderError("model response missing choices[0].message.content")
    if not content or not str(content).strip():
        raise ResponderError("empty model content")
    return str(content)


def _default_http_post(url, body, headers, timeout):
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except urllib.error.URLError as exc:
        raise ResponderError("HTTP error: %s" % exc)
