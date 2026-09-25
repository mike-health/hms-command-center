from datetime import datetime, timezone
from io import StringIO
import os
import tempfile
import unittest

from helpers import GROUP_GUID, build_sqlite, write_config
from imessage_group_bot.cli import cmd_list_groups
from imessage_group_bot.config import load_config
from imessage_group_bot.guardrails import in_quiet_hours, rate_cap_decision
from imessage_group_bot.sender import applescript_for_send


class GuardrailUnitTests(unittest.TestCase):
    def test_quiet_hours_disabled_when_empty(self):
        ts = datetime(2026, 9, 26, 6, 30, tzinfo=timezone.utc).timestamp()
        self.assertFalse(in_quiet_hours(ts, "", "", "America/Los_Angeles"))

    def test_quiet_hours_overnight(self):
        ts = datetime(2026, 9, 26, 6, 30, tzinfo=timezone.utc).timestamp()
        self.assertTrue(in_quiet_hours(ts, "22:00", "08:00", "America/Los_Angeles"))
        day = datetime(2026, 9, 25, 20, 0, tzinfo=timezone.utc).timestamp()
        self.assertFalse(in_quiet_hours(day, "22:00", "08:00", "America/Los_Angeles"))

    def test_rate_caps(self):
        now = 10_000.0
        reason, _ = rate_cap_decision([now - 5], now, 20, 10, 40)
        self.assertEqual(reason, "min_interval")
        hour = [now - 10] * 10
        reason, _ = rate_cap_decision(hour, now, 0, 10, 40)
        self.assertEqual(reason, "hourly_cap")
        day = [now - 100] * 40
        reason, _ = rate_cap_decision(day, now, 0, 100, 40)
        self.assertEqual(reason, "daily_cap")


class ListGroupsCliTests(unittest.TestCase):
    def test_prints_guid_name_handles(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = os.path.join(tmp.name, "chat.db")
        build_sqlite(db_path, rows=[{"rowid": 1, "text": "hello"}])
        cfg = write_config(tmp.name)
        buf = StringIO()
        cmd_list_groups(cfg, out=buf)
        text = buf.getvalue()
        self.assertIn(GROUP_GUID, text)
        self.assertIn("Throwaway Test", text)
        self.assertIn("+15555550101", text)

    def test_example_config_is_dry_run(self):
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        cfg = load_config(os.path.join(root, "config.example.json"))
        self.assertTrue(cfg.dry_run)
        self.assertFalse(cfg.live_send_allowed(False))
        self.assertFalse(cfg.live_send_allowed(True))
        cfg.dry_run = False
        self.assertTrue(cfg.live_send_allowed(True))
        self.assertFalse(cfg.live_send_allowed(False))

    def test_applescript_quotes_text(self):
        script = applescript_for_send('iMessage;+;chatX', '🤖 Dev: hi "there"')
        self.assertIn("tell application \"Messages\"", script)
        self.assertIn("chat id", script)
        self.assertNotIn("osascript", script)


if __name__ == "__main__":
    unittest.main()
