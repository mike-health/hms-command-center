"""Rate caps, quiet hours, kill-switch, and reply clamping."""

from __future__ import print_function

import os
import re
from datetime import datetime, time, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9
    ZoneInfo = None


MARKDOWN_RE = re.compile(r"[*_`#\[\]()>~]+")
HOUR_SECONDS = 3600
DAY_SECONDS = 86400


def kill_flag_present(path):
    if not path:
        return False
    return os.path.exists(path)


def set_kill_flag(path, paused):
    if not path:
        return
    directory = os.path.dirname(path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory)
    if paused:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("paused\n")
        return
    if os.path.exists(path):
        os.remove(path)


def parse_hhmm(value):
    if not value:
        return None
    parts = value.strip().split(":")
    if len(parts) < 2:
        return None
    try:
        hour = int(parts[0])
        minute = int(parts[1])
    except ValueError:
        return None
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return None
    return time(hour, minute)


def resolve_timezone(tz_name):
    """Return ZoneInfo(tz_name) or raise. Never fall back to local time."""
    if not tz_name:
        raise ValueError("timezone name is empty")
    if ZoneInfo is None:
        raise ValueError("zoneinfo is unavailable; cannot resolve %r" % tz_name)
    try:
        return ZoneInfo(tz_name)
    except Exception as exc:
        raise ValueError("unknown timezone %r: %s" % (tz_name, exc))


def local_now(now_ts, tz_name):
    dt = datetime.fromtimestamp(now_ts, tz=timezone.utc)
    return dt.astimezone(resolve_timezone(tz_name))


def in_quiet_hours(now_ts, start_hhmm, end_hhmm, tz_name):
    start = parse_hhmm(start_hhmm)
    end = parse_hhmm(end_hhmm)
    if start is None or end is None:
        return False
    current = local_now(now_ts, tz_name).time()
    if start == end:
        return True
    if start < end:
        return start <= current < end
    # Overnight window, e.g. 22:00 -> 08:00
    return current >= start or current < end


def prune_send_times(send_times, now_ts):
    cutoff = now_ts - DAY_SECONDS
    return [ts for ts in send_times if ts > cutoff]


def rate_cap_decision(send_times, now_ts, min_seconds, max_hour, max_day):
    times = prune_send_times(send_times, now_ts)
    if times:
        last = max(times)
        delta = now_ts - last
        if delta < min_seconds:
            return "min_interval", times
    hour_count = sum(1 for ts in times if now_ts - ts < HOUR_SECONDS)
    if hour_count >= max_hour:
        return "hourly_cap", times
    day_count = len(times)
    if day_count >= max_day:
        return "daily_cap", times
    return None, times


def clamp_reply(text, prefix, max_chars):
    if text is None:
        text = ""
    one_line = " ".join(str(text).split())
    one_line = MARKDOWN_RE.sub("", one_line).strip()
    prefix = (prefix or "").strip()
    if prefix and not one_line.startswith(prefix):
        body = one_line
        one_line = (prefix + " " + body).strip() if body else prefix
    if max_chars and len(one_line) > max_chars:
        if prefix and max_chars <= len(prefix):
            return prefix[:max_chars]
        one_line = one_line[: max_chars - 1].rstrip() + "…"
    return one_line
