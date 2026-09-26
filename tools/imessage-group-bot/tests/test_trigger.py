import unittest

from imessage_group_bot.guardrails import clamp_reply
from imessage_group_bot.trigger import (
    handle_allowed,
    is_self_loop_text,
    looks_sensitive,
    match_desk,
    parse_kill_command,
    trigger_match,
)


class TriggerTests(unittest.TestCase):
    def test_trigger_case_insensitive_prefix(self):
        self.assertEqual(trigger_match("@DEV please look", "@dev"), "please look")
        self.assertEqual(trigger_match("  @dev: ship it", "@dev"), "ship it")
        self.assertIsNone(trigger_match("@devastated", "@dev"))
        self.assertIsNone(trigger_match("hey @dev later", "@dev"))

    def test_self_loop_guard(self):
        self.assertTrue(is_self_loop_text("🤖 Dev: already me", "🤖 Dev:"))
        self.assertTrue(is_self_loop_text("🤖 other", "🤖 Dev:"))
        self.assertIsNone(trigger_match("🤖 Dev: @dev nested", "@dev", bot_prefix="🤖 Dev:"))

    def test_allowlist_mike_is_from_me(self):
        self.assertTrue(handle_allowed("", True, ["+15555550101"]))
        self.assertTrue(handle_allowed("+1 (555) 555-0101", False, ["+15555550101"]))
        self.assertTrue(handle_allowed("Todd@example.com", False, ["todd@example.com"]))
        self.assertFalse(handle_allowed("+15555550999", False, ["+15555550101"]))

    def test_kill_commands(self):
        self.assertEqual(parse_kill_command("stop"), "stop")
        self.assertEqual(parse_kill_command("START"), "start")
        self.assertIsNone(parse_kill_command("stop please"))

    def test_match_desk_ops_and_dev(self):
        from imessage_group_bot.config import Desk

        desks = [
            Desk("@dev", "🤖 Dev:", "q-dev", "o-dev", "stub"),
            Desk("@ops", "🤖 Ops:", "q-ops", "o-ops", "outbox"),
        ]
        desk, rest = match_desk("@OPS  status please", desks)
        self.assertEqual(desk.trigger_word, "@ops")
        self.assertEqual(rest, "status please")
        desk, rest = match_desk("@dev ship it", desks)
        self.assertEqual(desk.trigger_word, "@dev")
        self.assertEqual(rest, "ship it")
        desk, rest = match_desk("@devastated", desks)
        self.assertIsNone(desk)
        desk, rest = match_desk("🤖 Ops: already sent", desks)
        self.assertIsNone(desk)

    def test_sensitive_topics(self):
        self.assertTrue(looks_sensitive("what about the JV"))
        self.assertTrue(looks_sensitive("Ask Greene tomorrow"))
        self.assertFalse(looks_sensitive("please restart the build"))

    def test_200_char_clamp_and_prefix(self):
        body = "x" * 500
        out = clamp_reply(body, "🤖 Dev:", 200)
        self.assertTrue(out.startswith("🤖 Dev:"))
        self.assertLessEqual(len(out), 200)
        self.assertTrue(out.endswith("…"))
        self.assertNotIn("\n", clamp_reply("a\nb **bold**", "🤖 Dev:", 200))
        self.assertNotIn("**", clamp_reply("a\nb **bold**", "🤖 Dev:", 200))


if __name__ == "__main__":
    unittest.main()
