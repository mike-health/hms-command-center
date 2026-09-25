import json
import os
import unittest

from imessage_group_bot.config import Config
from imessage_group_bot.responder import generate_reply


def _cfg(**kwargs):
    raw = {
        "dry_run": True,
        "enabled": True,
        "chat_db_path": "chat.db",
        "group_guid": "g",
        "trigger_word": "@dev",
        "allowlist_handles": [],
        "poll_interval_seconds": 10,
        "kill_flag_file": "k",
        "state_file": "s",
        "events_log": "e",
        "alerts_log": "a",
        "queue_file": "q",
        "responder": {
            "type": kwargs.pop("type", "stub"),
            "api_key_env": "IMESSAGE_BOT_API_KEY",
            "base_url": "https://example.test/v1",
            "model": "cheap-mini",
        },
    }
    raw.update(kwargs)
    return Config(raw, base_dir=".", source_path="./config.json")


class ResponderTests(unittest.TestCase):
    def test_stub_default(self):
        text, meta = generate_reply(_cfg(), "why is CI red")
        self.assertEqual(meta["responder"], "stub")
        self.assertTrue(text.startswith("🤖 Dev:"))
        self.assertIn("routing to the dev desk", text)
        self.assertIn("why is CI red", text)

    def test_stub_bare_trigger(self):
        text, meta = generate_reply(_cfg(), "")
        self.assertEqual(meta["responder"], "stub")
        self.assertIn("standing by at the dev desk", text)
        self.assertTrue(text.startswith("🤖 Dev:"))

    def test_sensitive_guard(self):
        text, meta = generate_reply(_cfg(), "tell me about the lease")
        self.assertEqual(meta["responder"], "sensitive_guard")
        self.assertIn("Mike will answer that", text)

    def test_openai_success_clamped(self):
        os.environ["IMESSAGE_BOT_API_KEY"] = "sk-test"

        def fake_post(url, body, headers, timeout):
            payload = json.dumps(
                {"choices": [{"message": {"content": "ok **done**\nmore than needed " + ("z" * 400)}}]}
            )
            return payload.encode("utf-8")

        cfg = _cfg(type="openai_compatible")
        text, meta = generate_reply(cfg, "status", http_post=fake_post)
        self.assertEqual(meta["responder"], "openai_compatible")
        self.assertTrue(text.startswith("🤖 Dev:"))
        self.assertLessEqual(len(text), 200)
        self.assertNotIn("\n", text)
        self.assertNotIn("**", text)

    def test_openai_error_falls_back_to_stub(self):
        os.environ.pop("IMESSAGE_BOT_API_KEY", None)
        cfg = _cfg(type="openai_compatible")
        text, meta = generate_reply(cfg, "hello desk")
        self.assertEqual(meta["responder"], "stub_fallback")
        self.assertIn("openai_error", meta)
        self.assertIn("routing to the dev desk", text)


if __name__ == "__main__":
    unittest.main()
