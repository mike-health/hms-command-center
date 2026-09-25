import unittest

from imessage_group_bot.guardrails import clamp_reply
from imessage_group_bot.trigger import (
    handle_allowed,
    is_self_loop_text,
    looks_sensitive,
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
        self.assertTrue(is_self_loop_text("🤖 Dev: already me"))
        self.assertIsNone(trigger_match("🤖 Dev: @dev nested", "@dev"))

    def test_allowlist_mike_is_from_me(self):
        self.assertTrue(handle_allowed("", True, ["+15555550101"]))
        self.assertTrue(handle_allowed("+1 (555) 555-0101", False, ["+15555550101"]))
        self.assertTrue(handle_allowed("Todd@example.com", False, ["todd@example.com"]))
        self.assertFalse(handle_allowed("+15555550999", False, ["+15555550101"]))

    def test_kill_commands(self):
        self.assertEqual(parse_kill_command("stop"), "stop")
        self.assertEqual(parse_kill_command("START"), "start")
        self.assertIsNone(parse_kill_command("stop please"))

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
