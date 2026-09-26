"""Load and validate the single JSON config file (stdlib json only)."""

from __future__ import print_function

import json
import os
from copy import deepcopy


DEFAULT_TRIGGER_WORD = "@dev"
DEFAULT_BOT_PREFIX = "🤖 Dev:"
DEFAULT_QUIET_HOURS_START = "21:00"
DEFAULT_QUIET_HOURS_END = "06:00"
DEFAULT_QUIET_HOURS_TIMEZONE = "America/Los_Angeles"
DEFAULT_DEV_OUTBOX = os.path.join("var", "outbox-dev.jsonl")
DEFAULT_OPS_TRIGGER_WORD = "@ops"
DEFAULT_OPS_PREFIX = "🤖 Ops:"
DEFAULT_OPS_QUEUE = os.path.join("var", "desk-queue-ops.jsonl")
DEFAULT_OPS_OUTBOX = os.path.join("var", "outbox-ops.jsonl")
REPLY_MODE_STUB = "stub"
REPLY_MODE_OUTBOX = "outbox"
VALID_REPLY_MODES = (REPLY_MODE_STUB, REPLY_MODE_OUTBOX)

REQUIRED_KEYS = (
    "dry_run",
    "enabled",
    "chat_db_path",
    "group_guid",
    "trigger_word",
    "allowlist_handles",
    "poll_interval_seconds",
    "kill_flag_file",
    "state_file",
    "events_log",
    "alerts_log",
    "queue_file",
)


def load_config(path):
    with open(path, "r", encoding="utf-8") as handle:
        raw = json.load(handle)
    if not isinstance(raw, dict):
        raise ValueError("config must be a JSON object")
    missing = [key for key in REQUIRED_KEYS if key not in raw]
    if missing:
        raise ValueError("config missing keys: %s" % ", ".join(missing))
    base_dir = os.path.dirname(os.path.abspath(path))
    return Config(raw, base_dir=base_dir, source_path=os.path.abspath(path))


class ConfigError(ValueError):
    pass


class Desk(object):
    """One trigger/prefix/queue/outbox/reply-mode tuple."""

    def __init__(self, trigger_word, bot_prefix, queue_file, outbox_file, reply_mode):
        self.trigger_word = trigger_word
        self.bot_prefix = bot_prefix
        self.queue_file = queue_file
        self.outbox_file = outbox_file
        self.reply_mode = reply_mode

    @property
    def name(self):
        word = (self.trigger_word or "").lstrip("@").strip().lower()
        return word or "desk"

    def uses_outbox(self):
        return self.reply_mode == REPLY_MODE_OUTBOX


def _strict_bool(raw, key, missing_default, non_bool_value):
    """Only JSON true/false count as bools. Any other value is non_bool_value."""
    if key not in raw:
        return missing_default
    value = raw[key]
    if isinstance(value, bool):
        return value
    return non_bool_value


def _require_timezone(name):
    from .guardrails import resolve_timezone

    try:
        resolve_timezone(name)
    except Exception as exc:
        raise ConfigError("invalid quiet_hours.timezone %r: %s" % (name, exc))


def _require_bot_prefix(prefix):
    text = (prefix or "").strip()
    if not text.startswith("🤖"):
        raise ConfigError("bot_prefix must start with 🤖, got %r" % prefix)
    return text


def _hhmm_field(quiet, key, default):
    """Missing key → decided default. Explicit empty string disables that bound."""
    if key not in quiet:
        return default
    return str(quiet.get(key) or "").strip()


def _expand_path(value, base_dir):
    if not value:
        return value
    expanded = os.path.expanduser(os.path.expandvars(str(value)))
    if not os.path.isabs(expanded):
        expanded = os.path.normpath(os.path.join(base_dir, expanded))
    return expanded


def _normalize_reply_mode(value, default):
    mode = str(value or default).strip().lower() or default
    if mode not in VALID_REPLY_MODES:
        raise ConfigError("reply_mode must be stub or outbox, got %r" % value)
    return mode


def _desk_from_mapping(item, base_dir, fallback):
    if not isinstance(item, dict):
        raise ConfigError("each desks[] entry must be a JSON object")
    trigger = str(item.get("trigger_word") or fallback.trigger_word).strip() or fallback.trigger_word
    prefix = _require_bot_prefix(
        str(item.get("bot_prefix") or item.get("prefix") or fallback.bot_prefix).strip()
        or fallback.bot_prefix
    )
    queue = _expand_path(item.get("queue_file") or fallback.queue_file, base_dir)
    outbox = _expand_path(item.get("outbox_file") or fallback.outbox_file, base_dir)
    default_mode = (
        REPLY_MODE_OUTBOX
        if trigger.lower() == DEFAULT_OPS_TRIGGER_WORD
        else fallback.reply_mode
    )
    mode = _normalize_reply_mode(item.get("reply_mode"), default_mode)
    return Desk(trigger, prefix, queue, outbox, mode)


class Config(object):
    def __init__(self, raw, base_dir, source_path):
        self.raw = deepcopy(raw)
        self.base_dir = base_dir
        self.source_path = source_path
        # Non-bool values (null, 0, "", strings) → dry_run true, enabled false.
        self.dry_run = _strict_bool(raw, "dry_run", True, True)
        self.enabled = _strict_bool(raw, "enabled", True, False)
        self.chat_db_path = _expand_path(raw["chat_db_path"], base_dir)
        self.group_guid = str(raw["group_guid"]).strip()
        watch = raw.get("watch_chat_guids")
        if watch is None:
            watch = []
        if not isinstance(watch, list):
            raise ValueError("watch_chat_guids must be a list")
        self.watch_chat_guids = [str(item).strip() for item in watch if str(item).strip()]
        self.from_me_handle = str(raw.get("from_me_handle") or "").strip()
        self.watched_chat_guids = _unique_guids(
            [self.group_guid] + self.watch_chat_guids
        )
        self.trigger_word = (
            str(raw.get("trigger_word") or DEFAULT_TRIGGER_WORD).strip() or DEFAULT_TRIGGER_WORD
        )
        self.bot_prefix = _require_bot_prefix(
            str(raw.get("bot_prefix") or DEFAULT_BOT_PREFIX).strip() or DEFAULT_BOT_PREFIX
        )
        self.max_reply_chars = int(raw.get("max_reply_chars") or 200)
        handles = raw.get("allowlist_handles") or []
        if not isinstance(handles, list):
            raise ValueError("allowlist_handles must be a list")
        self.allowlist_handles = [str(item).strip() for item in handles if str(item).strip()]
        self.poll_interval_seconds = float(raw.get("poll_interval_seconds") or 10)
        self.delivery_confirm_seconds = float(raw.get("delivery_confirm_seconds") or 15)
        rate = raw.get("rate_caps") or {}
        self.min_seconds_between_replies = float(rate.get("min_seconds_between_replies") or 20)
        self.max_replies_per_hour = int(rate.get("max_replies_per_hour") or 10)
        self.max_replies_per_day = int(rate.get("max_replies_per_day") or 40)
        quiet = raw.get("quiet_hours")
        if quiet is None or isinstance(quiet, list):
            quiet = {}
        if not isinstance(quiet, dict):
            quiet = {}
        self.quiet_hours_start = _hhmm_field(
            quiet, "start", DEFAULT_QUIET_HOURS_START
        )
        self.quiet_hours_end = _hhmm_field(quiet, "end", DEFAULT_QUIET_HOURS_END)
        tz = quiet.get("timezone", DEFAULT_QUIET_HOURS_TIMEZONE)
        self.quiet_hours_timezone = (
            str(tz or DEFAULT_QUIET_HOURS_TIMEZONE).strip() or DEFAULT_QUIET_HOURS_TIMEZONE
        )
        _require_timezone(self.quiet_hours_timezone)
        self.kill_flag_file = _expand_path(raw["kill_flag_file"], base_dir)
        self.state_file = _expand_path(raw["state_file"], base_dir)
        self.events_log = _expand_path(raw["events_log"], base_dir)
        self.alerts_log = _expand_path(raw["alerts_log"], base_dir)
        self.queue_file = _expand_path(raw["queue_file"], base_dir)
        self.outbox_file = _expand_path(
            raw.get("outbox_file") or DEFAULT_DEV_OUTBOX, base_dir
        )
        hook = raw.get("alert_hook_command") or ""
        self.alert_hook_command = hook if hook else ""
        responder = raw.get("responder") or {}
        self.responder_type = str(responder.get("type") or "stub").strip().lower()
        self.responder_api_key_env = str(responder.get("api_key_env") or "IMESSAGE_BOT_API_KEY")
        self.responder_base_url = str(responder.get("base_url") or "").rstrip("/")
        self.responder_model = str(responder.get("model") or "gpt-4o-mini")
        self.responder_timeout_seconds = float(responder.get("timeout_seconds") or 20)
        self.ack_on_queue = _strict_bool(raw, "ack_on_queue", True, True)
        self._load_notify_webhook(raw, base_dir)
        self._load_notify_github(raw)
        self.desks = self._load_desks(raw, base_dir)

    def _load_notify_webhook(self, raw, base_dir):
        from .notify import (
            DEFAULT_ENV_FILE,
            DEFAULT_KEY_ENV,
            DEFAULT_KEY_HEADER,
            DEFAULT_KEY_PREFIX,
            DEFAULT_TIMEOUT,
            DEFAULT_URL_ENV,
            load_key_value_env,
            lookup_env,
        )

        self.notify_url_env = DEFAULT_URL_ENV
        self.notify_key_env = DEFAULT_KEY_ENV
        self.notify_key_header = DEFAULT_KEY_HEADER
        self.notify_key_prefix = DEFAULT_KEY_PREFIX
        self.notify_timeout_seconds = DEFAULT_TIMEOUT
        self.webhook_env_file = _expand_path(DEFAULT_ENV_FILE, base_dir)
        self._notify_block = None
        block = raw.get("notify_webhook")
        if not block:
            self._file_env = {}
            return
        if not isinstance(block, dict):
            raise ConfigError("notify_webhook must be a JSON object")
        self._notify_block = block
        self.notify_url_env = str(block.get("url_env") or DEFAULT_URL_ENV).strip() or DEFAULT_URL_ENV
        self.notify_key_env = str(block.get("key_env") or DEFAULT_KEY_ENV).strip() or DEFAULT_KEY_ENV
        self.notify_key_header = str(
            block.get("key_header") if "key_header" in block else DEFAULT_KEY_HEADER
        )
        self.notify_key_prefix = str(
            block.get("key_prefix") if "key_prefix" in block else DEFAULT_KEY_PREFIX
        )
        self.notify_timeout_seconds = float(block.get("timeout_seconds") or DEFAULT_TIMEOUT)
        env_file = block.get("env_file") or DEFAULT_ENV_FILE
        self.webhook_env_file = _expand_path(env_file, base_dir)
        self._file_env = load_key_value_env(self.webhook_env_file)

    def _load_notify_github(self, raw):
        from .notify import DEFAULT_GH_TIMEOUT, DEFAULT_GITHUB_REPO

        self._github_block = None
        self.notify_github_repo = ""
        self.notify_github_pr = 0
        self.notify_github_gh_path = "gh"
        self.notify_github_timeout_seconds = DEFAULT_GH_TIMEOUT
        block = raw.get("notify_github")
        if not block:
            return
        if not isinstance(block, dict):
            raise ConfigError("notify_github must be a JSON object")
        self._github_block = block
        self.notify_github_repo = str(
            block.get("repo") or DEFAULT_GITHUB_REPO
        ).strip() or DEFAULT_GITHUB_REPO
        try:
            self.notify_github_pr = int(block.get("pr") or 0)
        except (TypeError, ValueError):
            raise ConfigError("notify_github.pr must be an integer")
        path = block.get("gh_path")
        if path is None or str(path).strip() == "":
            self.notify_github_gh_path = "gh"
        else:
            self.notify_github_gh_path = str(path).strip()
        self.notify_github_timeout_seconds = float(
            block.get("timeout_seconds") or DEFAULT_GH_TIMEOUT
        )

    def notify_url(self, environ=None):
        if self._notify_block is None:
            return ""
        from .notify import lookup_env

        return lookup_env(self.notify_url_env, self._file_env, environ=environ).strip()

    def notify_key(self, environ=None):
        if self._notify_block is None:
            return ""
        from .notify import lookup_env

        return lookup_env(self.notify_key_env, self._file_env, environ=environ)

    def notify_github_active(self):
        return bool(self._github_block and self.notify_github_repo and self.notify_github_pr)

    def notify_active(self, environ=None):
        return bool(self.notify_url(environ=environ) or self.notify_github_active())

    def _load_desks(self, raw, base_dir):
        legacy = Desk(
            self.trigger_word,
            self.bot_prefix,
            self.queue_file,
            self.outbox_file,
            REPLY_MODE_STUB,
        )
        configured = raw.get("desks")
        if configured is None:
            desks = [legacy]
            if not _desk_has_trigger(desks, DEFAULT_OPS_TRIGGER_WORD):
                desks.append(
                    Desk(
                        DEFAULT_OPS_TRIGGER_WORD,
                        _require_bot_prefix(DEFAULT_OPS_PREFIX),
                        _expand_path(DEFAULT_OPS_QUEUE, base_dir),
                        _expand_path(DEFAULT_OPS_OUTBOX, base_dir),
                        REPLY_MODE_OUTBOX,
                    )
                )
            self._check_desk_triggers(desks)
            return desks
        if not isinstance(configured, list) or not configured:
            raise ConfigError("desks must be a non-empty list")
        desks = [_desk_from_mapping(item, base_dir, legacy) for item in configured]
        self._check_desk_triggers(desks)
        return desks

    def _check_desk_triggers(self, desks):
        seen = {}
        for desk in desks:
            key = desk.trigger_word.strip().lower()
            if key in seen:
                raise ConfigError("duplicate desk trigger_word %r" % desk.trigger_word)
            seen[key] = desk

    def desk_for_trigger(self, trigger_word):
        wanted = (trigger_word or "").strip().lower()
        for desk in self.desks:
            if desk.trigger_word.strip().lower() == wanted:
                return desk
        return None

    def is_watched_chat(self, chat_guid):
        return bool(chat_guid) and chat_guid in self.watched_chat_guids

    def live_send_allowed(self, live_flag):
        """Real send requires dry_run false AND --live. Default is always dry-run."""
        return (not self.dry_run) and bool(live_flag)

    def quiet_hours_enabled(self):
        return bool(self.quiet_hours_start and self.quiet_hours_end)


def _unique_guids(values):
    seen = set()
    out = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _desk_has_trigger(desks, trigger_word):
    wanted = trigger_word.strip().lower()
    for desk in desks:
        if desk.trigger_word.strip().lower() == wanted:
            return True
    return False
