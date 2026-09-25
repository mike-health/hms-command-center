"""One-pass and polling engine. Dry-run never calls the AppleScript sender."""

from __future__ import print_function

import os
import time as time_mod

from .chat_db import ChatDB
from .guardrails import (
    clamp_reply,
    in_quiet_hours,
    kill_flag_present,
    rate_cap_decision,
    set_kill_flag,
)
from .logs import log_event, raise_alert
from .responder import generate_reply
from .sender import send_and_confirm
from .state import already_processed, load_state, mark_processed, save_state
from .trigger import handle_allowed, is_self_loop_text, parse_kill_command, trigger_match


SKIP_REACTION = "reaction_or_associated"
SKIP_EDIT = "edit"
SKIP_UNSEND_OR_EMPTY = "empty_or_attachment_only"
SKIP_SELF_LOOP = "self_loop_emoji_prefix"
SKIP_NOT_TRIGGER = "not_trigger"
SKIP_ALLOWLIST = "not_allowlisted"
SKIP_BACKLOG = "backlog_before_start"
SKIP_IDEMPOTENT = "already_processed"
SKIP_QUIET_HOURS = "suppressed: quiet_hours"


class Engine(object):
    def __init__(
        self,
        config,
        live_flag=False,
        chat_db=None,
        send_fn=None,
        clock=None,
        sleeper=None,
        http_post=None,
        hook_runner=None,
    ):
        self.config = config
        self.live_flag = bool(live_flag)
        self.chat_db = chat_db or ChatDB(config.chat_db_path)
        self.send_fn = send_fn
        self.clock = clock or time_mod.time
        self.sleeper = sleeper or time_mod.sleep
        self.http_post = http_post
        self.hook_runner = hook_runner

    def live_send_allowed(self):
        return self.config.live_send_allowed(self.live_flag)

    def process_once(self):
        state = load_state(self.config.state_file)
        seeded = False
        if state.get("high_water_rowid") is None:
            # Ignore backlog from before this process first started.
            state["high_water_rowid"] = self.chat_db.max_rowid(self.config.group_guid)
            seeded = True
            save_state(self.config.state_file, state)
            log_event(
                self.config.events_log,
                {
                    "event": "high_water_seeded",
                    "chat_guid": self.config.group_guid,
                    "high_water_rowid": state["high_water_rowid"],
                    "decisions": ["backlog_ignored_on_first_start"],
                },
                now_ts=self.clock(),
            )
            return {"seeded": True, "processed": 0, "replies": 0}

        messages = self.chat_db.fetch_new_messages(
            self.config.group_guid, int(state["high_water_rowid"])
        )
        replies = 0
        for message in messages:
            acted = self._handle_message(state, message)
            if acted:
                replies += 1
            mark_processed(state, message.rowid, message.guid)
            save_state(self.config.state_file, state)
        return {
            "seeded": seeded,
            "processed": len(messages),
            "replies": replies,
            "high_water_rowid": state.get("high_water_rowid"),
        }

    def run_forever(self):
        interval = max(1.0, float(self.config.poll_interval_seconds))
        while True:
            try:
                self.process_once()
            except Exception as exc:
                raise_alert(
                    self.config.alerts_log,
                    "poll loop error: %s" % exc,
                    self.config.alert_hook_command,
                    extra={"event": "loop_error"},
                    now_ts=self.clock(),
                    runner=self.hook_runner,
                )
            self.sleeper(interval)

    def _handle_message(self, state, message):
        now = self.clock()
        decisions = []
        skip = self._skip_reason(message)
        if skip:
            log_event(
                self.config.events_log,
                self._base_event(message, decisions + [skip], would_send=None, trigger_text=message.text),
                now_ts=now,
            )
            return False

        rest = trigger_match(message.text, self.config.trigger_word)
        if rest is None:
            log_event(
                self.config.events_log,
                self._base_event(
                    message,
                    decisions + [SKIP_NOT_TRIGGER],
                    would_send=None,
                    trigger_text=message.text,
                ),
                now_ts=now,
            )
            return False

        allowed = handle_allowed(
            message.handle, message.is_from_me, self.config.allowlist_handles
        )
        if not allowed:
            log_event(
                self.config.events_log,
                self._base_event(
                    message,
                    decisions + [SKIP_ALLOWLIST],
                    would_send=None,
                    trigger_text=message.text,
                ),
                now_ts=now,
            )
            return False

        if already_processed(state, message.rowid, message.guid):
            log_event(
                self.config.events_log,
                self._base_event(
                    message,
                    decisions + [SKIP_IDEMPOTENT],
                    would_send=None,
                    trigger_text=message.text,
                ),
                now_ts=now,
            )
            return False

        decisions.append("allowlisted")
        decisions.append("trigger_matched")

        if self.config.quiet_hours_enabled() and in_quiet_hours(
            now,
            self.config.quiet_hours_start,
            self.config.quiet_hours_end,
            self.config.quiet_hours_timezone,
        ):
            # Dry-run and live: log only. Do not queue for later and do not send.
            decisions.append(SKIP_QUIET_HOURS)
            log_event(
                self.config.events_log,
                self._base_event(
                    message,
                    decisions,
                    would_send=None,
                    trigger_text=message.text,
                ),
                now_ts=now,
            )
            return False

        self._enqueue(message, rest, now)

        command = parse_kill_command(rest)
        if command == "stop" and message.is_from_me:
            return self._command_stop(state, message, rest, decisions, now)
        if command == "start" and message.is_from_me:
            return self._command_start(state, message, rest, decisions, now)

        reply, meta = generate_reply(self.config, rest, http_post=self.http_post)
        if meta.get("openai_error"):
            decisions.append("openai_fallback_stub")
        decisions.append("responder:%s" % meta.get("responder"))
        return self._maybe_send(state, message, rest, reply, decisions, now)

    def _skip_reason(self, message):
        if int(message.associated_message_type or 0) != 0:
            return SKIP_REACTION
        if int(message.item_type or 0) != 0:
            return SKIP_REACTION
        if message.date_edited not in (None, 0, "0"):
            return SKIP_EDIT
        text = (message.text or "").strip()
        if not text:
            return SKIP_UNSEND_OR_EMPTY
        if is_self_loop_text(text):
            return SKIP_SELF_LOOP
        return None

    def _kill_reasons(self, state):
        reasons = []
        if not self.config.enabled:
            reasons.append("config_enabled_false")
        if kill_flag_present(self.config.kill_flag_file):
            reasons.append("kill_flag_file")
        if state.get("runtime_paused"):
            reasons.append("runtime_paused")
        return reasons

    def _command_stop(self, state, message, rest, decisions, now):
        already = bool(state.get("runtime_paused")) and kill_flag_present(self.config.kill_flag_file)
        state["runtime_paused"] = True
        set_kill_flag(self.config.kill_flag_file, True)
        decisions.append("kill_command_stop")
        if already and state.get("stop_ack_sent"):
            decisions.append("stop_ack_already_sent")
            log_event(
                self.config.events_log,
                self._base_event(message, decisions, would_send=None, trigger_text=message.text),
                now_ts=now,
            )
            return False
        reply = clamp_reply("paused", self.config.bot_prefix, self.config.max_reply_chars)
        state["stop_ack_sent"] = True
        return self._maybe_send(
            state, message, rest, reply, decisions, now, bypass_kill=True, bypass_rate=True
        )

    def _command_start(self, state, message, rest, decisions, now):
        state["runtime_paused"] = False
        state["stop_ack_sent"] = False
        set_kill_flag(self.config.kill_flag_file, False)
        decisions.append("kill_command_start")
        if not self.config.enabled:
            reply = clamp_reply(
                "config enabled is false; flag cleared",
                self.config.bot_prefix,
                self.config.max_reply_chars,
            )
        else:
            reply = clamp_reply("running", self.config.bot_prefix, self.config.max_reply_chars)
        return self._maybe_send(
            state, message, rest, reply, decisions, now, bypass_kill=True, bypass_rate=True
        )

    def _maybe_send(
        self,
        state,
        message,
        rest,
        reply,
        decisions,
        now,
        bypass_kill=False,
        bypass_rate=False,
    ):
        if not bypass_kill:
            kills = self._kill_reasons(state)
            if kills:
                decisions.extend(kills)
                decisions.append("send_blocked_kill_switch")
                log_event(
                    self.config.events_log,
                    self._base_event(message, decisions, would_send=reply, trigger_text=message.text),
                    now_ts=now,
                )
                return False

        cap, times = rate_cap_decision(
            state.get("send_times") or [],
            now,
            self.config.min_seconds_between_replies,
            self.config.max_replies_per_hour,
            self.config.max_replies_per_day,
        )
        state["send_times"] = times
        if cap and not bypass_rate:
            decisions.append("rate_cap:%s" % cap)
            decisions.append("send_blocked_rate_cap")
            log_event(
                self.config.events_log,
                self._base_event(message, decisions, would_send=reply, trigger_text=message.text),
                now_ts=now,
            )
            return False

        live = self.live_send_allowed()
        if not live:
            if self.config.dry_run:
                decisions.append("dry_run_config")
            else:
                decisions.append("dry_run_missing_live_flag")
            decisions.append("osascript_not_invoked")
            # Exercise rate caps in dry-run: count a would-be send.
            times.append(now)
            state["send_times"] = times
            log_event(
                self.config.events_log,
                self._base_event(message, decisions, would_send=reply, trigger_text=message.text),
                now_ts=now,
            )
            return True

        decisions.append("live_send")
        try:
            result = send_and_confirm(
                self.config.group_guid,
                reply,
                self.chat_db,
                self.config.delivery_confirm_seconds,
                send_fn=self.send_fn,
                clock=self.clock,
                sleeper=self.sleeper,
            )
            times.append(now)
            state["send_times"] = times
            decisions.append("delivery_confirmed")
            log_event(
                self.config.events_log,
                self._base_event(
                    message,
                    decisions,
                    would_send=reply,
                    trigger_text=message.text,
                    extra={"delivery": result},
                ),
                now_ts=now,
            )
            return True
        except Exception as exc:
            decisions.append("delivery_failed")
            log_event(
                self.config.events_log,
                self._base_event(
                    message,
                    decisions,
                    would_send=reply,
                    trigger_text=message.text,
                    extra={"error": str(exc)},
                ),
                now_ts=now,
            )
            raise_alert(
                self.config.alerts_log,
                "iMessage send/confirm failed: %s" % exc,
                self.config.alert_hook_command,
                extra={
                    "event": "send_failed",
                    "chat_guid": self.config.group_guid,
                    "trigger_rowid": message.rowid,
                },
                now_ts=now,
                runner=self.hook_runner,
            )
            return False

    def _enqueue(self, message, rest, now):
        log_event(
            self.config.queue_file,
            {
                "event": "desk_queue",
                "chat_guid": self.config.group_guid,
                "rowid": message.rowid,
                "guid": message.guid,
                "sender_handle": message.sender_label(),
                "is_from_me": message.is_from_me,
                "trigger_text": message.text,
                "question": rest,
            },
            now_ts=now,
        )

    def _base_event(self, message, decisions, would_send, trigger_text, extra=None):
        payload = {
            "event": "message",
            "chat_guid": self.config.group_guid,
            "rowid": message.rowid,
            "guid": message.guid,
            "sender_handle": message.sender_label(),
            "is_from_me": message.is_from_me,
            "trigger_text": trigger_text,
            "would_send": would_send,
            "decisions": decisions,
            "dry_run": not self.live_send_allowed(),
            "live_flag": self.live_flag,
            "config_dry_run": self.config.dry_run,
        }
        if extra:
            payload.update(extra)
        return payload


def ensure_data_dirs(config):
    for path in (
        config.state_file,
        config.events_log,
        config.alerts_log,
        config.queue_file,
        config.kill_flag_file,
    ):
        directory = os.path.dirname(path)
        if directory and not os.path.isdir(directory):
            os.makedirs(directory)
