import unittest

from imessage_group_bot.guardrails import clamp_reply
from imessage_group_bot.trigger import (
    handle_allowed,
    is_health_check,
    is_self_loop_text,
    looks_sensitive,
    match_desk,
    match_kill_command,
    parse_kill_command,
    trigger_match,
)


class TriggerTests(unittest.TestCase):
    def test_trigger_case_insensitive_prefix(self):
        self.assertEqual(trigger_match("@DEV please look", "@dev"), "please look")
        self.assertEqual(trigger_match("  @dev: ship it", "@dev"), "ship it")
        self.assertIsNone(trigger_match("@devastated", "@dev"))
        self.assertEqual(trigger_match("hey @dev later", "@dev"), "later")

    def test_mid_sentence_requires_question_text(self):
        self.assertEqual(
            trigger_match("Hi rudy disregard this, it's just a test @ops test", "@ops"),
            "test",
        )
        self.assertIsNone(trigger_match("please look at @ops", "@ops"))
        self.assertIsNone(trigger_match("ping @OPS   ", "@ops"))
        self.assertIsNone(trigger_match("@ops", "@ops"))
        self.assertIsNone(trigger_match("@dev", "@dev"))

    def test_no_match_inside_email_handle_or_word(self):
        self.assertIsNone(trigger_match("email jim@dev.com please", "@dev"))
        self.assertIsNone(trigger_match("ping foo@ops", "@ops"))
        self.assertIsNone(trigger_match("see @devops later", "@dev"))
        self.assertIsNone(trigger_match("the @operations plan", "@ops"))
        self.assertIsNone(trigger_match("write @devastated notes", "@dev"))

    def test_self_loop_guard(self):
        self.assertTrue(is_self_loop_text("🤖 Dev: already me", "🤖 Dev:"))
        self.assertTrue(is_self_loop_text("🤖 other", "🤖 Dev:"))
        self.assertIsNone(trigger_match("🤖 Dev: @dev nested", "@dev", bot_prefix="🤖 Dev:"))

    def test_allowlist_mike_is_from_me(self):
        self.assertTrue(handle_allowed("", True, ["+15555550101"]))
        self.assertTrue(handle_allowed("+1 (555) 555-0101", False, ["+15555550101"]))
        self.assertTrue(handle_allowed("Todd@example.com", False, ["todd@example.com"]))
        self.assertFalse(handle_allowed("+15555550999", False, ["+15555550101"]))
        self.assertTrue(
            handle_allowed("+19169123214", False, [], owner_handle="+19169123214")
        )

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
        desk, rest = match_desk(
            "Hi rudy disregard this, it's just a test @ops test", desks
        )
        self.assertEqual(desk.trigger_word, "@ops")
        self.assertEqual(rest, "test")
        desk, rest = match_desk("ask @dev first then @ops second please", desks)
        self.assertEqual(desk.trigger_word, "@dev")
        self.assertEqual(rest, "first then @ops second please")
        desk, rest = match_desk("cc @ops now and @dev later too", desks)
        self.assertEqual(desk.trigger_word, "@ops")
        self.assertEqual(rest, "now and @dev later too")

    def test_kill_commands_remain_whole_message_only(self):
        from imessage_group_bot.config import Desk

        desks = [
            Desk("@dev", "🤖 Dev:", "q-dev", "o-dev", "stub"),
            Desk("@ops", "🤖 Ops:", "q-ops", "o-ops", "outbox"),
        ]
        desk, command = match_kill_command("@dev stop", desks)
        self.assertEqual(desk.trigger_word, "@dev")
        self.assertEqual(command, "stop")
        desk, command = match_kill_command("  @OPS: START  ", desks)
        self.assertEqual(desk.trigger_word, "@ops")
        self.assertEqual(command, "start")
        self.assertEqual(match_kill_command("Hi @ops stop", desks), (None, None))
        self.assertEqual(match_kill_command("please @dev start", desks), (None, None))
        self.assertEqual(match_kill_command("@dev stop please", desks), (None, None))
        self.assertIsNone(trigger_match("🤖 Dev: @dev stop", "@dev", bot_prefix="🤖 Dev:"))
        self.assertEqual(match_kill_command("🤖 Ops: @ops stop", desks), (None, None))

    def test_health_check_word(self):
        self.assertTrue(is_health_check("test"))
        self.assertTrue(is_health_check("  TEST  "))
        self.assertTrue(is_health_check("test."))
        self.assertTrue(is_health_check("test!?"))
        self.assertFalse(is_health_check("test the schedule"))
        self.assertFalse(is_health_check("testing"))
        self.assertFalse(is_health_check("stop"))
        self.assertFalse(is_health_check(""))
        self.assertFalse(is_health_check(None))

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
