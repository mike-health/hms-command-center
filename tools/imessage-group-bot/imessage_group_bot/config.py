"""Load and validate the single JSON config file (stdlib json only)."""

from __future__ import print_function

import json
import os
from copy import deepcopy


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


def _expand_path(value, base_dir):
    if not value:
        return value
    expanded = os.path.expanduser(os.path.expandvars(str(value)))
    if not os.path.isabs(expanded):
        expanded = os.path.normpath(os.path.join(base_dir, expanded))
    return expanded


class Config(object):
    def __init__(self, raw, base_dir, source_path):
        self.raw = deepcopy(raw)
        self.base_dir = base_dir
        self.source_path = source_path
        self.dry_run = bool(raw.get("dry_run", True))
        self.enabled = bool(raw.get("enabled", True))
        self.chat_db_path = _expand_path(raw["chat_db_path"], base_dir)
        self.group_guid = str(raw["group_guid"]).strip()
        self.trigger_word = str(raw.get("trigger_word") or "@dev").strip() or "@dev"
        self.bot_prefix = str(raw.get("bot_prefix") or "🤖 Dev:").strip() or "🤖 Dev:"
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
        quiet = raw.get("quiet_hours") or {}
        if quiet is None:
            quiet = {}
        if isinstance(quiet, list):
            # Empty list means disabled (pending Mike).
            self.quiet_hours_start = ""
            self.quiet_hours_end = ""
            self.quiet_hours_timezone = "America/Los_Angeles"
        else:
            self.quiet_hours_start = str(quiet.get("start") or "").strip()
            self.quiet_hours_end = str(quiet.get("end") or "").strip()
            self.quiet_hours_timezone = str(
                quiet.get("timezone") or "America/Los_Angeles"
            ).strip()
        self.kill_flag_file = _expand_path(raw["kill_flag_file"], base_dir)
        self.state_file = _expand_path(raw["state_file"], base_dir)
        self.events_log = _expand_path(raw["events_log"], base_dir)
        self.alerts_log = _expand_path(raw["alerts_log"], base_dir)
        self.queue_file = _expand_path(raw["queue_file"], base_dir)
        hook = raw.get("alert_hook_command") or ""
        self.alert_hook_command = hook if hook else ""
        responder = raw.get("responder") or {}
        self.responder_type = str(responder.get("type") or "stub").strip().lower()
        self.responder_api_key_env = str(responder.get("api_key_env") or "IMESSAGE_BOT_API_KEY")
        self.responder_base_url = str(responder.get("base_url") or "").rstrip("/")
        self.responder_model = str(responder.get("model") or "gpt-4o-mini")
        self.responder_timeout_seconds = float(responder.get("timeout_seconds") or 20)

    def live_send_allowed(self, live_flag):
        """Real send requires dry_run false AND --live. Default is always dry-run."""
        return (not self.dry_run) and bool(live_flag)

    def quiet_hours_enabled(self):
        return bool(self.quiet_hours_start and self.quiet_hours_end)
