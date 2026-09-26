from datetime import datetime
import json
import os
import tempfile
import unittest

from helpers import FakeDB, GROUP_GUID, msg, write_config
from imessage_group_bot.engine import Engine
from imessage_group_bot.state import load_state, save_state


def _events(config):
    if not os.path.exists(config.events_log):
        return []
    with open(config.events_log, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


class ExplodingSend(object):
    def __init__(self):
        self.calls = []

    def __call__(self, guid, text):
        self.calls.append((guid, text))
        raise AssertionError("send_to_chat must not be called in dry-run")


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.config = write_config(self.tmpdir.name)
        self.sender = ExplodingSend()

    def tearDown(self):
        self.tmpdir.cleanup()

    def _engine(self, messages, max_id=0, live=False, **kwargs):
        db = FakeDB(messages=messages, max_id=max_id)
        return Engine(
            self.config,
            live_flag=live,
            chat_db=db,
            send_fn=self.sender,
            clock=kwargs.get("clock", lambda: 1_000_000.0),
            sleeper=lambda _s: None,
            http_post=kwargs.get("http_post"),
        ), db

    def _prime_high_water(self, value=0):
        state = load_state(self.config.state_file)
        state["high_water_rowid"] = value
        save_state(self.config.state_file, state)

    def test_backlog_before_start_is_ignored(self):
        messages = [msg(rowid=50, text="@dev old")]
        engine, db = self._engine(messages, max_id=50)
        result = engine.process_once()
        self.assertTrue(result["seeded"])
        self.assertEqual(result["processed"], 0)
        self.assertEqual(self.sender.calls, [])
        events = _events(self.config)
        self.assertTrue(any("backlog_ignored_on_first_start" in e.get("decisions", []) for e in events) or any(
            e.get("event") == "high_water_seeded" for e in events
        ))

    def test_trigger_allowlist_and_stub_dry_run(self):
        self._prime_high_water(0)
        messages = [msg(rowid=2, text="@dev ship the build", handle="+15555550101")]
        engine, _ = self._engine(messages)
        result = engine.process_once()
        self.assertEqual(result["replies"], 1)
        self.assertEqual(self.sender.calls, [])
        events = _events(self.config)
        hit = [e for e in events if e.get("rowid") == 2][-1]
        self.assertIn("allowlisted", hit["decisions"])
        self.assertIn("dry_run_config", hit["decisions"])
        self.assertIn("osascript_not_invoked", hit["decisions"])
        self.assertTrue(hit["would_send"].startswith("🤖 Dev:"))
        self.assertIn("routing to the dev desk", hit["would_send"])
        self.assertEqual(hit["sender_handle"], "+15555550101")
        self.assertEqual(hit["chat_guid"], GROUP_GUID)
        with open(self.config.queue_file, encoding="utf-8") as handle:
            queued = json.loads(handle.readline())
        self.assertEqual(queued["question"], "ship the build")

    def test_mike_is_from_me_allowed(self):
        self._prime_high_water(0)
        messages = [msg(rowid=3, text="@dev from mike", handle="", is_from_me=1)]
        engine, _ = self._engine(messages)
        engine.process_once()
        hit = [e for e in _events(self.config) if e.get("rowid") == 3][-1]
        self.assertIn("allowlisted", hit["decisions"])
        self.assertEqual(hit["sender_handle"], "me")

    def test_unknown_handle_skipped(self):
        self._prime_high_water(0)
        messages = [msg(rowid=4, text="@dev hi", handle="+15555550999")]
        engine, _ = self._engine(messages)
        result = engine.process_once()
        self.assertEqual(result["replies"], 0)
        hit = [e for e in _events(self.config) if e.get("rowid") == 4][-1]
        self.assertIn("not_allowlisted", hit["decisions"])

    def test_self_loop_emoji_skipped(self):
        self._prime_high_water(0)
        messages = [msg(rowid=5, text="🤖 Dev: got it", is_from_me=1)]
        engine, _ = self._engine(messages)
        engine.process_once()
        hit = [e for e in _events(self.config) if e.get("rowid") == 5][-1]
        self.assertIn("self_loop_emoji_prefix", hit["decisions"])

    def test_reaction_and_edit_skipped(self):
        self._prime_high_water(0)
        messages = [
            msg(rowid=6, text="@dev hi", associated_message_type=2000),
            msg(rowid=7, text="@dev hi", date_edited=123),
            msg(rowid=8, text="", cache_has_attachments=1),
        ]
        engine, _ = self._engine(messages)
        engine.process_once()
        events = {e["rowid"]: e for e in _events(self.config) if "rowid" in e}
        self.assertIn("reaction_or_associated", events[6]["decisions"])
        self.assertIn("edit", events[7]["decisions"])
        self.assertIn("empty_or_attachment_only", events[8]["decisions"])

    def test_rate_caps_logged_in_dry_run(self):
        self.config.min_seconds_between_replies = 20
        self._prime_high_water(0)
        clock = {"t": 1000.0}

        def now():
            return clock["t"]

        messages = [
            msg(rowid=10, text="@dev one"),
            msg(rowid=11, text="@dev two"),
        ]
        engine, _ = self._engine(messages, clock=now)
        engine.process_once()
        events = [e for e in _events(self.config) if e.get("rowid") in (10, 11)]
        self.assertIn("dry_run_config", events[0]["decisions"])
        self.assertIn("rate_cap:min_interval", events[1]["decisions"])
        self.assertEqual(self.sender.calls, [])

    def test_hourly_and_daily_caps(self):
        self.config.min_seconds_between_replies = 0
        self.config.max_replies_per_hour = 2
        self.config.max_replies_per_day = 3
        now = 50_000.0
        state = load_state(self.config.state_file)
        state["high_water_rowid"] = 0
        state["send_times"] = [now - 100, now - 50]
        save_state(self.config.state_file, state)
        engine, _ = self._engine([msg(rowid=20, text="@dev hour")], clock=lambda: now)
        engine.process_once()
        hit = [e for e in _events(self.config) if e.get("rowid") == 20][-1]
        self.assertIn("rate_cap:hourly_cap", hit["decisions"])

        state = load_state(self.config.state_file)
        state["high_water_rowid"] = 20
        state["send_times"] = [now - 8000] * 3
        save_state(self.config.state_file, state)
        later = now + 4000
        engine, _ = self._engine([msg(rowid=21, text="@dev day")], clock=lambda: later)
        engine.process_once()
        hit = [e for e in _events(self.config) if e.get("rowid") == 21][-1]
        self.assertIn("rate_cap:daily_cap", hit["decisions"])

    def test_kill_switch_flag_and_config(self):
        self._prime_high_water(0)
        with open(self.config.kill_flag_file, "w", encoding="utf-8") as handle:
            handle.write("x")
        messages = [msg(rowid=12, text="@dev go")]
        engine, _ = self._engine(messages)
        engine.process_once()
        hit = [e for e in _events(self.config) if e.get("rowid") == 12][-1]
        self.assertIn("kill_flag_file", hit["decisions"])
        self.assertIn("send_blocked_kill_switch", hit["decisions"])
        self.assertIsNone(hit["would_send"])
        self.assertEqual(self.sender.calls, [])

        os.remove(self.config.kill_flag_file)
        self.config.enabled = False
        self._prime_high_water(12)
        engine, _ = self._engine([msg(rowid=13, text="@dev go2")])
        engine.process_once()
        hit = [e for e in _events(self.config) if e.get("rowid") == 13][-1]
        self.assertIn("config_enabled_false", hit["decisions"])

    def test_in_group_stop_from_mike_only(self):
        self._prime_high_water(0)
        messages = [
            msg(rowid=14, text="@dev stop", handle="+15555550101", is_from_me=0),
            msg(rowid=15, text="@dev stop", is_from_me=1, handle=""),
        ]
        engine, _ = self._engine(messages)
        engine.process_once()
        todd = [e for e in _events(self.config) if e.get("rowid") == 14][-1]
        mike = [e for e in _events(self.config) if e.get("rowid") == 15][-1]
        self.assertNotIn("kill_command_stop", todd["decisions"])
        self.assertIn("kill_command_stop", mike["decisions"])
        self.assertTrue(os.path.exists(self.config.kill_flag_file))
        self.assertIn("paused", mike["would_send"])

    def test_mike_stop_at_night_sets_flag_without_ack(self):
        try:
            from zoneinfo import ZoneInfo

            tz = ZoneInfo("America/Los_Angeles")
        except Exception:
            self.skipTest("America/Los_Angeles timezone data is required")
        self.config.quiet_hours_start = "21:00"
        self.config.quiet_hours_end = "06:00"
        self.config.quiet_hours_timezone = "America/Los_Angeles"
        self._prime_high_water(0)
        night = datetime(2026, 9, 25, 23, 0, tzinfo=tz).timestamp()
        engine, _ = self._engine(
            [msg(rowid=30, text="@dev stop", is_from_me=1, handle="")],
            clock=lambda: night,
        )
        engine.process_once()
        hit = [e for e in _events(self.config) if e.get("rowid") == 30][-1]
        self.assertIn("kill_command_stop", hit["decisions"])
        self.assertIn("suppressed: quiet_hours", hit["decisions"])
        self.assertTrue(os.path.exists(self.config.kill_flag_file))
        self.assertIsNone(hit["would_send"])
        self.assertEqual(self.sender.calls, [])
        self.assertTrue(load_state(self.config.state_file).get("runtime_paused"))
        self.assertFalse(os.path.exists(self.config.queue_file))

    def test_quiet_hours_overnight_wrap_not_queued(self):
        """21:00–06:00 America/Los_Angeles: 20:59 and 06:00 send (dry-run), 21:00 and 05:59 suppressed."""
        try:
            from zoneinfo import ZoneInfo

            ZoneInfo("America/Los_Angeles")
        except Exception:
            self.skipTest("America/Los_Angeles timezone data is required")

        tz = ZoneInfo("America/Los_Angeles")
        self.config.quiet_hours_start = "21:00"
        self.config.quiet_hours_end = "06:00"
        self.config.quiet_hours_timezone = "America/Los_Angeles"
        self._prime_high_water(0)

        stamps = [
            datetime(2026, 9, 25, 20, 59, tzinfo=tz).timestamp(),
            datetime(2026, 9, 25, 21, 0, tzinfo=tz).timestamp(),
            datetime(2026, 9, 26, 5, 59, tzinfo=tz).timestamp(),
            datetime(2026, 9, 26, 6, 0, tzinfo=tz).timestamp(),
        ]
        cursor = {"i": 0}

        def clock():
            i = min(cursor["i"], len(stamps) - 1)
            value = stamps[i]
            cursor["i"] += 1
            return value

        messages = [
            msg(rowid=100, text="@dev 2059"),
            msg(rowid=101, text="@dev 2100"),
            msg(rowid=102, text="@dev 0559"),
            msg(rowid=103, text="@dev 0600"),
        ]
        engine, _ = self._engine(messages, clock=clock)
        engine.process_once()
        by_id = {e["rowid"]: e for e in _events(self.config) if e.get("rowid") in (100, 101, 102, 103)}
        self.assertIn("osascript_not_invoked", by_id[100]["decisions"])
        self.assertTrue(by_id[100]["would_send"])
        self.assertNotIn("suppressed: quiet_hours", by_id[100]["decisions"])
        self.assertIn("suppressed: quiet_hours", by_id[101]["decisions"])
        self.assertIsNone(by_id[101]["would_send"])
        self.assertIn("suppressed: quiet_hours", by_id[102]["decisions"])
        self.assertIsNone(by_id[102]["would_send"])
        self.assertIn("osascript_not_invoked", by_id[103]["decisions"])
        self.assertTrue(by_id[103]["would_send"])
        self.assertEqual(self.sender.calls, [])
        queued_rowids = []
        if os.path.exists(self.config.queue_file):
            with open(self.config.queue_file, encoding="utf-8") as handle:
                queued_rowids = [json.loads(line)["rowid"] for line in handle if line.strip()]
        self.assertEqual(queued_rowids, [100, 103])

    def test_live_requires_both_flags(self):
        self.config.dry_run = False
        self._prime_high_water(0)
        engine, _ = self._engine([msg(rowid=17, text="@dev x")], live=False)
        engine.process_once()
        hit = [e for e in _events(self.config) if e.get("rowid") == 17][-1]
        self.assertIn("dry_run_missing_live_flag", hit["decisions"])
        self.assertEqual(self.sender.calls, [])

        self.config.dry_run = True
        self._prime_high_water(17)
        engine, _ = self._engine([msg(rowid=18, text="@dev y")], live=True, clock=lambda: 2_000_000.0)
        engine.process_once()
        hit = [e for e in _events(self.config) if e.get("rowid") == 18][-1]
        self.assertIn("dry_run_config", hit["decisions"])
        self.assertEqual(self.sender.calls, [])

    def test_idempotent_on_rowid(self):
        self._prime_high_water(0)
        m = msg(rowid=19, text="@dev again")
        engine, db = self._engine([m])
        engine.process_once()
        db.messages = [m]
        engine.process_once()
        hits = [e for e in _events(self.config) if e.get("rowid") == 19]
        # second pass is skipped because high water moved
        self.assertEqual(len(hits), 1)

    def test_live_send_uses_injected_sender(self):
        self.config.dry_run = False
        self._prime_high_water(0)
        sent = []

        def send_ok(guid, text):
            sent.append((guid, text))

        db = FakeDB(messages=[msg(rowid=21, text="@dev live")], max_id=20)
        db.from_me = []

        def send_and_record(guid, text):
            sent.append((guid, text))
            db.from_me.append((22, text))

        engine = Engine(
            self.config,
            live_flag=True,
            chat_db=db,
            send_fn=send_and_record,
            clock=lambda: 5_000.0,
            sleeper=lambda _s: None,
        )
        engine.process_once()
        self.assertEqual(len(sent), 1)
        self.assertTrue(sent[0][1].startswith("🤖 Dev:"))
        hit = [e for e in _events(self.config) if e.get("rowid") == 21][-1]
        self.assertIn("live_send", hit["decisions"])
        self.assertIn("delivery_confirmed", hit["decisions"])

    def test_failed_sends_count_toward_rate_caps(self):
        """Each osascript attempt counts, even when delivery confirm fails (QC: 5 triggers → 10 sends)."""
        self.config.dry_run = False
        self.config.min_seconds_between_replies = 0
        self.config.max_replies_per_hour = 40
        self.config.max_replies_per_day = 40
        self.config.delivery_confirm_seconds = 1
        self._prime_high_water(0)
        sent = []

        class Clock(object):
            def __init__(self):
                self.t = 20_000.0

            def __call__(self):
                return self.t

            def sleep(self, seconds):
                self.t += float(seconds)

        clock = Clock()

        def send_no_confirm(guid, text):
            sent.append((guid, text))

        messages = [msg(rowid=50 + i, text="@dev n%s" % i) for i in range(5)]
        db = FakeDB(messages=messages, max_id=49)
        engine = Engine(
            self.config,
            live_flag=True,
            chat_db=db,
            send_fn=send_no_confirm,
            clock=clock,
            sleeper=clock.sleep,
        )
        engine.process_once()
        self.assertEqual(len(sent), 10)
        times = load_state(self.config.state_file).get("send_times") or []
        self.assertEqual(len(times), 10)
        failed = [e for e in _events(self.config) if "delivery_failed" in e.get("decisions", [])]
        self.assertEqual(len(failed), 5)

    def test_openai_not_called_before_guards(self):
        self.config.responder_type = "openai_compatible"
        calls = []

        def http_post(*_args, **_kwargs):
            calls.append(1)
            raise AssertionError("openai_compatible must not run before guards")

        self._prime_high_water(0)
        with open(self.config.kill_flag_file, "w", encoding="utf-8") as handle:
            handle.write("x")
        engine, _ = self._engine([msg(rowid=60, text="@dev guarded")], http_post=http_post)
        engine.process_once()
        self.assertEqual(calls, [])
        os.remove(self.config.kill_flag_file)

        self.config.enabled = False
        self._prime_high_water(60)
        engine, _ = self._engine([msg(rowid=61, text="@dev guarded2")], http_post=http_post)
        engine.process_once()
        self.assertEqual(calls, [])
        self.config.enabled = True

        self.config.min_seconds_between_replies = 20
        state = load_state(self.config.state_file)
        state["high_water_rowid"] = 61
        state["send_times"] = [1_000_000.0]
        save_state(self.config.state_file, state)
        engine, _ = self._engine([msg(rowid=62, text="@dev guarded3")], http_post=http_post)
        engine.process_once()
        self.assertEqual(calls, [])

        try:
            from zoneinfo import ZoneInfo

            tz = ZoneInfo("America/Los_Angeles")
        except Exception:
            return
        self.config.quiet_hours_start = "21:00"
        self.config.quiet_hours_end = "06:00"
        night = datetime(2026, 9, 25, 23, 0, tzinfo=tz).timestamp()
        self._prime_high_water(62)
        engine, _ = self._engine(
            [msg(rowid=63, text="@dev guarded4")],
            clock=lambda: night,
            http_post=http_post,
        )
        engine.process_once()
        self.assertEqual(calls, [])


def _ops_desk(config):
    for desk in config.desks:
        if desk.trigger_word.strip().lower() == "@ops":
            return desk
    raise AssertionError("missing @ops desk")


def _append_jsonl(path, record):
    directory = os.path.dirname(path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record))
        handle.write("\n")


class DeskOutboxTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.config = write_config(self.tmpdir.name)
        self.sender = ExplodingSend()
        self.ops = _ops_desk(self.config)

    def tearDown(self):
        self.tmpdir.cleanup()

    def _engine(self, messages, max_id=0, live=False, **kwargs):
        db = FakeDB(messages=messages, max_id=max_id)
        return Engine(
            self.config,
            live_flag=live,
            chat_db=db,
            send_fn=self.sender,
            clock=kwargs.get("clock", lambda: 1_000_000.0),
            sleeper=lambda _s: None,
            http_post=kwargs.get("http_post"),
        ), db

    def _prime_high_water(self, value=0):
        state = load_state(self.config.state_file)
        state["high_water_rowid"] = value
        save_state(self.config.state_file, state)

    def _queue_and_outbox(self, guid="G-OPS", text="studio status", chat_guid=None):
        chat_guid = chat_guid or GROUP_GUID
        _append_jsonl(
            self.ops.outbox_file,
            {
                "reply_to": guid,
                "chat_guid": chat_guid,
                "text": text,
                "ts": "2026-09-26T20:00:00+00:00",
            },
        )

    def test_ops_trigger_queued_without_immediate_reply(self):
        self._prime_high_water(0)
        messages = [msg(rowid=70, guid="G-OPS-70", text="@ops is the studio up?")]
        engine, _ = self._engine(messages)
        result = engine.process_once()
        self.assertEqual(result["replies"], 0)
        self.assertEqual(self.sender.calls, [])
        hit = [e for e in _events(self.config) if e.get("rowid") == 70][-1]
        self.assertIn("queued_outbox", hit["decisions"])
        self.assertIn("no_immediate_reply", hit["decisions"])
        self.assertIsNone(hit["would_send"])
        self.assertFalse(os.path.exists(self.config.queue_file))
        with open(self.ops.queue_file, encoding="utf-8") as handle:
            queued = json.loads(handle.readline())
        self.assertEqual(queued["guid"], "G-OPS-70")
        self.assertEqual(queued["message_guid"], "G-OPS-70")
        self.assertEqual(queued["rowid"], 70)
        self.assertEqual(queued["chat_guid"], GROUP_GUID)
        self.assertEqual(queued["sender_handle"], "+15555550101")
        self.assertEqual(queued["trigger_word"], "@ops")
        self.assertEqual(queued["desk"], "@ops")
        self.assertEqual(queued["question"], "is the studio up?")
        self.assertIn("timestamp", queued)

    def test_outbox_send_uses_ops_prefix(self):
        self._prime_high_water(0)
        messages = [msg(rowid=71, guid="G-OPS-71", text="@ops ping")]
        self._queue_and_outbox("G-OPS-71", "all green")
        engine, _ = self._engine(messages)
        result = engine.process_once()
        self.assertEqual(result["replies"], 1)
        self.assertEqual(self.sender.calls, [])
        outbox_events = [e for e in _events(self.config) if e.get("event") == "outbox"]
        self.assertTrue(outbox_events)
        hit = outbox_events[-1]
        self.assertEqual(hit["outcome"], "sent")
        self.assertTrue(hit["would_send"].startswith("🤖 Ops:"))
        self.assertIn("all green", hit["would_send"])
        self.assertIn("osascript_not_invoked", hit["decisions"])
        self.assertEqual(hit["reply_to"], "G-OPS-71")

    def test_outbox_rejects_wrong_chat_unknown_and_duplicate(self):
        self._prime_high_water(0)
        messages = [msg(rowid=72, guid="G-OPS-72", text="@ops one")]
        engine, _ = self._engine(messages)
        engine.process_once()

        _append_jsonl(
            self.ops.outbox_file,
            {
                "reply_to": "G-OPS-72",
                "chat_guid": "iMessage;+;chatOTHER",
                "text": "nope",
                "ts": "2026-09-26T20:00:00+00:00",
            },
        )
        _append_jsonl(
            self.ops.outbox_file,
            {
                "reply_to": "not-in-queue",
                "chat_guid": GROUP_GUID,
                "text": "nope",
                "ts": "2026-09-26T20:00:01+00:00",
            },
        )
        _append_jsonl(
            self.ops.outbox_file,
            {
                "reply_to": "G-OPS-72",
                "chat_guid": GROUP_GUID,
                "text": "first answer",
                "ts": "2026-09-26T20:00:02+00:00",
            },
        )
        _append_jsonl(
            self.ops.outbox_file,
            {
                "reply_to": "G-OPS-72",
                "chat_guid": GROUP_GUID,
                "text": "second answer",
                "ts": "2026-09-26T20:00:03+00:00",
            },
        )
        engine.process_once()
        reasons = [
            e.get("reason")
            for e in _events(self.config)
            if e.get("event") == "outbox"
        ]
        self.assertIn("wrong_chat_guid", reasons)
        self.assertIn("unknown_reply_to", reasons)
        self.assertIn("duplicate", reasons)
        sent = [
            e
            for e in _events(self.config)
            if e.get("event") == "outbox" and e.get("outcome") == "sent"
        ]
        self.assertEqual(len(sent), 1)
        self.assertIn("first answer", sent[0]["would_send"])
        self.assertEqual(self.sender.calls, [])

    def test_shared_rate_caps_across_desks(self):
        self.config.min_seconds_between_replies = 20
        self._prime_high_water(0)
        messages = [
            msg(rowid=80, guid="G-DEV-80", text="@dev one"),
            msg(rowid=81, guid="G-OPS-81", text="@ops two"),
        ]
        self._queue_and_outbox("G-OPS-81", "ops answer")
        engine, _ = self._engine(messages)
        engine.process_once()
        held = [
            e
            for e in _events(self.config)
            if e.get("event") == "outbox" and e.get("outcome") == "held"
        ]
        self.assertTrue(held)
        self.assertEqual(held[-1]["reason"], "rate_cap")
        self.assertIn("rate_cap:min_interval", held[-1]["decisions"])
        self.assertEqual(self.sender.calls, [])

    def test_quiet_hours_holds_outbox(self):
        try:
            from zoneinfo import ZoneInfo

            tz = ZoneInfo("America/Los_Angeles")
        except Exception:
            self.skipTest("America/Los_Angeles timezone data is required")
        self.config.quiet_hours_start = "21:00"
        self.config.quiet_hours_end = "06:00"
        self.config.quiet_hours_timezone = "America/Los_Angeles"
        self._prime_high_water(0)
        night = datetime(2026, 9, 25, 23, 0, tzinfo=tz).timestamp()
        day = datetime(2026, 9, 26, 6, 0, tzinfo=tz).timestamp()
        clock = {"t": night}

        def now():
            return clock["t"]

        messages = [msg(rowid=90, guid="G-OPS-90", text="@ops overnight")]
        self._queue_and_outbox("G-OPS-90", "held then sent")
        engine, _ = self._engine(messages, clock=now)
        engine.process_once()
        held = [
            e
            for e in _events(self.config)
            if e.get("event") == "outbox"
        ]
        self.assertTrue(held)
        self.assertEqual(held[-1]["outcome"], "held")
        self.assertEqual(held[-1]["reason"], "quiet_hours")
        self.assertEqual(self.sender.calls, [])
        offset_before = load_state(self.config.state_file)["outbox_offsets"][self.ops.outbox_file]
        self.assertEqual(offset_before, 0)

        clock["t"] = day
        engine.process_once()
        sent = [
            e
            for e in _events(self.config)
            if e.get("event") == "outbox" and e.get("outcome") == "sent"
        ]
        self.assertEqual(len(sent), 1)
        self.assertTrue(sent[0]["would_send"].startswith("🤖 Ops:"))
        self.assertGreater(
            load_state(self.config.state_file)["outbox_offsets"][self.ops.outbox_file], 0
        )

    def test_outbox_dry_run_never_invokes_osascript(self):
        self._prime_high_water(0)
        messages = [msg(rowid=91, guid="G-OPS-91", text="@ops dry")]
        self._queue_and_outbox("G-OPS-91", "please send")
        engine, _ = self._engine(messages)
        engine.process_once()
        self.assertEqual(self.sender.calls, [])
        sent = [
            e
            for e in _events(self.config)
            if e.get("event") == "outbox" and e.get("outcome") == "sent"
        ]
        self.assertEqual(len(sent), 1)
        self.assertIn("osascript_not_invoked", sent[0]["decisions"])

    def test_restart_does_not_resend_outbox(self):
        self.config.dry_run = False
        self._prime_high_water(0)
        sent = []

        db = FakeDB(
            messages=[msg(rowid=92, guid="G-OPS-92", text="@ops live")],
            max_id=91,
        )

        def send_and_record(guid, text):
            sent.append((guid, text))
            db.from_me.append((93, text))

        self._queue_and_outbox("G-OPS-92", "only once")
        engine = Engine(
            self.config,
            live_flag=True,
            chat_db=db,
            send_fn=send_and_record,
            clock=lambda: 7_000.0,
            sleeper=lambda _s: None,
        )
        engine.process_once()
        self.assertEqual(len(sent), 1)
        self.assertTrue(sent[0][1].startswith("🤖 Ops:"))

        db.messages = []
        engine2 = Engine(
            self.config,
            live_flag=True,
            chat_db=db,
            send_fn=send_and_record,
            clock=lambda: 7_100.0,
            sleeper=lambda _s: None,
        )
        engine2.process_once()
        self.assertEqual(len(sent), 1)
        answered = load_state(self.config.state_file).get("answered_reply_tos") or []
        self.assertIn("G-OPS-92", answered)

    def test_ops_stop_from_mike_is_global(self):
        self._prime_high_water(0)
        engine, _ = self._engine(
            [msg(rowid=93, text="@ops stop", is_from_me=1, handle="")]
        )
        engine.process_once()
        hit = [e for e in _events(self.config) if e.get("rowid") == 93][-1]
        self.assertIn("kill_command_stop", hit["decisions"])
        self.assertTrue(os.path.exists(self.config.kill_flag_file))
        self.assertTrue(hit["would_send"].startswith("🤖 Ops:"))
        self.assertIn("paused", hit["would_send"])


if __name__ == "__main__":
    unittest.main()
