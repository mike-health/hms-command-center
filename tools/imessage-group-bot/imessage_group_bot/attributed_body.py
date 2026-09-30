"""Decode iMessage ``attributedBody`` typedstreams without ``imsg``.

chat.db often stores ``text`` as NULL and puts the body in a binary
NSKeyedArchiver / typedstream blob. This decoder tries several layouts
seen in the wild (length-prefixed UTF-8 after ``NSString``, binary
plists, UTF-16 runs) and falls back to printable-string extraction.
"""

from __future__ import print_function

import plistlib
import re
import unicodedata


_CLASS_NOISE = frozenset(
    {
        "NSObject",
        "NSString",
        "NSMutableString",
        "NSAttributedString",
        "NSMutableAttributedString",
        "NSDictionary",
        "NSMutableDictionary",
        "NSArray",
        "NSMutableArray",
        "NSNumber",
        "NSValue",
        "NSData",
        "NSMutableData",
        "NSDate",
        "NSNull",
        "NSValueTransformer",
        "NSParagraphStyle",
        "NSMutableParagraphStyle",
        "NSFont",
        "UIFont",
        "NSColor",
        "UIColor",
        "NSAttributeDictionary",
    }
)


def decode_attributed_body(blob):
    """Return plain text from an attributedBody blob, or None."""
    if blob is None:
        return None
    if isinstance(blob, memoryview):
        blob = blob.tobytes()
    if isinstance(blob, bytearray):
        blob = bytes(blob)
    if not blob:
        return None

    for decoder in (
        _from_nsstring_typedstream,
        _from_binary_plist,
        _from_utf16_runs,
        _from_printable_utf8_runs,
    ):
        text = decoder(blob)
        cleaned = _clean_extracted(text)
        if cleaned:
            return cleaned
    return None


def _clean_extracted(text):
    if not text:
        return None
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\x00", "")
    text = text.strip()
    if not text:
        return None
    if text in _CLASS_NOISE or text.startswith("$"):
        return None
    return text


def _try_length_prefixed_utf8(data):
    if not data:
        return None
    first = data[0]
    length = None
    offset = None
    if first < 0x80:
        length = first
        offset = 1
    elif first == 0x81 and len(data) >= 2:
        length = data[1]
        offset = 2
    elif first == 0x82 and len(data) >= 3:
        length = int.from_bytes(data[1:3], "big")
        offset = 3
    elif first == 0x83 and len(data) >= 4:
        length = int.from_bytes(data[1:4], "big")
        offset = 4
    elif first == 0x84 and len(data) >= 5:
        length = int.from_bytes(data[1:5], "big")
        offset = 5
    else:
        return None
    if length <= 0 or offset + length > len(data):
        return None
    payload = data[offset : offset + length]
    if payload.startswith(b"\xfe\xff") or payload.startswith(b"\xff\xfe"):
        try:
            return payload.decode("utf-16")
        except UnicodeDecodeError:
            return None
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        try:
            text = payload.decode("utf-16")
        except UnicodeDecodeError:
            return None
    if not text or "\x00" in text[:8] and len(text) < 2:
        return None
    # Reject strings that are mostly non-printable control bytes.
    printable = sum(1 for ch in text if ch.isprintable() or ch in "\n\t")
    if printable < max(1, int(len(text) * 0.8)):
        return None
    return text


def _from_nsstring_typedstream(blob):
    idx = blob.find(b"NSString")
    if idx < 0:
        idx = blob.find(b"NSMutableString")
        marker_len = len(b"NSMutableString") if idx >= 0 else 0
    else:
        marker_len = len(b"NSString")
    if idx < 0:
        return None
    chunk = blob[idx + marker_len :]
    # Class metadata between the marker and the string is a handful of bytes.
    # Also try the well-known "+5 then length" layout.
    candidates = []
    if len(chunk) > 5:
        candidates.append(_try_length_prefixed_utf8(chunk[5:]))
    plus = chunk.find(b"+")
    if 0 <= plus < 64:
        candidates.append(_try_length_prefixed_utf8(chunk[plus + 1 :]))
    for skip in range(0, min(48, len(chunk))):
        candidates.append(_try_length_prefixed_utf8(chunk[skip:]))
    for text in candidates:
        cleaned = _clean_extracted(text)
        if cleaned:
            return cleaned
    return None


def _walk_plist_strings(obj, out):
    if isinstance(obj, str):
        out.append(obj)
        return
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in ("NS.string", "NSString", "string", "text"):
                if isinstance(value, str):
                    out.append(value)
            _walk_plist_strings(value, out)
        return
    if isinstance(obj, (list, tuple)):
        for item in obj:
            _walk_plist_strings(item, out)


def _from_binary_plist(blob):
    if not blob.startswith(b"bplist"):
        return None
    try:
        parsed = plistlib.loads(blob)
    except Exception:
        return None
    found = []
    _walk_plist_strings(parsed, found)
    objects = parsed.get("$objects") if isinstance(parsed, dict) else None
    if isinstance(objects, list):
        for item in objects:
            if isinstance(item, str):
                found.append(item)
            elif isinstance(item, dict):
                _walk_plist_strings(item, found)
    best = None
    for text in found:
        cleaned = _clean_extracted(text)
        if not cleaned:
            continue
        if cleaned in _CLASS_NOISE:
            continue
        if best is None or len(cleaned) > len(best):
            best = cleaned
    return best


def _from_utf16_runs(blob):
    for encoding, min_len in (("utf-16le", 8), ("utf-16be", 8)):
        try:
            decoded = blob.decode(encoding, errors="ignore")
        except Exception:
            continue
        decoded = decoded.replace("\x00", "")
        runs = re.findall(r"[\w@:/.,'!? +\-]{4,}", decoded)
        if not runs:
            continue
        runs.sort(key=len, reverse=True)
        for run in runs:
            cleaned = _clean_extracted(run)
            if cleaned and len(cleaned) >= 4 and cleaned not in _CLASS_NOISE:
                return cleaned
    return None


def _from_printable_utf8_runs(blob):
    try:
        decoded = blob.decode("utf-8", errors="ignore")
    except Exception:
        return None
    runs = re.findall(r"[^\x00-\x08\x0b\x0c\x0e-\x1f]{4,}", decoded)
    best = None
    for run in runs:
        if "NSString" in run or run.strip() in _CLASS_NOISE:
            continue
        cleaned = _clean_extracted(run)
        if cleaned and (best is None or len(cleaned) > len(best)):
            best = cleaned
    return best
