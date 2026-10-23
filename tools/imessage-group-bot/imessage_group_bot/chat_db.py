"""Read-only access to Messages chat.db (URI mode=ro)."""

from __future__ import print_function

import os
import sqlite3
from datetime import datetime, timezone
from urllib.parse import quote

from .attributed_body import decode_attributed_body

APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)


class ChatMessage(object):
    def __init__(
        self,
        rowid,
        guid,
        text,
        handle,
        is_from_me,
        associated_message_type,
        date_raw,
        cache_has_attachments,
        item_type,
        date_edited,
        attributed_used,
    ):
        self.rowid = rowid
        self.guid = guid
        self.text = text
        self.handle = handle
        self.is_from_me = bool(is_from_me)
        self.associated_message_type = associated_message_type
        self.date_raw = date_raw
        self.cache_has_attachments = cache_has_attachments
        self.item_type = item_type
        self.date_edited = date_edited
        self.attributed_used = attributed_used

    def sender_label(self):
        if self.is_from_me:
            return "me"
        return self.handle or ""


def readonly_uri(path):
    abs_path = os.path.abspath(os.path.expanduser(path))
    quoted = quote(abs_path, safe="/:")
    return "file:%s?mode=ro" % quoted


def connect_readonly(path):
    conn = sqlite3.connect(readonly_uri(path), uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


def apple_date_to_unix(value):
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    abs_number = abs(number)
    if abs_number > 1e14:
        seconds = number / 1e9
    elif abs_number > 1e11:
        seconds = number / 1e6
    else:
        seconds = number
    return APPLE_EPOCH.timestamp() + seconds


def format_apple_date(value):
    unix = apple_date_to_unix(value)
    if unix is None:
        return ""
    return datetime.fromtimestamp(unix, tz=timezone.utc).isoformat()


def _row_get(row, key, default=None):
    try:
        value = row[key]
    except (KeyError, IndexError):
        return default
    return default if value is None else value


def _decode_row_text(row):
    text = _row_get(row, "text")
    if isinstance(text, bytes):
        try:
            text = text.decode("utf-8")
        except UnicodeDecodeError:
            text = text.decode("utf-8", errors="replace")
    if text is not None and str(text).strip():
        return str(text), False
    blob = None
    try:
        blob = row["attributedBody"]
    except (KeyError, IndexError):
        blob = None
    decoded = decode_attributed_body(blob)
    return decoded, bool(decoded)


class ChatDB(object):
    def __init__(self, path, opener=None):
        self.path = path
        self._opener = opener or connect_readonly

    def connect(self):
        return self._opener(self.path)

    def max_rowid(self, chat_guid=None):
        sql = "SELECT MAX(message.ROWID) AS m FROM message"
        params = []
        if chat_guid:
            sql = (
                "SELECT MAX(message.ROWID) AS m FROM message "
                "JOIN chat_message_join ON chat_message_join.message_id = message.ROWID "
                "JOIN chat ON chat.ROWID = chat_message_join.chat_id "
                "WHERE chat.guid = ?"
            )
            params = [chat_guid]
        with self.connect() as conn:
            row = conn.execute(sql, params).fetchone()
            if not row or row["m"] is None:
                return 0
            return int(row["m"])

    def fetch_new_messages(self, chat_guid, after_rowid):
        sql = """
            SELECT
                message.ROWID AS rowid,
                message.guid AS guid,
                message.text AS text,
                message.attributedBody AS attributedBody,
                message.is_from_me AS is_from_me,
                message.date AS date,
                message.handle_id AS handle_id,
                handle.id AS handle
            FROM message
            JOIN chat_message_join ON chat_message_join.message_id = message.ROWID
            JOIN chat ON chat.ROWID = chat_message_join.chat_id
            LEFT JOIN handle ON handle.ROWID = message.handle_id
            WHERE chat.guid = ?
              AND message.ROWID > ?
            ORDER BY message.ROWID ASC
        """
        messages = []
        with self.connect() as conn:
            columns = _table_columns(conn, "message")
            extra = []
            for name in ("associated_message_type", "cache_has_attachments", "item_type", "date_edited"):
                extra.append("message.%s AS %s" % (name, name) if name in columns else "NULL AS %s" % name)
            sql = """
                SELECT
                    message.ROWID AS rowid,
                    message.guid AS guid,
                    message.text AS text,
                    message.attributedBody AS attributedBody,
                    message.is_from_me AS is_from_me,
                    message.date AS date,
                    handle.id AS handle,
                    %s
                FROM message
                JOIN chat_message_join ON chat_message_join.message_id = message.ROWID
                JOIN chat ON chat.ROWID = chat_message_join.chat_id
                LEFT JOIN handle ON handle.ROWID = message.handle_id
                WHERE chat.guid = ?
                  AND message.ROWID > ?
                ORDER BY message.ROWID ASC
            """ % ", ".join(extra)
            for row in conn.execute(sql, (chat_guid, after_rowid)):
                text, attributed_used = _decode_row_text(row)
                messages.append(
                    ChatMessage(
                        rowid=int(row["rowid"]),
                        guid=row["guid"],
                        text=text,
                        handle=_row_get(row, "handle") or "",
                        is_from_me=int(_row_get(row, "is_from_me") or 0),
                        associated_message_type=int(_row_get(row, "associated_message_type") or 0),
                        date_raw=_row_get(row, "date"),
                        cache_has_attachments=int(_row_get(row, "cache_has_attachments") or 0),
                        item_type=int(_row_get(row, "item_type") or 0),
                        date_edited=_row_get(row, "date_edited"),
                        attributed_used=attributed_used,
                    )
                )
        return messages

    def find_from_me_with_text(self, chat_guid, text, after_rowid):
        sql = """
            SELECT message.ROWID AS rowid, message.text AS text, message.attributedBody AS attributedBody
            FROM message
            JOIN chat_message_join ON chat_message_join.message_id = message.ROWID
            JOIN chat ON chat.ROWID = chat_message_join.chat_id
            WHERE chat.guid = ?
              AND message.is_from_me = 1
              AND message.ROWID > ?
            ORDER BY message.ROWID DESC
            LIMIT 20
        """
        with self.connect() as conn:
            for row in conn.execute(sql, (chat_guid, after_rowid)):
                body, _ = _decode_row_text(row)
                if body and body.strip() == text.strip():
                    return int(row["rowid"])
        return None

    def list_groups(self):
        groups = []
        with self.connect() as conn:
            chats = conn.execute(
                """
                SELECT chat.ROWID AS rowid, chat.guid AS guid,
                       chat.display_name AS display_name,
                       chat.chat_identifier AS chat_identifier
                FROM chat
                WHERE chat.guid LIKE '%;+;%'
                   OR IFNULL(chat.chat_identifier, '') LIKE 'chat%'
                ORDER BY chat.ROWID
                """
            ).fetchall()
            for chat in chats:
                handles = [
                    row["id"]
                    for row in conn.execute(
                        """
                        SELECT handle.id AS id
                        FROM chat_handle_join
                        JOIN handle ON handle.ROWID = chat_handle_join.handle_id
                        WHERE chat_handle_join.chat_id = ?
                        ORDER BY handle.id
                        """,
                        (chat["rowid"],),
                    )
                    if row["id"]
                ]
                last = conn.execute(
                    """
                    SELECT MAX(message.date) AS last_date
                    FROM chat_message_join
                    JOIN message ON message.ROWID = chat_message_join.message_id
                    WHERE chat_message_join.chat_id = ?
                    """,
                    (chat["rowid"],),
                ).fetchone()
                last_date = last["last_date"] if last else None
                groups.append(
                    {
                        "guid": chat["guid"],
                        "display_name": chat["display_name"] or "",
                        "chat_identifier": chat["chat_identifier"] or "",
                        "handles": handles,
                        "last_message_date": format_apple_date(last_date),
                    }
                )
        return groups


def _table_columns(conn, table):
    rows = conn.execute("PRAGMA table_info(%s)" % table).fetchall()
    names = set()
    for row in rows:
        try:
            names.add(row["name"])
        except (KeyError, IndexError):
            names.add(row[1])
    return names
