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
    """Synthetic Pleasant Hill issues from the 2026-09-29 timeline draft."""
    return [
        _iss("id-34", "HEA-34", "Pleasant Hill: owner + architect call (Dr. Son, Andrew)", "2026-10-09", "Mike Greenhalgh", ["Mike"]),
        _iss("id-35", "HEA-35", "Pleasant Hill: Todd advance + Leddy survey + architect measure", "2026-10-15", "", ["Todd", "Leddy"]),
        _iss("id-36", "HEA-36", "Pleasant Hill: travel budget + cadence $1200 estimate", "2026-10-01", "Mike Greenhalgh", ["Mike"]),
        _iss("id-quotes", "HEA-202", "Pleasant Hill: Leddy equipment spec + lead-time quotes", "2026-10-23", "", ["Leddy"]),
        _iss("id-layout", "HEA-203", "Pleasant Hill: layout freeze (SD sign-off)", "2026-11-13", "", ["Todd"]),
        _iss("id-permit", "HEA-204", "Pleasant Hill: permit submittal (full commercial TI)", "2026-12-11", "", ["Todd"]),
        _iss("id-install", "HEA-205", "Pleasant Hill: chamber set + plant install", "2027-04-16", "", ["Leddy"]),
        _iss("id-first", "HEA-206", "Pleasant Hill: training drills first patient", "2027-05-17", "", ["Rudy"]),
        _iss("id-survey2", "HEA-207", "Pleasant Hill: extra survey photos", "2026-10-21", "", ["Todd"]),
        _iss("id-done", "HEA-33", "Pleasant Hill: intake Andrew diagrams", "2026-09-25", "", ["Mike"], state="completed"),
    ]


def _iss(iid, ident, title, due, assignee, labels, state="unstarted"):
    return {
        "id": iid,
        "identifier": ident,
        "title": title,
        "description": "",
        "dueDate": due,
        "assignee_name": assignee,
        "labels": labels,
        "state_name": state,
        "state_type": state,
    }


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
            code_factory=lambda: "7K",
        )

    def test_parse_intents_and_dates(self):
        self.assertEqual(parse_intent("what's next on Pleasant Hill")["type"], "next")
        self.assertEqual(parse_intent("what's the next gate on Pleasant Hill")["type"], "next_gate")
        self.assertEqual(parse_intent("what's late on Pleasant Hill")["type"], "late")
        self.assertEqual(parse_intent("what's Leddy doing this week")["who"].lower(), "leddy")
        self.assertEqual(parse_intent("survey moved to 10/20")["type"], "date_change")
        self.assertEqual(parse_intent("confirm 7K")["code"], "7K")
        self.assertIsNone(parse_intent("ship the build"))
        ref = datetime(2026, 10, 14).date()
        self.assertEqual(str(parse_date_token("10/20", ref)), "2026-10-20")
        self.assertEqual(str(parse_date_token("Oct 20", ref)), "2026-10-20")

    def test_next_and_no_dollars(self):
        reply, meta = self._handle("what's next on Pleasant Hill")
        self.assertEqual(meta["kind"], "next")
        self.assertIn("HEA-35", reply)
        self.assertNotIn("$", reply)
        self.assertNotIn("1200", reply)
        self.assertTrue(reply.startswith("🤖 Dev:"))
        self.assertLessEqual(len(reply), 200)
        self.assertNotIn("\n", reply)

    def test_late_filter(self):
        reply, meta = self._handle("what's late on Pleasant Hill")
        self.assertEqual(meta["kind"], "late")
        self.assertIn("HEA-36", reply)
        self.assertIn("HEA-34", reply)
        self.assertNotIn("$", reply)
        self.assertNotIn("1200", reply)

    def test_owner_week_leddy(self):
        reply, meta = self._handle("what's Leddy doing this week")
        self.assertEqual(meta["kind"], "owner_week")
        self.assertIn("HEA-35", reply)
        self.assertNotIn("HEA-202", reply)
        self.assertNotIn("HEA-205", reply)

    def test_completed_issues_excluded(self):
        reply, _meta = self._handle("what's late on Pleasant Hill")
        self.assertNotIn("HEA-33", reply)

    def test_date_parse_unique_proposal(self):
        reply, meta = self._handle("layout freeze moved to 11/20")
        self.assertEqual(meta["kind"], "proposal")
        self.assertEqual(meta["code"], "7K")
        self.assertIn("HEA-203", reply)
        self.assertIn("7K", reply)
        pending = self.state["linear_proposals"][-1]
        self.assertEqual(pending["new_due"], "2026-11-20")
        self.assertEqual(pending["old_due"], "2026-11-13")

    def test_ambiguity_asks_instead_of_guessing(self):
        reply, meta = self._handle("survey moved to 10/20")
        self.assertEqual(meta["kind"], "date_ambiguous")
        self.assertIn("HEA-35", reply)
        self.assertIn("HEA-207", reply)
        self.assertFalse(self.state["linear_proposals"])

    def test_confirm_mike_dry_run_does_not_write(self):
        self._handle("layout freeze moved to 11/20")
        mike = msg(rowid=2, text="@dev confirm 7K", is_from_me=1, handle="")
        reply, meta = handle_linear(
            self.config,
            "confirm 7K",
            mike,
            self.state,
            self.now,
            self.client,
            events_log=self.config.events_log,
        )
        self.assertEqual(meta["kind"], "confirm")
        self.assertFalse(meta["wrote"])
        self.assertEqual(self.client.update_calls, [])
        self.assertIn("not written", reply)
        events = _read_events(self.config.events_log)
        kinds = [e.get("event") for e in events]
        self.assertIn("linear_proposal", kinds)
        self.assertIn("linear_write_blocked", kinds)
        self.assertIn("linear_confirm", kinds)
        blocked = [e for e in events if e.get("event") == "linear_write_blocked"][0]
        self.assertEqual(blocked["would_mutate"]["input"]["dueDate"], "2026-11-20")

    def test_confirm_todd_allowed_rudy_rejected(self):
        self._handle("permit submittal moved to 1/8")
        todd = msg(rowid=3, text="@dev confirm 7K", handle="todd@example.com", is_from_me=0)
        _reply, meta = handle_linear(
            self.config, "confirm 7K", todd, self.state, self.now, self.client,
            events_log=self.config.events_log,
        )
        self.assertEqual(meta["kind"], "confirm")
        self.assertEqual(self.client.update_calls, [])

        self.state = {"linear_proposals": []}
        self.client = MockLinearClient(fixture_issues())
        self._handle("permit submittal moved to 1/8")
        rudy = msg(rowid=4, text="@dev confirm 7K", handle="+15555550102", is_from_me=0)
        reply, meta = handle_linear(
            self.config, "confirm 7K", rudy, self.state, self.now, self.client,
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
        mike = msg(rowid=5, text="@dev confirm 7K", is_from_me=1, handle="")
        reply, meta = handle_linear(
            self.config, "confirm 7K", mike, self.state, later, self.client,
            events_log=self.config.events_log,
        )
        self.assertEqual(meta["kind"], "confirm_expired")
        self.assertIn("expired", reply)
        events = _read_events(self.config.events_log)
        self.assertTrue(any(e.get("event") == "linear_proposal_expired" for e in events))
        self.assertEqual(self.client.update_calls, [])

    def test_write_when_flag_and_not_dry_run(self):
        self.config.dry_run = False
        self.config.linear_allow_writes = True
        self._handle("layout freeze moved to 11/20")
        mike = msg(rowid=6, text="@dev confirm 7K", is_from_me=1, handle="")
        reply, meta = handle_linear(
            self.config, "confirm 7K", mike, self.state, self.now, self.client,
            events_log=self.config.events_log,
        )
        self.assertTrue(meta["wrote"])
        self.assertEqual(self.client.update_calls, [{"id": "id-layout", "dueDate": "2026-11-20"}])
        self.assertIn("updated HEA-203", reply)
        self.assertNotIn("$", reply)

    def test_strip_dollars(self):
        self.assertNotIn("$", strip_dollars("order chambers $50,000 and USD 20"))
        self.assertIn("order chambers", strip_dollars("order chambers $50,000 now"))

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
        self.assertIn("HEA-35", hit["would_send"])
        self.assertNotIn("$", hit["would_send"] or "")


FIXTURE_PATH = os.path.join(
    os.path.dirname(__file__),
    "fixtures",
    "hea-pleasant-hill-timeline-2026-09-29.json",
)
SUPERVISION_IDS = frozenset({"HEA-91", "HEA-100", "HEA-101", "HEA-102", "HEA-103"})
PREFIX = "Pleasant Hill:"


def filed_issues():
    with open(FIXTURE_PATH, encoding="utf-8") as handle:
        data = json.load(handle)
    out = []
    for item in (data.get("updated") or []) + (data.get("created") or []):
        ident = item["id"]
        project = item.get("project")
        if not project:
            project = (
                "Supervision Standard Rollout"
                if ident in SUPERVISION_IDS
                else "Clinic Development - Todd"
            )
        status = (item.get("status") or "Backlog").lower()
        done = status in ("done", "completed", "canceled", "cancelled")
        owner = item.get("owner") or ""
        assignee = ""
        if owner and "unassigned" not in owner.lower():
            first = owner.split("/")[0].strip()
            if first.lower() not in ("gc", "owner-side"):
                assignee = first
        out.append(
            {
                "id": ident,
                "identifier": ident,
                "title": item["title"],
                "description": "",
                "dueDate": item.get("due"),
                "assignee_name": assignee,
                "labels": [],
                "state_name": item.get("status") or "Backlog",
                "state_type": "completed" if done else "unstarted",
                "project": project,
            }
        )
    return out


class FiledLinearFixtureTests(unittest.TestCase):
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
        self.issues = filed_issues()
        self.client = MockLinearClient(self.issues)
        self.now = _la_ts(2026, 10, 14)
        self.state = {"linear_proposals": []}

    def tearDown(self):
        self.tmpdir.cleanup()

    def _handle(self, rest, client=None, now=None):
        message = msg(rowid=1, text="@dev " + rest, handle="+15555550101")
        return handle_linear(
            self.config,
            rest,
            message,
            self.state,
            now if now is not None else self.now,
            client or self.client,
            events_log=self.config.events_log,
        )

    def test_fixture_scope_includes_supervision_excludes_pleasanton(self):
        listed = self.client.list_issues(
            "HEA",
            self.config.linear_project_names,
            PREFIX,
        )
        ids = {item["identifier"] for item in listed}
        self.assertIn("HEA-91", ids)
        self.assertIn("HEA-100", ids)
        self.assertIn("HEA-101", ids)
        self.assertIn("HEA-102", ids)
        self.assertIn("HEA-103", ids)
        self.assertIn("HEA-35", ids)
        self.assertIn("HEA-136", ids)
        self.assertNotIn("HEA-33", ids)
        self.assertNotIn("HEA-36", ids)
        self.assertTrue(title_in_scope("Bring Pleasant Hill to supervision standard", PREFIX))
        self.assertFalse(title_in_scope("Pleasanton: intake Andrew site diagrams", PREFIX))

        clinic_only = MockLinearClient(self.issues).list_issues(
            "HEA",
            ["Clinic Development - Todd"],
            PREFIX,
        )
        clinic_ids = {item["identifier"] for item in clinic_only}
        self.assertNotIn("HEA-91", clinic_ids)
        self.assertNotIn("HEA-100", clinic_ids)
        self.assertIn("HEA-136", clinic_ids)

    def test_next_gate_is_m1_then_m2(self):
        reply, meta = self._handle("what's the next gate on Pleasant Hill")
        self.assertEqual(meta["kind"], "next_gate")
        self.assertEqual(meta["gate"], 1)
        self.assertIn("HEA-136", reply)
        self.assertIn("M1", reply)
        self.assertNotIn("(Owner:", reply)
        self.assertTrue(reply.startswith("🤖 Dev:"))
        self.assertLessEqual(len(reply), 200)

        for item in self.client.issues:
            if item["identifier"] == "HEA-136":
                item["state_type"] = "completed"
        reply, meta = self._handle("what's the next gate on Pleasant Hill")
        self.assertEqual(meta["gate"], 2)
        self.assertIn("HEA-142", reply)
        self.assertIn("M2", reply)
        self.assertNotIn("(Owner:", reply)

    def test_leddy_owner_from_title_without_assignee(self):
        hea35 = [i for i in self.issues if i["identifier"] == "HEA-35"][0]
        self.assertEqual(hea35["assignee_name"], "")
        self.assertIn("(Owner: Todd)", hea35["title"])
        reply, meta = self._handle("what's Leddy doing this week")
        self.assertEqual(meta["kind"], "owner_week")
        self.assertIn("HEA-35", reply)
        self.assertNotIn("HEA-135", reply)
        self.assertNotIn("(Owner:", reply)
        self.assertEqual(strip_owner_suffix(hea35["title"]), "Pleasant Hill: Todd advance + Leddy survey + architect field measure")

    def test_replies_strip_owner_suffix(self):
        reply, _meta = self._handle("what's Todd doing this week")
        self.assertIn("HEA-35", reply)
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
