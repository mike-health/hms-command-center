import os
import sqlite3
import sys
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from imessage_group_bot.chat_db import ChatMessage  # noqa: E402
from imessage_group_bot.config import load_config  # noqa: E402


GROUP_GUID = "iMessage;+;chatTESTGUID0001"


def typedstream_body(text):
    payload = text.encode("utf-8")
    return b"xxSTREAMTYPEDxxNSString" + b"\x00\x01\x94\x84\x01" + bytes([len(payload)]) + payload


def write_config(directory, **overrides):
    import json

    data = {
        "dry_run": True,
        "enabled": True,
        "chat_db_path": os.path.join(directory, "chat.db"),
        "group_guid": GROUP_GUID,
        "trigger_word": "@dev",
        "bot_prefix": "🤖 Dev:",
        "max_reply_chars": 200,
        "allowlist_handles": ["+15555550101", "todd@example.com", "+15555550102"],
        "poll_interval_seconds": 10,
        "delivery_confirm_seconds": 15,
        "rate_caps": {
            "min_seconds_between_replies": 20,
            "max_replies_per_hour": 10,
            "max_replies_per_day": 40,
        },
        # Explicit empty start/end disables quiet hours so other tests are isolated.
        "quiet_hours": {"start": "", "end": "", "timezone": "America/Los_Angeles"},
        "kill_flag_file": os.path.join(directory, "bot.disabled"),
        "state_file": os.path.join(directory, "state.json"),
        "events_log": os.path.join(directory, "events.jsonl"),
        "alerts_log": os.path.join(directory, "alerts.jsonl"),
        "queue_file": os.path.join(directory, "queue.jsonl"),
        "alert_hook_command": "",
        "responder": {"type": "stub", "api_key_env": "IMESSAGE_BOT_API_KEY"},
    }
    data.update(overrides)
    path = os.path.join(directory, "config.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
    return load_config(path)


def build_sqlite(path, rows=None, chats=None, handles=None):
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE handle (
            ROWID INTEGER PRIMARY KEY,
            id TEXT
        );
        CREATE TABLE chat (
            ROWID INTEGER PRIMARY KEY,
            guid TEXT,
            chat_identifier TEXT,
            display_name TEXT
        );
        CREATE TABLE message (
            ROWID INTEGER PRIMARY KEY,
            guid TEXT,
            text TEXT,
            attributedBody BLOB,
            handle_id INTEGER,
            is_from_me INTEGER,
            date INTEGER,
            associated_message_type INTEGER DEFAULT 0,
            cache_has_attachments INTEGER DEFAULT 0,
            item_type INTEGER DEFAULT 0,
            date_edited INTEGER DEFAULT 0
        );
        CREATE TABLE chat_message_join (
            chat_id INTEGER,
            message_id INTEGER
        );
        CREATE TABLE chat_handle_join (
            chat_id INTEGER,
            handle_id INTEGER
        );
        """
    )
    handles = handles or [
        (1, "+15555550101"),
        (2, "+15555550102"),
        (3, "+15555550999"),
    ]
    for rowid, hid in handles:
        conn.execute("INSERT INTO handle (ROWID, id) VALUES (?, ?)", (rowid, hid))
    chats = chats or [
        (1, GROUP_GUID, "chatTESTGUID0001", "Throwaway Test"),
        (2, "iMessage;-;+15555550101", "+15555550101", ""),
    ]
    for rowid, guid, ident, name in chats:
        conn.execute(
            "INSERT INTO chat (ROWID, guid, chat_identifier, display_name) VALUES (?, ?, ?, ?)",
            (rowid, guid, ident, name),
        )
        conn.execute("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)", (rowid, 1))
        conn.execute("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)", (rowid, 2))
    apple_now = int((datetime.now(timezone.utc).timestamp() - 978307200) * 1e9)
    for row in rows or []:
        conn.execute(
            """
            INSERT INTO message (
                ROWID, guid, text, attributedBody, handle_id, is_from_me, date,
                associated_message_type, cache_has_attachments, item_type, date_edited
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row.get("rowid"),
                row.get("guid", "msg-%s" % row.get("rowid")),
                row.get("text"),
                row.get("attributedBody"),
                row.get("handle_id", 1),
                row.get("is_from_me", 0),
                row.get("date", apple_now),
                row.get("associated_message_type", 0),
                row.get("cache_has_attachments", 0),
                row.get("item_type", 0),
                row.get("date_edited", 0),
            ),
        )
        conn.execute(
            "INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)",
            (row.get("chat_id", 1), row.get("rowid")),
        )
    conn.commit()
    conn.close()


def msg(**kwargs):
    defaults = dict(
        rowid=1,
        guid="G1",
        text="@dev hello",
        handle="+15555550101",
        is_from_me=0,
        associated_message_type=0,
        date_raw=0,
        cache_has_attachments=0,
        item_type=0,
        date_edited=0,
        attributed_used=False,
    )
    defaults.update(kwargs)
    return ChatMessage(**defaults)


class FakeDB(object):
    def __init__(self, messages=None, max_id=0):
        self.messages = list(messages or [])
        self.max_id = max_id
        self.from_me = []

    def max_rowid(self, chat_guid=None):
        if self.messages:
            return max(self.max_id, max(m.rowid for m in self.messages))
        return self.max_id

    def fetch_new_messages(self, chat_guid, after_rowid):
        return [m for m in self.messages if m.rowid > after_rowid]

    def find_from_me_with_text(self, chat_guid, text, after_rowid):
        for rowid, body in self.from_me:
            if rowid > after_rowid and body == text:
                return rowid
        return None
