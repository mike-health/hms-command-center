"""Per-conversation reply routing (reply_routes): 1:1 questions answered in the 1:1."""

import io
import json
import os
import tempfile
import unittest

from helpers import FakeDB, GROUP_GUID, msg, write_config
from imessage_group_bot.config import ConfigError
from imessage_group_bot.engine import Engine
from imessage_group_bot.outbox import list_pending
from imessage_group_bot.state import load_state, save_state


ALIAS_GUID = "any;+;aliasTESTGUID0002"
ONE_TO_ONE = "any;-;+19169123214"
ONE_TO_ONE_ALIAS = "any;-;mikestransfer@gmail.com"
MIKE_PHONE = "+19169123214"


def _events(config):
    if not os.path.exists(config.events_log):
        return []
    with open(config.events_log, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def _ops_desk(config):
    return config.desk_for_trigger("@ops")


def _append_jsonl(path, record):
    directory = os.path.dirname(path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")


class GhRecorder(object):
    def __init__(self):
        self.calls = []

    def __call__(self, argv, timeout):
        self.calls.append(argv)
        return 0


class ReplyRouteConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_routes_are_watched_and_mapped(self):
        cfg = write_config(
            self.tmpdir.name,
            watch_chat_guids=[ALIAS_GUID],
            reply_routes={ONE_TO_ONE: ONE_TO_ONE, ONE_TO_ONE_ALIAS: ONE_TO_ONE},
        )
        self.assertEqual(
            cfg.watched_chat_guids, [GROUP_GUID, ALIAS_GUID, ONE_TO_ONE, ONE_TO_ONE_ALIAS]
        )
        self.assertEqual(cfg.reply_chat_guids, [GROUP_GUID, ONE_TO_ONE])
        self.assertEqual(cfg.reply_chat_for(GROUP_GUID), GROUP_GUID)
        self.assertEqual(cfg.reply_chat_for(ALIAS_GUID), GROUP_GUID)
        self.assertEqual(cfg.reply_chat_for(ONE_TO_ONE), ONE_TO_ONE)
        self.assertEqual(cfg.reply_chat_for(ONE_TO_ONE_ALIAS), ONE_TO_ONE)
        self.assertEqual(cfg.reply_chat_for("any;-;+15555550999"), GROUP_GUID)
        self.assertFalse(cfg.accepts_outbox_chat("any;-;+15555550999"))

    def test_missing_routes_is_unchanged(self):
        cfg = write_config(self.tmpdir.name, watch_chat_guids=[ALIAS_GUID])
        self.assertEqual(cfg.reply_routes, {})
        self.assertEqual(cfg.watched_chat_guids, [GROUP_GUID, ALIAS_GUID])
        self.assertEqual(cfg.reply_chat_guids, [GROUP_GUID])

    def test_bad_routes_rejected(self):
        with self.assertRaises(ConfigError):
            write_config(self.tmpdir.name, reply_routes=[ONE_TO_ONE])
        with self.assertRaises(ConfigError):
            write_config(self.tmpdir.name, reply_routes={ONE_TO_ONE: ""})


class ReplyRouteEngineTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.config = write_config(
            self.tmpdir.name,
            dry_run=False,
            watch_chat_guids=[ALIAS_GUID],
            from_me_handle=MIKE_PHONE,
            allowlist_handles=[MIKE_PHONE, "+15555550101"],
            reply_routes={ONE_TO_ONE: ONE_TO_ONE, ONE_TO_ONE_ALIAS: ONE_TO_ONE},
            notify_github={
                "repo": "mike-health/hms-command-center",
                "pr": 19,
                "gh_path": "/opt/homebrew/bin/gh",
            },
        )
        self.ops = _ops_desk(self.config)
        self.sent = []
        self.gh = GhRecorder()

    def tearDown(self):
        self.tmpdir.cleanup()

    def _prime(self, value=0):
        state = load_state(self.config.state_file)
        state["high_water_rowid"] = value
        state["high_water_by_chat"] = {g: value for g in self.config.watched_chat_guids}
        save_state(self.config.state_file, state)

    def _run(self, messages, clock=10_000.0):
        db = FakeDB(messages=messages, max_id=0)
        next_row = [1000]

        def send_ok(guid, text):
            self.sent.append((guid, text))
            next_row[0] += 1
            db.from_me.append((next_row[0], text))

        engine = Engine(
            self.config,
            live_flag=True,
            chat_db=db,
            send_fn=send_ok,
            clock=lambda: clock,
            sleeper=lambda _s: None,
            gh_run=self.gh,
        )
        engine.process_once()
        return engine

    def test_one_to_one_dev_test_from_me_replies_in_one_to_one(self):
        self._prime(0)
        self._run([msg(rowid=10, guid="G1", text="@dev test", handle=MIKE_PHONE,
                       is_from_me=1, chat_guid=ONE_TO_ONE)])
        self.assertEqual(self.sent, [(ONE_TO_ONE, "🤖 Dev: I'm here")])
        hit = [e for e in _events(self.config) if e.get("rowid") == 10][-1]
        self.assertEqual(hit["reply_chat_guid"], ONE_TO_ONE)
        self.assertIn("delivery_confirmed", hit["decisions"])
        self.assertEqual(self.gh.calls, [])

    def test_one_to_one_received_copy_replies_in_one_to_one(self):
        self._prime(0)
        self._run([msg(rowid=11, guid="G2", text="@dev test", handle=MIKE_PHONE,
                       is_from_me=0, chat_guid=ONE_TO_ONE)])
        self.assertEqual(self.sent, [(ONE_TO_ONE, "🤖 Dev: I'm here")])

    def test_one_to_one_alias_routes_to_one_to_one_and_dedupes(self):
        self._prime(0)
        self._run([
            msg(rowid=12, guid="G3a", text="@ops test", handle="", is_from_me=1,
                chat_guid=ONE_TO_ONE_ALIAS),
            msg(rowid=13, guid="G3b", text="@ops test", handle=MIKE_PHONE, is_from_me=0,
                chat_guid=ONE_TO_ONE),
        ])
        self.assertEqual(self.sent, [(ONE_TO_ONE, "🤖 Ops: I'm here")])

    def test_one_to_one_question_acks_queues_and_outbox_routes_back(self):
        self._prime(0)
        question = "@ops list linear to do for next week"
        self._run([msg(rowid=20, guid="G-Q1", text=question, handle=MIKE_PHONE,
                       is_from_me=1, chat_guid=ONE_TO_ONE)])
        self.assertEqual(self.sent, [(ONE_TO_ONE, "🤖 Ops: on it")])
        self.assertEqual(len(self.gh.calls), 1)
        with open(self.ops.queue_file, encoding="utf-8") as handle:
            queued = json.loads(handle.readline())
        self.assertEqual(queued["source_chat_guid"], ONE_TO_ONE)
        self.assertEqual(queued["reply_chat_guid"], ONE_TO_ONE)
        pending = list_pending(self.config)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["chat_guid"], ONE_TO_ONE)
        self.assertEqual(pending[0]["reply_to"], "G-Q1")
        _append_jsonl(self.ops.outbox_file, {
            "reply_to": "G-Q1", "chat_guid": pending[0]["chat_guid"],
            "text": "1. HEA-1\n2. HEA-2", "ts": "2026-09-26T23:00:00+00:00",
        })
        self._run([], clock=10_100.0)
        self.assertEqual(self.sent[-1][0], ONE_TO_ONE)
        self.assertTrue(self.sent[-1][1].startswith("🤖 Ops: 1. HEA-1"))
        out = [e for e in _events(self.config) if e.get("event") == "outbox"][-1]
        self.assertEqual(out["outcome"], "sent")
        self.assertEqual(out["chat_guid"], ONE_TO_ONE)
        self.assertEqual(list_pending(self.config), [])

    def test_outbox_to_group_for_one_to_one_question_rejected(self):
        self._prime(0)
        self._run([msg(rowid=21, guid="G-Q2", text="@ops what is due", handle=MIKE_PHONE,
                       is_from_me=1, chat_guid=ONE_TO_ONE)])
        before = list(self.sent)
        _append_jsonl(self.ops.outbox_file, {
            "reply_to": "G-Q2", "chat_guid": GROUP_GUID, "text": "leak", "ts": "x",
        })
        self._run([], clock=10_100.0)
        self.assertEqual(self.sent, before)
        out = [e for e in _events(self.config) if e.get("event") == "outbox"][-1]
        self.assertEqual(out["outcome"], "rejected")
        self.assertEqual(out["reason"], "wrong_chat_guid")

    def test_group_behavior_unchanged(self):
        self._prime(0)
        self._run([
            msg(rowid=30, guid="G-GRP", text="@dev test", handle="", is_from_me=1,
                chat_guid=ALIAS_GUID),
        ])
        self.assertEqual(self.sent, [(GROUP_GUID, "🤖 Dev: I'm here")])
        self._run([
            msg(rowid=31, guid="G-GRP-Q", text="@ops status please", handle="+15555550101",
                is_from_me=0, chat_guid=GROUP_GUID),
        ], clock=10_200.0)
        self.assertEqual(self.sent[-1], (GROUP_GUID, "🤖 Ops: on it"))
        pending = list_pending(self.config)
        self.assertEqual(pending[0]["chat_guid"], GROUP_GUID)
        _append_jsonl(self.ops.outbox_file, {
            "reply_to": "G-GRP-Q", "chat_guid": ALIAS_GUID, "text": "green", "ts": "x",
        })
        self._run([], clock=10_300.0)
        self.assertEqual(self.sent[-1], (GROUP_GUID, "🤖 Ops: green"))

    def test_self_loop_in_one_to_one_ignored(self):
        self._prime(0)
        self._run([
            msg(rowid=40, guid="G-BOT", text="🤖 Ops: on it @ops test", handle=MIKE_PHONE,
                is_from_me=1, chat_guid=ONE_TO_ONE),
            msg(rowid=41, guid="G-BOT2", text="🤖 Dev: I'm here", handle="",
                is_from_me=1, chat_guid=ONE_TO_ONE_ALIAS),
        ])
        self.assertEqual(self.sent, [])
        decs = [e["decisions"] for e in _events(self.config) if e.get("event") == "message"]
        self.assertTrue(all("self_loop_emoji_prefix" in d for d in decs))

    def test_unrouted_other_chat_not_watched(self):
        self._prime(0)
        self._run([msg(rowid=50, guid="G-X", text="@dev test", handle=MIKE_PHONE,
                       is_from_me=0, chat_guid="any;-;+15555550999")])
        self.assertEqual(self.sent, [])


if __name__ == "__main__":
    unittest.main()
