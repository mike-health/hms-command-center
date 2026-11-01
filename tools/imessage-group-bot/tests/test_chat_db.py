import os
import tempfile
import unittest

from helpers import GROUP_GUID, build_sqlite, typedstream_body
from imessage_group_bot.chat_db import ChatDB


class ChatDBTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmpdir.name, "chat.db")

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_readonly_uri_and_text_column(self):
        build_sqlite(
            self.path,
            rows=[
                {
                    "rowid": 10,
                    "text": "@dev readable",
                    "handle_id": 1,
                    "is_from_me": 0,
                }
            ],
        )
        db = ChatDB(self.path)
        rows = db.fetch_new_messages(GROUP_GUID, 0)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].text, "@dev readable")
        self.assertFalse(rows[0].attributed_used)

    def test_null_text_uses_attributed_body(self):
        build_sqlite(
            self.path,
            rows=[
                {
                    "rowid": 11,
                    "text": None,
                    "attributedBody": typedstream_body("@dev via blob"),
                    "handle_id": 1,
                    "is_from_me": 0,
                }
            ],
        )
        db = ChatDB(self.path)
        rows = db.fetch_new_messages(GROUP_GUID, 0)
        self.assertEqual(rows[0].text, "@dev via blob")
        self.assertTrue(rows[0].attributed_used)

    def test_list_groups(self):
        build_sqlite(self.path, rows=[{"rowid": 1, "text": "hi", "handle_id": 1}])
        groups = ChatDB(self.path).list_groups()
        guids = [g["guid"] for g in groups]
        self.assertIn(GROUP_GUID, guids)
        match = [g for g in groups if g["guid"] == GROUP_GUID][0]
        self.assertEqual(match["display_name"], "Throwaway Test")
        self.assertIn("+15555550101", match["handles"])
        self.assertTrue(match["last_message_date"])


if __name__ == "__main__":
    unittest.main()
