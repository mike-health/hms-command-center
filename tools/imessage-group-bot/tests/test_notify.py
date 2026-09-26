import json
import os
import tempfile
import unittest
from io import StringIO

from helpers import FakeDB, GROUP_GUID, msg, write_config
from imessage_group_bot.cli import cmd_notify_test
from imessage_group_bot.engine import Engine
from imessage_group_bot.notify import (
    DEFAULT_ENV_FILE,
    format_github_comment,
    github_comment_argv,
    load_key_value_env,
    lookup_env,
    post_github_comment,
    post_webhook,
    resolve_gh_path,
    sample_payload,
)
from imessage_group_bot.state import already_answered, load_state, save_state


URL_ENV = "HMS_BOT_TEST_WEBHOOK_URL"
KEY_ENV = "HMS_BOT_TEST_WEBHOOK_KEY"


def _notify_block(**extra):
    block = {
        "url_env": URL_ENV,
        "key_env": KEY_ENV,
        "key_header": "Authorization",
        "key_prefix": "Bearer ",
        "timeout_seconds": 10,
    }
    block.update(extra)
    return block


class Recorder(object):
    def __init__(self, results=None):
        self.calls = []
        self.results = list(results if results is not None else [200])

    def __call__(self, url, body, headers, timeout):
        self.calls.append(
            {
                "url": url,
                "body": body,
                "headers": headers,
                "timeout": timeout,
                "payload": json.loads(body.decode("utf-8")),
            }
        )
        if not self.results:
            return 200
        item = self.results.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _events(config):
    if not os.path.exists(config.events_log):
        return []
    with open(config.events_log, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def _alerts(config):
    if not os.path.exists(config.alerts_log):
        return []
    with open(config.alerts_log, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def _ops(config):
    for desk in config.desks:
        if desk.trigger_word.strip().lower() == "@ops":
            return desk
    raise AssertionError("missing @ops desk")


class EnvFileTests(unittest.TestCase):
    def test_load_key_value_skips_comments(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = os.path.join(tmp.name, "webhook.env")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("# comment\n")
            handle.write("HMS_BOT_WEBHOOK_URL=https://example.test/hook\n")
            handle.write("HMS_BOT_WEBHOOK_KEY='secret-key'\n")
            handle.write("NOEQUALS\n")
            handle.write("\n")
        data = load_key_value_env(path)
        self.assertEqual(data["HMS_BOT_WEBHOOK_URL"], "https://example.test/hook")
        self.assertEqual(data["HMS_BOT_WEBHOOK_KEY"], "secret-key")
        self.assertNotIn("NOEQUALS", data)

    def test_lookup_env_prefers_process_env(self):
        file_map = {URL_ENV: "https://from-file"}
        got = lookup_env(URL_ENV, file_map, environ={URL_ENV: "https://from-env"})
        self.assertEqual(got, "https://from-env")
        self.assertEqual(lookup_env(URL_ENV, file_map, environ={}), "https://from-file")


class PostWebhookTests(unittest.TestCase):
    def test_retries_once_then_succeeds(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        os.environ[URL_ENV] = "https://example.test/hook"
        os.environ[KEY_ENV] = "k"
        self.addCleanup(lambda: os.environ.pop(URL_ENV, None))
        self.addCleanup(lambda: os.environ.pop(KEY_ENV, None))
        cfg = write_config(tmp.name, notify_webhook=_notify_block())
        rec = Recorder([RuntimeError("boom"), 204])
        sleeps = []
        status = post_webhook(cfg, {"desk": "@ops"}, http_post=rec, sleeper=sleeps.append)
        self.assertEqual(status, 204)
        self.assertEqual(len(rec.calls), 2)
        self.assertEqual(sleeps, [0.2])
        self.assertEqual(rec.calls[0]["headers"]["Authorization"], "Bearer k")
        self.assertEqual(rec.calls[0]["timeout"], 10)

    def test_http_error_retries_then_raises(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        os.environ[URL_ENV] = "https://example.test/hook"
        self.addCleanup(lambda: os.environ.pop(URL_ENV, None))
        cfg = write_config(tmp.name, notify_webhook=_notify_block())
        rec = Recorder([503, 503])
        with self.assertRaises(RuntimeError):
            post_webhook(cfg, {}, http_post=rec, sleeper=lambda _s: None)
        self.assertEqual(len(rec.calls), 2)


class NotifyEngineTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        os.environ[URL_ENV] = "https://example.test/hook"
        os.environ[KEY_ENV] = "test-key"
        self.config = write_config(
            self.tmpdir.name,
            notify_webhook=_notify_block(),
            max_reply_chars=500,
        )
        self.poster = Recorder()

    def tearDown(self):
        os.environ.pop(URL_ENV, None)
        os.environ.pop(KEY_ENV, None)
        self.tmpdir.cleanup()

    def _engine(self, messages, **kwargs):
        db = FakeDB(messages=messages, max_id=0)
        return Engine(
            self.config,
            live_flag=False,
            chat_db=db,
            send_fn=lambda *_a: (_ for _ in ()).throw(AssertionError("no send")),
            clock=lambda: 1_000_000.0,
            sleeper=lambda _s: None,
            webhook_post=kwargs.get("webhook_post", self.poster),
            gh_run=kwargs.get("gh_run"),
        )

    def _prime(self):
        state = load_state(self.config.state_file)
        state["high_water_rowid"] = 0
        save_state(self.config.state_file, state)

    def test_dev_and_ops_notify_with_ack_not_stub(self):
        self._prime()
        engine = self._engine(
            [
                msg(rowid=2, guid="G-DEV-2", text="@dev ship the build"),
                msg(rowid=3, guid="G-OPS-3", text="@ops is the studio up?"),
            ]
        )
        result = engine.process_once()
        self.assertEqual(result["replies"], 2)
        self.assertEqual(len(self.poster.calls), 2)
        payloads = [c["payload"] for c in self.poster.calls]
        desks = {p["desk"]: p for p in payloads}
        self.assertIn("@dev", desks)
        self.assertIn("@ops", desks)
        self.assertEqual(desks["@dev"]["question"], "ship the build")
        self.assertEqual(desks["@dev"]["reply_to"], "G-DEV-2")
        self.assertEqual(desks["@dev"]["chat_guid"], GROUP_GUID)
        self.assertEqual(desks["@dev"]["source_chat_guid"], GROUP_GUID)
        self.assertEqual(desks["@dev"]["trigger_text"], "@dev ship the build")
        self.assertEqual(desks["@dev"]["sender_handle"], "+15555550101")
        self.assertIn("ts", desks["@dev"])
        self.assertEqual(desks["@ops"]["reply_to"], "G-OPS-3")
        self.assertEqual(self.poster.calls[0]["headers"]["Authorization"], "Bearer test-key")
        events = [e for e in _events(self.config) if e.get("rowid") in (2, 3)]
        texts = {e["rowid"]: e.get("would_send") for e in events}
        self.assertEqual(texts[2], "🤖 Dev: on it")
        self.assertEqual(texts[3], "🤖 Ops: on it")
        self.assertNotIn("routing to the dev desk", texts[2] or "")
        state = load_state(self.config.state_file)
        self.assertFalse(already_answered(state, "G-DEV-2"))
        self.assertFalse(already_answered(state, "G-OPS-3"))

    def test_health_check_and_stop_do_not_notify(self):
        self._prime()
        engine = self._engine(
            [
                msg(rowid=4, guid="G-T", text="@ops test"),
                msg(rowid=5, guid="G-S", text="@dev stop", is_from_me=1, handle=""),
            ]
        )
        engine.process_once()
        self.assertEqual(self.poster.calls, [])
        with self.assertRaises(FileNotFoundError):
            open(_ops(self.config).queue_file, encoding="utf-8")

    def test_ack_on_queue_false_notifies_without_send(self):
        os.environ[URL_ENV] = "https://example.test/hook"
        self.config = write_config(
            self.tmpdir.name,
            notify_webhook=_notify_block(),
            ack_on_queue=False,
        )
        self._prime()
        engine = self._engine([msg(rowid=6, guid="G6", text="@dev please look")])
        result = engine.process_once()
        self.assertEqual(result["replies"], 0)
        self.assertEqual(len(self.poster.calls), 1)
        hit = [e for e in _events(self.config) if e.get("rowid") == 6][-1]
        self.assertIn("queued_for_webhook", hit["decisions"])
        self.assertNotIn("queue_ack", hit["decisions"])
        self.assertIsNone(hit.get("would_send"))

    def test_missing_webhook_keeps_stub(self):
        os.environ.pop(URL_ENV, None)
        os.environ.pop(KEY_ENV, None)
        self.config = write_config(self.tmpdir.name)
        self.assertFalse(self.config.notify_active())
        self._prime()
        poster = Recorder()
        engine = self._engine([msg(rowid=7, text="@dev ship it")], webhook_post=poster)
        engine.process_once()
        self.assertEqual(poster.calls, [])
        hit = [e for e in _events(self.config) if e.get("rowid") == 7][-1]
        self.assertIn("routing to the dev desk", hit["would_send"])

    def test_empty_url_behaves_as_today(self):
        os.environ[URL_ENV] = ""
        self.config = write_config(self.tmpdir.name, notify_webhook=_notify_block())
        self.assertFalse(self.config.notify_active())
        self._prime()
        poster = Recorder()
        engine = self._engine([msg(rowid=8, guid="G8", text="@ops ping")], webhook_post=poster)
        engine.process_once()
        self.assertEqual(poster.calls, [])
        hit = [e for e in _events(self.config) if e.get("rowid") == 8][-1]
        self.assertIn("queued_outbox", hit["decisions"])
        self.assertIsNone(hit["would_send"])

    def test_env_file_fallback(self):
        os.environ.pop(URL_ENV, None)
        os.environ.pop(KEY_ENV, None)
        env_path = os.path.join(self.tmpdir.name, DEFAULT_ENV_FILE)
        os.makedirs(os.path.dirname(env_path), exist_ok=True)
        with open(env_path, "w", encoding="utf-8") as handle:
            handle.write("%s=https://from-file.test/hook\n" % URL_ENV)
            handle.write("%s=file-key\n" % KEY_ENV)
        os.chmod(env_path, 0o600)
        self.config = write_config(self.tmpdir.name, notify_webhook=_notify_block())
        self.assertEqual(self.config.notify_url(), "https://from-file.test/hook")
        self.assertEqual(self.config.notify_key(), "file-key")
        self._prime()
        engine = self._engine([msg(rowid=9, guid="G9", text="@ops from file")])
        engine.process_once()
        self.assertEqual(len(self.poster.calls), 1)
        self.assertEqual(self.poster.calls[0]["url"], "https://from-file.test/hook")
        self.assertEqual(self.poster.calls[0]["headers"]["Authorization"], "Bearer file-key")

    def test_notify_failure_alerts_and_keeps_running(self):
        self._prime()
        poster = Recorder([RuntimeError("down"), RuntimeError("still down")])
        engine = self._engine(
            [
                msg(rowid=10, guid="G10", text="@ops first"),
                msg(rowid=11, guid="G11", text="@ops second"),
            ],
            webhook_post=poster,
        )
        result = engine.process_once()
        self.assertEqual(result["processed"], 2)
        self.assertGreaterEqual(len(poster.calls), 2)
        alerts = _alerts(self.config)
        self.assertTrue(any(a.get("event") == "notify_failed" for a in alerts))
        self.assertTrue(os.path.exists(_ops(self.config).queue_file))

    def test_outbox_after_ack_still_sends_multiline(self):
        self._prime()
        engine = self._engine([msg(rowid=12, guid="G12", text="@ops status please")])
        engine.process_once()
        ops = _ops(self.config)
        body = "Studio is up.\nNext: reboot at 02:00 (50%)."
        with open(ops.outbox_file, "a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "reply_to": "G12",
                        "chat_guid": GROUP_GUID,
                        "text": body,
                        "ts": "2026-09-26T21:00:00+00:00",
                    }
                )
            )
            handle.write("\n")
        engine.process_once()
        outbox_events = [e for e in _events(self.config) if e.get("event") == "outbox"]
        self.assertTrue(outbox_events)
        hit = outbox_events[-1]
        self.assertEqual(hit["outcome"], "sent")
        self.assertEqual(hit["would_send"], "🤖 Ops: Studio is up.\nNext: reboot at 02:00 (50%).")
        self.assertIn("\n", hit["would_send"])


class NotifyCliTests(unittest.TestCase):
    def test_notify_test_prints_status(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        os.environ[URL_ENV] = "https://example.test/hook"
        os.environ[KEY_ENV] = "k"
        self.addCleanup(lambda: os.environ.pop(URL_ENV, None))
        self.addCleanup(lambda: os.environ.pop(KEY_ENV, None))
        cfg = write_config(tmp.name, notify_webhook=_notify_block())
        rec = Recorder([201])
        buf = StringIO()
        code = cmd_notify_test(cfg, out=buf, http_post=rec)
        self.assertEqual(code, 0)
        self.assertIn("notify-test webhook HTTP 201", buf.getvalue())
        self.assertEqual(len(rec.calls), 1)
        payload = rec.calls[0]["payload"]
        self.assertEqual(payload["question"], "notify-test sample")
        self.assertEqual(payload["reply_to"], "notify-test-guid")
        sample = sample_payload(cfg)
        self.assertEqual(sample["desk"], "@ops")

    def test_notify_test_empty_url(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        os.environ.pop(URL_ENV, None)
        cfg = write_config(tmp.name, notify_webhook=_notify_block())
        buf = StringIO()
        code = cmd_notify_test(cfg, out=buf, http_post=Recorder())
        self.assertEqual(code, 1)
        self.assertIn("no transport", buf.getvalue())


class GhRecorder(object):
    def __init__(self, results=None):
        self.calls = []
        self.results = list(results if results is not None else [0])

    def __call__(self, argv, timeout):
        self.calls.append({"argv": argv, "timeout": timeout})
        if not self.results:
            return 0
        item = self.results.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _github_block(**extra):
    block = {
        "repo": "mike-health/hms-command-center",
        "pr": 19,
        "gh_path": "/opt/homebrew/bin/gh",
        "timeout_seconds": 15,
    }
    block.update(extra)
    return block


class GitHubNotifyTests(unittest.TestCase):
    def test_resolve_gh_path_uses_absolute_config(self):
        self.assertEqual(resolve_gh_path("/opt/homebrew/bin/gh"), "/opt/homebrew/bin/gh")
        self.assertEqual(resolve_gh_path("/usr/local/bin/gh"), "/usr/local/bin/gh")

    def test_comment_body_has_human_line_and_json_fence(self):
        payload = {
            "desk": "@ops",
            "question": "is the studio up?",
            "trigger_text": "@ops is the studio up?",
            "reply_to": "G1",
            "chat_guid": GROUP_GUID,
            "source_chat_guid": GROUP_GUID,
            "sender_handle": "+15555550101",
            "ts": "2026-09-26T23:00:00+00:00",
        }
        body = format_github_comment(payload)
        self.assertIn("HMS bot queued @ops from +15555550101", body)
        self.assertIn("is the studio up?", body)
        self.assertIn("```json", body)
        self.assertIn('"reply_to": "G1"', body)
        test_body = format_github_comment(payload, test=True)
        self.assertTrue(test_body.startswith("TEST"))
        self.assertIn("notify-test", test_body.lower())

    def test_gh_argv_and_retry(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cfg = write_config(tmp.name, notify_github=_github_block())
        rec = GhRecorder([RuntimeError("boom"), 0])
        sleeps = []
        post_github_comment(cfg, {"desk": "@ops", "question": "q"}, gh_run=rec, sleeper=sleeps.append)
        self.assertEqual(len(rec.calls), 2)
        self.assertEqual(sleeps, [0.2])
        argv = rec.calls[0]["argv"]
        self.assertEqual(argv[0], "/opt/homebrew/bin/gh")
        self.assertEqual(argv[1], "api")
        self.assertEqual(
            argv[2],
            "repos/mike-health/hms-command-center/issues/19/comments",
        )
        self.assertEqual(argv[3], "-f")
        self.assertTrue(argv[4].startswith("body="))
        self.assertEqual(rec.calls[0]["timeout"], 15)

    def test_github_only_acks_and_skips_stub(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cfg = write_config(tmp.name, notify_github=_github_block(), max_reply_chars=500)
        self.assertTrue(cfg.notify_active())
        self.assertTrue(cfg.notify_github_active())
        rec = GhRecorder()
        poster = Recorder()
        state = load_state(cfg.state_file)
        state["high_water_rowid"] = 0
        save_state(cfg.state_file, state)
        engine = Engine(
            cfg,
            chat_db=FakeDB(
                messages=[msg(rowid=2, guid="G-DEV-2", text="@dev ship the build")],
                max_id=0,
            ),
            send_fn=lambda *_a: (_ for _ in ()).throw(AssertionError("no send")),
            clock=lambda: 1_000_000.0,
            sleeper=lambda _s: None,
            webhook_post=poster,
            gh_run=rec,
        )
        result = engine.process_once()
        self.assertEqual(result["replies"], 1)
        self.assertEqual(poster.calls, [])
        self.assertEqual(len(rec.calls), 1)
        body = rec.calls[0]["argv"][4]
        self.assertIn("ship the build", body)
        self.assertIn("G-DEV-2", body)
        self.assertTrue(body.startswith("body=HMS bot queued"))
        self.assertNotIn("do not treat as a real queue item", body)
        hit = [e for e in _events(cfg) if e.get("rowid") == 2][-1]
        self.assertEqual(hit["would_send"], "🤖 Dev: on it")
        self.assertIn("queued_for_github", hit["decisions"])
        self.assertNotIn("routing to the dev desk", hit["would_send"])
        self.assertFalse(already_answered(load_state(cfg.state_file), "G-DEV-2"))

    def test_health_check_does_not_comment(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cfg = write_config(tmp.name, notify_github=_github_block())
        rec = GhRecorder()
        state = load_state(cfg.state_file)
        state["high_water_rowid"] = 0
        save_state(cfg.state_file, state)
        engine = Engine(
            cfg,
            chat_db=FakeDB(messages=[msg(rowid=4, guid="G-T", text="@ops test")], max_id=0),
            send_fn=lambda *_a: (_ for _ in ()).throw(AssertionError("no send")),
            clock=lambda: 1_000_000.0,
            sleeper=lambda _s: None,
            gh_run=rec,
        )
        engine.process_once()
        self.assertEqual(rec.calls, [])

    def test_github_failure_alerts_and_keeps_running(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cfg = write_config(tmp.name, notify_github=_github_block())
        rec = GhRecorder([RuntimeError("down"), RuntimeError("still down")])
        state = load_state(cfg.state_file)
        state["high_water_rowid"] = 0
        save_state(cfg.state_file, state)
        engine = Engine(
            cfg,
            chat_db=FakeDB(
                messages=[
                    msg(rowid=10, guid="G10", text="@ops first"),
                    msg(rowid=11, guid="G11", text="@ops second"),
                ],
                max_id=0,
            ),
            send_fn=lambda *_a: (_ for _ in ()).throw(AssertionError("no send")),
            clock=lambda: 1_000_000.0,
            sleeper=lambda _s: None,
            gh_run=rec,
        )
        result = engine.process_once()
        self.assertEqual(result["processed"], 2)
        self.assertGreaterEqual(len(rec.calls), 2)
        alerts = _alerts(cfg)
        self.assertTrue(any(a.get("transport") == "github" for a in alerts))

    def test_webhook_and_github_both_fire(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        os.environ[URL_ENV] = "https://example.test/hook"
        os.environ[KEY_ENV] = "k"
        self.addCleanup(lambda: os.environ.pop(URL_ENV, None))
        self.addCleanup(lambda: os.environ.pop(KEY_ENV, None))
        cfg = write_config(
            tmp.name,
            notify_webhook=_notify_block(),
            notify_github=_github_block(),
        )
        poster = Recorder()
        rec = GhRecorder()
        state = load_state(cfg.state_file)
        state["high_water_rowid"] = 0
        save_state(cfg.state_file, state)
        engine = Engine(
            cfg,
            chat_db=FakeDB(messages=[msg(rowid=3, guid="G3", text="@ops both")], max_id=0),
            send_fn=lambda *_a: (_ for _ in ()).throw(AssertionError("no send")),
            clock=lambda: 1_000_000.0,
            sleeper=lambda _s: None,
            webhook_post=poster,
            gh_run=rec,
        )
        engine.process_once()
        self.assertEqual(len(poster.calls), 1)
        self.assertEqual(len(rec.calls), 1)

    def test_notify_test_posts_labeled_github_comment(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cfg = write_config(tmp.name, notify_github=_github_block())
        rec = GhRecorder()
        buf = StringIO()
        code = cmd_notify_test(cfg, out=buf, gh_run=rec)
        self.assertEqual(code, 0)
        self.assertIn("notify-test github comment posted", buf.getvalue())
        self.assertIn("#19", buf.getvalue())
        self.assertEqual(len(rec.calls), 1)
        body = rec.calls[0]["argv"][4]
        self.assertTrue(body.startswith("body=TEST"))
        argv = github_comment_argv(cfg, sample_payload(cfg), test=True)
        self.assertIn("TEST", argv[4])


if __name__ == "__main__":
    unittest.main()
