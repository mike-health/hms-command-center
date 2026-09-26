"""One-pass and polling engine. Dry-run never calls the AppleScript sender."""

from __future__ import print_function

import os
import time as time_mod

from .chat_db import format_apple_date
from .config import REPLY_MODE_OUTBOX, REPLY_MODE_STUB
from .guardrails import (
    clamp_reply,
    in_quiet_hours,
    kill_flag_present,
    rate_cap_decision,
    set_kill_flag,
)
from .logs import iso_now, log_event, raise_alert
from .outbox import (
    OUTCOME_HELD,
    OUTCOME_REJECTED,
    OUTCOME_SENT,
    REASON_DRY_RUN,
    REASON_DUPLICATE,
    REASON_INVALID_JSON,
    REASON_KILL_SWITCH,
    REASON_LIVE_SEND,
    REASON_QUIET_HOURS,
    REASON_RATE_CAP,
    REASON_UNKNOWN_REPLY_TO,
    REASON_WRONG_CHAT,
    iter_outbox_lines,
    load_queue_guids,
    parse_outbox_record,
)
from .responder import generate_reply
from .sender import send_and_confirm
from .state import (
    already_answered,
    already_processed,
    load_state,
    mark_answered,
    mark_processed,
    outbox_offset,
    save_state,
    set_outbox_offset,
)
from .trigger import handle_allowed, is_self_loop_text, match_desk, parse_kill_command


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
        self.chat_db = chat_db
        if chat_db is None:
            from .chat_db import ChatDB

            self.chat_db = ChatDB(config.chat_db_path)
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
        processed = 0
        replies = 0
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
        else:
            messages = self.chat_db.fetch_new_messages(
                self.config.group_guid, int(state["high_water_rowid"])
            )
            processed = len(messages)
            for message in messages:
                acted = self._handle_message(state, message)
                if acted:
                    replies += 1
                mark_processed(state, message.rowid, message.guid)
                save_state(self.config.state_file, state)

        outbox_sent = self._process_outboxes(state)
        replies += outbox_sent
        save_state(self.config.state_file, state)
        return {
            "seeded": seeded,
            "processed": processed,
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

        desk, rest = match_desk(message.text, self.config.desks)
        if desk is None:
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
                    extra={"desk": desk.trigger_word},
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
                    extra={"desk": desk.trigger_word},
                ),
                now_ts=now,
            )
            return False

        decisions.append("allowlisted")
        decisions.append("trigger_matched")
        decisions.append("desk:%s" % desk.trigger_word)

        command = parse_kill_command(rest)
        if command == "stop" and message.is_from_me:
            return self._command_stop(state, message, rest, decisions, now, desk=desk)
        if command == "start" and message.is_from_me:
            return self._command_start(state, message, rest, decisions, now, desk=desk)

        if desk.reply_mode == REPLY_MODE_STUB and self._in_quiet_hours(now):
            decisions.append(SKIP_QUIET_HOURS)
            log_event(
                self.config.events_log,
                self._base_event(
                    message,
                    decisions,
                    would_send=None,
                    trigger_text=message.text,
                    extra={"desk": desk.trigger_word},
                ),
                now_ts=now,
            )
            return False

        self._enqueue(desk, message, rest, now)
        if desk.reply_mode == REPLY_MODE_OUTBOX:
            decisions.append("queued_outbox")
            decisions.append("no_immediate_reply")
            log_event(
                self.config.events_log,
                self._base_event(
                    message,
                    decisions,
                    would_send=None,
                    trigger_text=message.text,
                    extra={"desk": desk.trigger_word, "reply_mode": desk.reply_mode},
                ),
                now_ts=now,
            )
            return False

        return self._maybe_send(state, message, rest, decisions, now, desk=desk)

    def _in_quiet_hours(self, now):
        return self.config.quiet_hours_enabled() and in_quiet_hours(
            now,
            self.config.quiet_hours_start,
            self.config.quiet_hours_end,
            self.config.quiet_hours_timezone,
        )

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
        if is_self_loop_text(text, bot_prefix=self.config.bot_prefix):
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

    def _command_stop(self, state, message, rest, decisions, now, desk=None):
        already = bool(state.get("runtime_paused")) and kill_flag_present(self.config.kill_flag_file)
        state["runtime_paused"] = True
        set_kill_flag(self.config.kill_flag_file, True)
        decisions.append("kill_command_stop")
        if already and state.get("stop_ack_sent"):
            decisions.append("stop_ack_already_sent")
            log_event(
                self.config.events_log,
                self._base_event(
                    message,
                    decisions,
                    would_send=None,
                    trigger_text=message.text,
                    extra={"desk": desk.trigger_word if desk else None},
                ),
                now_ts=now,
            )
            return False
        state["stop_ack_sent"] = True
        prefix = desk.bot_prefix if desk else self.config.bot_prefix
        reply = clamp_reply("paused", prefix, self.config.max_reply_chars)
        return self._maybe_ack(state, message, rest, reply, decisions, now, desk=desk)

    def _command_start(self, state, message, rest, decisions, now, desk=None):
        state["runtime_paused"] = False
        state["stop_ack_sent"] = False
        set_kill_flag(self.config.kill_flag_file, False)
        decisions.append("kill_command_start")
        prefix = desk.bot_prefix if desk else self.config.bot_prefix
        if not self.config.enabled:
            reply = clamp_reply(
                "config enabled is false; flag cleared",
                prefix,
                self.config.max_reply_chars,
            )
        else:
            reply = clamp_reply("running", prefix, self.config.max_reply_chars)
        return self._maybe_ack(state, message, rest, reply, decisions, now, desk=desk)

    def _maybe_ack(self, state, message, rest, reply, decisions, now, desk=None):
        if self._in_quiet_hours(now):
            decisions.append(SKIP_QUIET_HOURS)
            log_event(
                self.config.events_log,
                self._base_event(
                    message,
                    decisions,
                    would_send=None,
                    trigger_text=message.text,
                    extra={"desk": desk.trigger_word if desk else None},
                ),
                now_ts=now,
            )
            return False
        return self._maybe_send(
            state,
            message,
            rest,
            decisions,
            now,
            bypass_kill=True,
            bypass_rate=True,
            canned_reply=reply,
            desk=desk,
        )

    def _maybe_send(
        self,
        state,
        message,
        rest,
        decisions,
        now,
        bypass_kill=False,
        bypass_rate=False,
        canned_reply=None,
        desk=None,
    ):
        if not bypass_kill:
            kills = self._kill_reasons(state)
            if kills:
                decisions.extend(kills)
                decisions.append("send_blocked_kill_switch")
                log_event(
                    self.config.events_log,
                    self._base_event(
                        message,
                        decisions,
                        would_send=None,
                        trigger_text=message.text,
                        extra={"desk": desk.trigger_word if desk else None},
                    ),
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
                self._base_event(
                    message,
                    decisions,
                    would_send=None,
                    trigger_text=message.text,
                    extra={"desk": desk.trigger_word if desk else None},
                ),
                now_ts=now,
            )
            return False

        prefix = desk.bot_prefix if desk else self.config.bot_prefix
        if canned_reply is not None:
            reply = canned_reply
            meta = {"responder": "canned"}
        else:
            reply, meta = generate_reply(
                self.config, rest, http_post=self.http_post, prefix=prefix
            )
            if meta.get("openai_error"):
                decisions.append("openai_fallback_stub")
        decisions.append("responder:%s" % meta.get("responder"))

        outcome, _reason = self._deliver(
            state,
            reply,
            decisions,
            now,
            bypass_kill=True,
            bypass_rate=True,
            event_factory=lambda decs, would: self._base_event(
                message,
                decs,
                would_send=would,
                trigger_text=message.text,
                extra={"desk": desk.trigger_word if desk else None},
            ),
        )
        if outcome == OUTCOME_SENT and message.guid:
            mark_answered(state, message.guid)
        return outcome == OUTCOME_SENT

    def _deliver(
        self,
        state,
        reply,
        decisions,
        now,
        bypass_kill=False,
        bypass_rate=False,
        event_factory=None,
    ):
        def emit(would_send=None):
            if event_factory:
                log_event(
                    self.config.events_log,
                    event_factory(list(decisions), would_send),
                    now_ts=now,
                )

        if not bypass_kill:
            kills = self._kill_reasons(state)
            if kills:
                decisions.extend(kills)
                decisions.append("send_blocked_kill_switch")
                emit(None)
                return OUTCOME_HELD, REASON_KILL_SWITCH

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
            emit(None)
            return OUTCOME_HELD, REASON_RATE_CAP

        live = self.live_send_allowed()
        if not live:
            if self.config.dry_run:
                decisions.append("dry_run_config")
            else:
                decisions.append("dry_run_missing_live_flag")
            decisions.append("osascript_not_invoked")
            times.append(now)
            state["send_times"] = times
            emit(reply)
            return OUTCOME_SENT, REASON_DRY_RUN

        decisions.append("live_send")

        def counting_send(guid, text):
            times.append(self.clock())
            state["send_times"] = times
            sender = self.send_fn
            if sender is None:
                from .sender import send_to_chat

                sender = send_to_chat
            return sender(guid, text)

        try:
            result = send_and_confirm(
                self.config.group_guid,
                reply,
                self.chat_db,
                self.config.delivery_confirm_seconds,
                send_fn=counting_send,
                clock=self.clock,
                sleeper=self.sleeper,
            )
            decisions.append("delivery_confirmed")
            payload = event_factory(list(decisions), reply) if event_factory else {}
            if event_factory:
                payload = dict(payload)
                payload["delivery"] = result
                log_event(self.config.events_log, payload, now_ts=now)
            return OUTCOME_SENT, REASON_LIVE_SEND
        except Exception as exc:
            decisions.append("delivery_failed")
            payload = event_factory(list(decisions), reply) if event_factory else {}
            if event_factory:
                payload = dict(payload)
                payload["error"] = str(exc)
                log_event(self.config.events_log, payload, now_ts=now)
            raise_alert(
                self.config.alerts_log,
                "iMessage send/confirm failed: %s" % exc,
                self.config.alert_hook_command,
                extra={
                    "event": "send_failed",
                    "chat_guid": self.config.group_guid,
                },
                now_ts=now,
                runner=self.hook_runner,
            )
            return OUTCOME_REJECTED, "delivery_failed"

    def _process_outboxes(self, state):
        sent = 0
        for desk in self.config.desks:
            sent += self._process_desk_outbox(state, desk)
            save_state(self.config.state_file, state)
        return sent

    def _process_desk_outbox(self, state, desk):
        path = desk.outbox_file
        if not path:
            return 0
        offset = outbox_offset(state, path)
        queued = None
        sent = 0
        for start, end, raw in iter_outbox_lines(path, offset):
            now = self.clock()
            record, parse_reason = parse_outbox_record(raw)
            if parse_reason:
                self._log_outbox(
                    desk,
                    None,
                    OUTCOME_REJECTED,
                    parse_reason,
                    now,
                    extra={"line": raw.strip()[:200]},
                )
                set_outbox_offset(state, path, end)
                offset = end
                continue
            if record is None:
                set_outbox_offset(state, path, end)
                offset = end
                continue

            if record["chat_guid"] != self.config.group_guid:
                self._log_outbox(
                    desk, record, OUTCOME_REJECTED, REASON_WRONG_CHAT, now
                )
                set_outbox_offset(state, path, end)
                offset = end
                continue

            if queued is None:
                queued = load_queue_guids(desk.queue_file)
            if record["reply_to"] not in queued:
                self._log_outbox(
                    desk, record, OUTCOME_REJECTED, REASON_UNKNOWN_REPLY_TO, now
                )
                set_outbox_offset(state, path, end)
                offset = end
                continue

            if already_answered(state, record["reply_to"]):
                self._log_outbox(
                    desk, record, OUTCOME_REJECTED, REASON_DUPLICATE, now
                )
                set_outbox_offset(state, path, end)
                offset = end
                continue

            if self._in_quiet_hours(now):
                self._log_outbox(
                    desk, record, OUTCOME_HELD, REASON_QUIET_HOURS, now
                )
                set_outbox_offset(state, path, start)
                return sent

            reply = clamp_reply(
                record["text"], desk.bot_prefix, self.config.max_reply_chars
            )
            decisions = [
                "outbox",
                "desk:%s" % desk.trigger_word,
            ]
            outcome, reason = self._deliver(
                state,
                reply,
                decisions,
                now,
                event_factory=None,
            )
            if outcome == OUTCOME_HELD:
                self._log_outbox(
                    desk,
                    record,
                    OUTCOME_HELD,
                    reason,
                    now,
                    extra={"decisions": list(decisions), "would_send": None},
                )
                set_outbox_offset(state, path, start)
                return sent
            if outcome == OUTCOME_SENT:
                mark_answered(state, record["reply_to"])
                sent += 1
                self._log_outbox(
                    desk,
                    record,
                    OUTCOME_SENT,
                    reason,
                    now,
                    extra={"decisions": list(decisions), "would_send": reply},
                )
                set_outbox_offset(state, path, end)
                offset = end
                continue
            # delivery failed: do not mark answered; retry later
            self._log_outbox(
                desk,
                record,
                OUTCOME_HELD,
                "delivery_failed",
                now,
                extra={"decisions": list(decisions), "would_send": reply},
            )
            set_outbox_offset(state, path, start)
            return sent
        set_outbox_offset(state, path, offset)
        return sent

    def _log_outbox(self, desk, record, outcome, reason, now, extra=None):
        payload = self._outbox_event(desk, record, outcome, reason, [outcome, reason], None)
        if extra:
            payload.update(extra)
        log_event(self.config.events_log, payload, now_ts=now)

    def _outbox_event(self, desk, record, outcome, reason, decisions, would_send):
        payload = {
            "event": "outbox",
            "desk": desk.trigger_word if desk else None,
            "chat_guid": self.config.group_guid,
            "outcome": outcome,
            "reason": reason,
            "decisions": decisions,
            "would_send": would_send,
            "dry_run": not self.live_send_allowed(),
            "live_flag": self.live_flag,
            "config_dry_run": self.config.dry_run,
        }
        if record:
            payload["reply_to"] = record.get("reply_to")
            payload["outbox_chat_guid"] = record.get("chat_guid")
            payload["outbox_ts"] = record.get("ts")
        return payload

    def _enqueue(self, desk, message, rest, now):
        timestamp = format_apple_date(message.date_raw) or iso_now(now)
        log_event(
            desk.queue_file,
            {
                "event": "desk_queue",
                "chat_guid": self.config.group_guid,
                "rowid": message.rowid,
                "guid": message.guid,
                "message_guid": message.guid,
                "sender_handle": message.sender_label(),
                "is_from_me": message.is_from_me,
                "trigger_word": desk.trigger_word,
                "desk": desk.trigger_word,
                "trigger_text": message.text,
                "question": rest,
                "timestamp": timestamp,
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
    paths = [
        config.state_file,
        config.events_log,
        config.alerts_log,
        config.queue_file,
        config.kill_flag_file,
    ]
    for desk in getattr(config, "desks", None) or []:
        paths.append(desk.queue_file)
        paths.append(desk.outbox_file)
    for path in paths:
        directory = os.path.dirname(path)
        if directory and not os.path.isdir(directory):
            os.makedirs(directory)
