"""Pleasant Hill Linear desk: Q&A, proposals, confirms. Uses a mock client."""

from datetime import datetime
import json
import os
import tempfile
import unittest

from helpers import FakeDB, msg, write_config
from imessage_group_bot.engine import Engine
from imessage_group_bot.linear_client import MockLinearClient, title_in_scope
from imessage_group_bot.linear_desk import (
    handle_linear,
    parse_date_token,
    parse_intent,
    strip_dollars,
    strip_owner_suffix,
)
from imessage_group_bot.state import load_state, save_state


def _la_ts(year, month, day, hour=12, minute=0):
    from zoneinfo import ZoneInfo

    return datetime(year, month, day, hour, minute, tzinfo=ZoneInfo("America/Los_Angeles")).timestamp()


def fixture_issues():
    """Synthetic Pleasant Hill issues (fake ids, no URLs or paths)."""
    return [
        _iss("id-34", "PH-34", "Pleasant Hill: owner + architect call", "2026-10-09", "Mike Greenhalgh", ["Mike"]),
        _iss("id-35", "PH-35", "Pleasant Hill: Todd advance + Leddy survey + architect measure", "2026-10-15", "", ["Todd", "Leddy"]),
        _iss(
            "id-36",
            "PH-36",
            "Pleasant Hill: travel budget + cadence $1,200 estimate",
            "2026-10-01",
            "Mike Greenhalgh",
            ["Mike"],
            description="quote 1200 USD plus 1.2k USD leftover",
        ),
        _iss("id-quotes", "PH-202", "Pleasant Hill: Leddy equipment spec + lead-time quotes", "2026-10-23", "", ["Leddy"]),
        _iss("id-layout", "PH-203", "Pleasant Hill: layout freeze (SD sign-off)", "2026-11-13", "", ["Todd"]),
        _iss("id-permit", "PH-204", "Pleasant Hill: permit submittal (full commercial TI)", "2026-12-11", "", ["Todd"]),
        _iss("id-install", "PH-205", "Pleasant Hill: chamber set + plant install", "2027-04-16", "", ["Leddy"]),
        _iss("id-first", "PH-206", "Pleasant Hill: training drills first patient", "2027-05-17", "", ["Rudy"]),
        _iss("id-survey2", "PH-207", "Pleasant Hill: extra survey photos", "2026-10-21", "", ["Todd"]),
        _iss("id-done", "PH-33", "Pleasant Hill: intake diagrams", "2026-09-25", "", ["Mike"], state="completed"),
    ]


def _iss(iid, ident, title, due, assignee, labels, state="unstarted", description="", project=""):
    return {
        "id": iid,
        "identifier": ident,
        "title": title,
        "description": description,
        "dueDate": due,
        "assignee_name": assignee,
        "labels": labels,
        "state_name": state,
        "state_type": state,
        "project": project,
    }


CODE = "7K2P"


class LinearDeskTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.config = write_config(
            self.tmpdir.name,
            linear={
                "allow_writes": False,
                "confirm_from_me": True,
                "confirm_handles": ["+15555550101", "todd@example.com"],
                "proposal_ttl_seconds": 86400,
                "title_prefix": "Pleasant Hill:",
                "project_name": "Clinic Development - Todd",
                "team_key": "HEA",
            },
        )
        self.client = MockLinearClient(fixture_issues())
        self.now = _la_ts(2026, 10, 14)
        self.state = {"linear_proposals": []}

    def tearDown(self):
        self.tmpdir.cleanup()

    def _handle(self, rest, sender=None, client=None, now=None, state=None):
        message = sender or msg(rowid=1, text="@dev " + rest, handle="+15555550101")
        return handle_linear(
            self.config,
            rest,
            message,
            state if state is not None else self.state,
            now if now is not None else self.now,
            client or self.client,
            events_log=self.config.events_log,
            code_factory=lambda: CODE,
        )

    def test_parse_intents_and_dates(self):
        self.assertEqual(parse_intent("what's next on Pleasant Hill")["type"], "next")
        self.assertEqual(parse_intent("what's the next gate on Pleasant Hill")["type"], "next_gate")
        self.assertEqual(parse_intent("what's late on Pleasant Hill")["type"], "late")
        self.assertEqual(parse_intent("what's Leddy doing this week")["who"].lower(), "leddy")
        self.assertEqual(parse_intent("survey moved to 10/20")["type"], "date_change")
        self.assertEqual(parse_intent("confirm %s" % CODE)["code"], CODE)
        self.assertIsNone(parse_intent("confirm 7K"))
        self.assertIsNone(parse_intent("ship the build"))
        ref = datetime(2026, 10, 14).date()
        self.assertEqual(str(parse_date_token("10/20", ref)), "2026-10-20")
        self.assertEqual(str(parse_date_token("Oct 20", ref)), "2026-10-20")

    def test_next_and_no_dollars(self):
        reply, meta = self._handle("what's next on Pleasant Hill")
        self.assertEqual(meta["kind"], "next")
        self.assertIn("PH-35", reply)
        self.assertNotIn("$", reply)
        self.assertNotIn("1200", reply)
        self.assertTrue(reply.startswith("🤖 Dev:"))
        self.assertLessEqual(len(reply), 200)
        self.assertNotIn("\n", reply)

    def test_late_filter(self):
        reply, meta = self._handle("what's late on Pleasant Hill")
        self.assertEqual(meta["kind"], "late")
        self.assertIn("PH-36", reply)
        self.assertIn("PH-34", reply)
        self.assertNotIn("$", reply)
        self.assertNotIn("1200", reply)

    def test_owner_week_leddy(self):
        reply, meta = self._handle("what's Leddy doing this week")
        self.assertEqual(meta["kind"], "owner_week")
        self.assertIn("PH-35", reply)
        self.assertNotIn("PH-202", reply)
        self.assertNotIn("PH-205", reply)

    def test_completed_issues_excluded(self):
        reply, _meta = self._handle("what's late on Pleasant Hill")
        self.assertNotIn("PH-33", reply)

    def test_date_parse_unique_proposal(self):
        reply, meta = self._handle("layout freeze moved to 11/20")
        self.assertEqual(meta["kind"], "proposal")
        self.assertEqual(meta["code"], CODE)
        self.assertIn("PH-203", reply)
        self.assertIn(CODE, reply)
        self.assertIn("->", reply)
        self.assertIn("(expires 24h)", reply)
        pending = self.state["linear_proposals"][-1]
        self.assertEqual(pending["new_due"], "2026-11-20")
        self.assertEqual(pending["old_due"], "2026-11-13")

    def test_ambiguity_asks_instead_of_guessing(self):
        reply, meta = self._handle("survey moved to 10/20")
        self.assertEqual(meta["kind"], "date_ambiguous")
        self.assertIn("PH-35", reply)
        self.assertIn("PH-207", reply)
        self.assertFalse(self.state["linear_proposals"])

    def test_confirm_mike_dry_run_does_not_write(self):
        self._handle("layout freeze moved to 11/20")
        mike = msg(rowid=2, text="@dev confirm 7K2P", is_from_me=1, handle="")
        reply, meta = handle_linear(
            self.config,
            "confirm 7K2P",
            mike,
            self.state,
            self.now,
            self.client,
            events_log=self.config.events_log,
        )
        self.assertEqual(meta["kind"], "confirm")
        self.assertFalse(meta["wrote"])
        self.assertNotIn("pending_linear_write", meta)
        self.assertEqual(self.client.update_calls, [])
        self.assertIn("not written", reply)
        self.assertIn("->", reply)
        events = _read_events(self.config.events_log)
        kinds = [e.get("event") for e in events]
        self.assertIn("linear_proposal", kinds)
        self.assertIn("linear_write_blocked", kinds)
        self.assertIn("linear_confirm", kinds)
        blocked = [e for e in events if e.get("event") == "linear_write_blocked"][0]
        self.assertEqual(blocked["would_mutate"]["input"]["dueDate"], "2026-11-20")
        self.assertIn("dry_run", blocked["reason"])

    def test_confirm_todd_allowed_rudy_rejected(self):
        self._handle("permit submittal moved to 1/8")
        todd = msg(rowid=3, text="@dev confirm 7K2P", handle="todd@example.com", is_from_me=0)
        _reply, meta = handle_linear(
            self.config, "confirm 7K2P", todd, self.state, self.now, self.client,
            events_log=self.config.events_log,
        )
        self.assertEqual(meta["kind"], "confirm")
        self.assertEqual(self.client.update_calls, [])

        self.state = {"linear_proposals": []}
        self.client = MockLinearClient(fixture_issues())
        self._handle("permit submittal moved to 1/8")
        rudy = msg(rowid=4, text="@dev confirm 7K2P", handle="+15555550102", is_from_me=0)
        reply, meta = handle_linear(
            self.config, "confirm 7K2P", rudy, self.state, self.now, self.client,
            events_log=self.config.events_log,
        )
        self.assertEqual(meta["kind"], "confirm_rejected")
        self.assertIn("Mike or Todd", reply)
        self.assertEqual(self.client.update_calls, [])
        events = _read_events(self.config.events_log)
        self.assertTrue(any(e.get("event") == "linear_confirm_rejected" for e in events))

    def test_expiry(self):
        self._handle("layout freeze moved to 11/20")
        later = self.now + 86400 + 10
        mike = msg(rowid=5, text="@dev confirm 7K2P", is_from_me=1, handle="")
        reply, meta = handle_linear(
            self.config, "confirm 7K2P", mike, self.state, later, self.client,
            events_log=self.config.events_log,
        )
        self.assertEqual(meta["kind"], "confirm_expired")
        self.assertIn("expired", reply)
        events = _read_events(self.config.events_log)
        self.assertTrue(any(e.get("event") == "linear_proposal_expired" for e in events))
        self.assertEqual(self.client.update_calls, [])

    def test_write_blocked_without_live_even_if_not_dry_run(self):
        from imessage_group_bot.linear_desk import apply_pending_linear_write

        self.config.dry_run = False
        self.config.linear_allow_writes = True
        self._handle("layout freeze moved to 11/20")
        mike = msg(rowid=6, text="@dev confirm 7K2P", is_from_me=1, handle="")
        reply, meta = handle_linear(
            self.config, "confirm 7K2P", mike, self.state, self.now, self.client,
            events_log=self.config.events_log,
            live_flag=False,
        )
        self.assertFalse(meta["wrote"])
        self.assertEqual(self.client.update_calls, [])
        self.assertIn("not written", reply)
        events = _read_events(self.config.events_log)
        blocked = [e for e in events if e.get("event") == "linear_write_blocked"][-1]
        self.assertIn("missing_live_flag", blocked["reason"])

        self.state = {"linear_proposals": []}
        self.client = MockLinearClient(fixture_issues())
        self._handle("layout freeze moved to 11/20")
        reply, meta = handle_linear(
            self.config, "confirm 7K2P", mike, self.state, self.now, self.client,
            events_log=self.config.events_log,
            live_flag=True,
        )
        self.assertFalse(meta["wrote"])
        self.assertTrue(meta.get("pending_linear_write"))
        self.assertEqual(self.client.update_calls, [])
        meta = apply_pending_linear_write(
            self.client, self.state, meta, self.config.events_log, self.now
        )
        self.assertTrue(meta["wrote"])
        self.assertEqual(self.client.update_calls, [{"id": "id-layout", "dueDate": "2026-11-20"}])
        self.assertIn("updated PH-203", reply)
        self.assertIn("->", reply)
        self.assertNotIn("$", reply)

    def test_strip_dollars(self):
        samples = [
            "order chambers $1,200 now",
            "quote 1200 USD please",
            "also 1,200 usd and 1.2k USD",
            "cost $1.2k extra",
            "budget €500 and £80",
        ]
        for sample in samples:
            cleaned = strip_dollars(sample)
            self.assertNotIn("$", cleaned)
            self.assertNotIn("€", cleaned)
            self.assertNotIn("£", cleaned)
            self.assertNotIn("1200", cleaned)
            self.assertNotIn("1.2k", cleaned.lower())
            self.assertNotRegex(cleaned, r"(?i)\busd\b")
        leftover = strip_dollars("order chambers $1.2k now")
        self.assertNotIn("k", leftover.lower())
        self.assertIn("order chambers", leftover)
        extra = [
            ("cost $1.2 million extra", ("million", "1.2", "$")),
            ("about 2 thousand units", ("thousand",)),
            ("cap 1 billion USD", ("billion", "USD")),
            ("pay 1200$ today", ("1200", "$")),
            ("invoice US$1,200 due", ("US", "1200", "$")),
            ("fee 20% now", ("20%", "%", "20")),
            ("spread 2.5% wide", ("2.5%", "%", "2.5")),
            ("up 15 percent this week", ("percent", "15")),
        ]
        for sample, banned in extra:
            cleaned = strip_dollars(sample)
            cleaned_l = cleaned.lower()
            for token in banned:
                self.assertNotIn(token.lower(), cleaned_l, sample)
        money_issue = [i for i in fixture_issues() if i["identifier"] == "PH-36"][0]
        from imessage_group_bot.guardrails import clamp_reply

        for blob in (
            money_issue["title"],
            money_issue["description"],
            "can we spend $1,200",
            "US$1,200 at 20%",
            "$1.2 million and 1200$",
        ):
            out = clamp_reply(blob, "🤖 Dev:", 200)
            self.assertNotIn("$", out)
            self.assertNotIn("1200", out)
            self.assertNotIn("USD", out)
            self.assertNotIn("million", out.lower())
            self.assertNotIn("%", out)
            self.assertNotIn("percent", out.lower())
            self.assertNotRegex(out, r"\bUS\b")

    def test_engine_dry_run_question(self):
        self.config.linear_confirm_handles = ["+15555550101"]
        engine = Engine(
            self.config,
            live_flag=False,
            chat_db=FakeDB(
                messages=[msg(rowid=9, text="@dev what's next on Pleasant Hill")],
                max_id=0,
            ),
            send_fn=lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("no send")),
            clock=lambda: self.now,
            sleeper=lambda _s: None,
            linear_client=self.client,
        )
        save_state(self.config.state_file, {"high_water_rowid": 0, "processed": [], "send_times": []})
        engine.process_once()
        with open(self.config.events_log, encoding="utf-8") as handle:
            events = [json.loads(line) for line in handle if line.strip()]
        hit = [e for e in events if e.get("rowid") == 9][-1]
        self.assertIn("osascript_not_invoked", hit["decisions"])
        self.assertIn("PH-35", hit["would_send"])
        self.assertNotIn("$", hit["would_send"] or "")

    def test_linear_error_is_generic(self):
        from imessage_group_bot.linear_client import LinearError

        class Boom(object):
            def list_issues(self, *_a, **_k):
                raise LinearError("secret token xyz from GraphQL")

        reply, meta = self._handle("what's next on Pleasant Hill", client=Boom())
        self.assertEqual(meta["responder"], "linear_error")
        self.assertNotIn("secret", reply.lower())
        self.assertNotIn("GraphQL", reply)
        self.assertIn("Check the log", reply)
        events = _read_events(self.config.events_log)
        self.assertTrue(any("secret token xyz" in (e.get("error") or "") for e in events))


PREFIX = "Pleasant Hill:"
CLINIC = "Clinic Development - Todd"
SUPERVISION = "Supervision Standard Rollout"


def scoped_issues():
    """Small synthetic fixture: fake names, no URLs, no amounts, no home paths."""
    return [
        _iss(
            "id-pleasonton",
            "PX-1",
            "Pleasanton: intake site diagrams",
            "2026-09-24",
            "Alex",
            [],
            state="completed",
            project=CLINIC,
        ),
        _iss(
            "id-px2",
            "PX-2",
            "Pleasanton: travel budget",
            "2026-10-01",
            "Alex",
            [],
            project=CLINIC,
        ),
        _iss(
            "id-35",
            "PH-35",
            "Pleasant Hill: Todd advance + Leddy survey + architect field measure (Owner: Todd)",
            "2026-10-14",
            "",
            [],
            project=CLINIC,
        ),
        _iss(
            "id-sv1",
            "PH-91",
            "Bring Pleasant Hill to supervision standard",
            "2027-05-14",
            "",
            [],
            project=SUPERVISION,
        ),
        _iss(
            "id-sv2",
            "PH-100",
            "Pleasant Hill: people and certifications",
            "2027-04-02",
            "",
            [],
            project=SUPERVISION,
        ),
        _iss(
            "id-m1",
            "PH-G1",
            "Pleasant Hill: M1 — agreement signed",
            "2026-11-06",
            "Alex",
            [],
            project=CLINIC,
        ),
        _iss(
            "id-m2",
            "PH-G2",
            "Pleasant Hill: M2 — equipment delivered (Owner: Leddy)",
            "2027-03-19",
            "",
            [],
            project=CLINIC,
        ),
        _iss(
            "id-m3",
            "PH-G3",
            "Pleasant Hill: M3 — rough-in complete (Owner: Todd)",
            "2027-03-26",
            "",
            [],
            project=CLINIC,
        ),
        _iss(
            "id-m4",
            "PH-G4",
            "Pleasant Hill: M4 — commissioning (Owner: Leddy)",
            "2027-05-07",
            "",
            [],
            project=CLINIC,
        ),
    ]


class ScopedLinearTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.config = write_config(
            self.tmpdir.name,
            linear={
                "allow_writes": False,
                "confirm_from_me": True,
                "confirm_handles": ["+15555550101"],
                "proposal_ttl_seconds": 86400,
                "title_prefix": PREFIX,
                "team_key": "HEA",
            },
        )
        self.issues = scoped_issues()
        self.client = MockLinearClient(self.issues)
        self.now = _la_ts(2026, 10, 14)
        self.state = {"linear_proposals": []}

    def tearDown(self):
        self.tmpdir.cleanup()

    def _handle(self, rest):
        message = msg(rowid=1, text="@dev " + rest, handle="+15555550101")
        return handle_linear(
            self.config,
            rest,
            message,
            self.state,
            self.now,
            self.client,
            events_log=self.config.events_log,
        )

    def test_fixture_scope_includes_supervision_excludes_pleasanton(self):
        listed = self.client.list_issues("HEA", self.config.linear_project_names, PREFIX)
        ids = {item["identifier"] for item in listed}
        self.assertIn("PH-91", ids)
        self.assertIn("PH-100", ids)
        self.assertIn("PH-35", ids)
        self.assertIn("PH-G1", ids)
        self.assertNotIn("PX-1", ids)
        self.assertNotIn("PX-2", ids)
        self.assertTrue(title_in_scope("Bring Pleasant Hill to supervision standard", PREFIX))
        self.assertFalse(title_in_scope("Pleasanton: intake site diagrams", PREFIX))

        clinic_only = MockLinearClient(self.issues).list_issues("HEA", [CLINIC], PREFIX)
        clinic_ids = {item["identifier"] for item in clinic_only}
        self.assertNotIn("PH-91", clinic_ids)
        self.assertNotIn("PH-100", clinic_ids)
        self.assertIn("PH-G1", clinic_ids)

    def test_next_gate_is_m1_then_m2(self):
        reply, meta = self._handle("what's the next gate on Pleasant Hill")
        self.assertEqual(meta["kind"], "next_gate")
        self.assertEqual(meta["gate"], 1)
        self.assertIn("PH-G1", reply)
        self.assertIn("M1", reply)
        self.assertNotIn("(Owner:", reply)
        self.assertTrue(reply.startswith("🤖 Dev:"))
        self.assertLessEqual(len(reply), 200)

        for item in self.client.issues:
            if item["identifier"] == "PH-G1":
                item["state_type"] = "completed"
        reply, meta = self._handle("what's the next gate on Pleasant Hill")
        self.assertEqual(meta["gate"], 2)
        self.assertIn("PH-G2", reply)
        self.assertIn("M2", reply)
        self.assertNotIn("(Owner:", reply)

    def test_leddy_owner_from_title_without_assignee(self):
        ph35 = [i for i in self.issues if i["identifier"] == "PH-35"][0]
        self.assertEqual(ph35["assignee_name"], "")
        self.assertIn("(Owner: Todd)", ph35["title"])
        reply, meta = self._handle("what's Leddy doing this week")
        self.assertEqual(meta["kind"], "owner_week")
        self.assertIn("PH-35", reply)
        self.assertNotIn("(Owner:", reply)
        self.assertEqual(
            strip_owner_suffix(ph35["title"]),
            "Pleasant Hill: Todd advance + Leddy survey + architect field measure",
        )

    def test_replies_strip_owner_suffix(self):
        reply, _meta = self._handle("what's Todd doing this week")
        self.assertIn("PH-35", reply)
        self.assertNotIn("(Owner:", reply)
        reply, _meta = self._handle("what's next on Pleasant Hill")
        self.assertNotIn("(Owner:", reply)
        self.assertNotIn("$", reply)


def _read_events(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


if __name__ == "__main__":
    unittest.main()
