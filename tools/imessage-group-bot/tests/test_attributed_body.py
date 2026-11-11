import os
import plistlib
import unittest

from helpers import typedstream_body
from imessage_group_bot.attributed_body import decode_attributed_body


class AttributedBodyTests(unittest.TestCase):
    def test_nsstring_length_prefixed_utf8(self):
        blob = typedstream_body("@dev from blob")
        self.assertEqual(decode_attributed_body(blob), "@dev from blob")

    def test_extended_length_0x81(self):
        text = "hello attributed"
        payload = text.encode("utf-8")
        blob = b"NSString?????" + b"\x81" + bytes([len(payload)]) + payload
        self.assertEqual(decode_attributed_body(blob), text)

    def test_binary_plist_nsstring(self):
        payload = {
            "$archiver": "NSKeyedArchiver",
            "$objects": [
                "$null",
                "NSMutableAttributedString",
                {"NS.string": "please route this"},
            ],
            "$top": {"root": 1},
        }
        blob = plistlib.dumps(payload, fmt=plistlib.FMT_BINARY)
        self.assertEqual(decode_attributed_body(blob), "please route this")

    def test_utf16le_run(self):
        blob = b"xxxx" + "group ping 1234".encode("utf-16le") + b"\x00\x00"
        self.assertIn("group ping", decode_attributed_body(blob))

    def test_empty_and_none(self):
        self.assertIsNone(decode_attributed_body(None))
        self.assertIsNone(decode_attributed_body(b""))


if __name__ == "__main__":
    unittest.main()
