# iMessage group bot (multi-desk, `🤖 Dev:` / `🤖 Ops:`)

Self-contained Python 3 **stdlib** bot for one iMessage group chat on Mike's Mac Studio. It polls `~/Library/Messages/chat.db` and, when allowed, replies via AppleScript from Mike's own number.

Several desks share the same bot and group. Each desk has its own trigger word, reply prefix, queue file, outbox file, and reply mode:

- **`@dev`** (default `stub`): immediate canned reply prefixed `🤖 Dev:`, and the trigger is appended to the dev queue.
- **`@ops`** (default `outbox`): the trigger is queued only — no immediate reply. A desk agent appends an answer to the ops outbox; the bot sends it later, prefixed `🤖 Ops:`.

This folder does not touch the HMS web app. **Nothing in this PR sends a real iMessage** unless an operator later sets `dry_run: false` **and** passes `--live` on a Mac.

Linear: [HEA-41](https://linear.app/healtho2/issue/HEA-41/imessage-group-bot-on-mac-studio-dev-one-line-replies). Binding spec: Mike's decision 2026-09-25 3:21 PM PT (free Mac Studio route), plus 3:32 PM PT for trigger word and quiet hours. Mike approved a second operations desk trigger on 2026-09-26.

## Decided defaults (Mike 2026-09-25 / 2026-09-26)

- **Triggers:** `@dev` and `@ops` (case-insensitive, start of message, then a boundary). Same allowlist for both (Mike via `is_from_me`, plus `allowlist_handles`).
- **Prefixes:** `🤖 Dev:` and `🤖 Ops:`.
- **Reply modes:** `@dev` = `stub` (immediate canned reply). `@ops` = `outbox` (queue only; send from outbox).
- **Quiet hours:** 21:00–06:00 `America/Los_Angeles`, overnight wrap included. Stub desks do **not** queue or reply in that window (`suppressed: quiet_hours`). Outbox **sends** are held until the window ends (not dropped). Explicit empty `quiet_hours.start` / `end` in a local config disables the window.
- **Kill switch:** `@dev stop` / `@dev start` from Mike remains global; `@ops stop` / `@ops start` from Mike does the same.

`dry_run` stays `true` by default.

## Dry-run vs live (hard default)

`dry_run` is `true` in `config.example.json`. A real `osascript` send happens only when **both** are true:

1. `"dry_run": false` in the config file, and
2. the process is started with `--live`.

If either is missing, the bot logs a would-be reply (JSONL) and **never** invokes `osascript`. Dry-run still applies rate caps, quiet hours, and the kill switch and records those decisions in the event log.

```bash
# Always safe (default):
python3 bot.py --config config.json once
python3 bot.py --config config.json run

# Live send (Mac Studio only, after a dry-run day + throwaway-group test):
python3 bot.py --config config.json --live once
```

## Install (Mac Studio)

1. Copy this folder onto the machine (or use this repo checkout).
2. `cp config.example.json config.json` and fill in:
   - `group_guid` from `list-groups` (placeholder only in the example)
   - `allowlist_handles` for Todd and Rudy (E.164 or iMessage emails). Mike is always allowed via `is_from_me=1`
   - paths under `./data/` are fine
   - optional `desks` list (see below). Legacy `trigger_word` / `bot_prefix` / `queue_file` still work; if `desks` is omitted the bot keeps that stub desk and adds a default `@ops` outbox desk at `var/desk-queue-ops.jsonl` + `var/outbox-ops.jsonl`
3. Grant **Full Disk Access** to the binary that will open `chat.db`:
   - System Settings → Privacy & Security → Full Disk Access
   - Enable it for `/usr/bin/python3` **or** for `/bin/bash` / Terminal if you run by hand, **and** for `/usr/libexec/xpcproxy` / `python3` when using launchd (often you must add `/usr/bin/python3` and, if that still cannot read the DB, the parent `launchd` job's effective binary)
   - Without this, sqlite cannot read `~/Library/Messages/chat.db`
4. Grant **Automation** permission: the same process must be allowed to control **Messages** (first `osascript` will prompt; live mode only).
5. Keep the macOS user that owns Messages as the **active GUI session**. AppleScript send does not work from a fast-user-switched background login.
6. Run `python3 bot.py --config config.json list-groups` and copy the target group's `guid`.
7. Run `once` or `run` **without** `--live` for a dry-run day. Inspect `data/events.jsonl`.

### launchd (still dry-run)

Copy `com.healthai.imessage-group-bot.plist.example`, replace the `REPLACE/WITH/ABS/PATH` strings, and **do not** add `--live` to `ProgramArguments`.

```bash
cp com.healthai.imessage-group-bot.plist.example ~/Library/LaunchAgents/com.healthai.imessage-group-bot.plist
# edit paths
launchctl load ~/Library/LaunchAgents/com.healthai.imessage-group-bot.plist
```

Logs: `data/launchd.out.log`, `data/launchd.err.log`, plus JSONL under `data/`.

## Log retention

The bot **never rotates or deletes** `events.jsonl`, `alerts.jsonl`, desk queue files, outbox files, `state.json`, or the launchd logs. They grow until an operator prunes them. Keep **30 days** of JSONL unless ops policy says otherwise.

Prune by timestamp (ISO `ts` field) or truncate:

```bash
# Keep roughly the last 30 days of events (requires GNU date); review before replacing:
python3 - <<'PY'
import json, time
from datetime import datetime, timezone, timedelta
path = "data/events.jsonl"
cutoff = datetime.now(timezone.utc) - timedelta(days=30)
keep = []
with open(path, encoding="utf-8") as handle:
    for line in handle:
        if not line.strip():
            continue
        row = json.loads(line)
        ts = row.get("ts") or ""
        try:
            when = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            keep.append(line)
            continue
        if when >= cutoff:
            keep.append(line)
open(path, "w", encoding="utf-8").writelines(keep)
PY

# Or start a new file after archiving:
mv data/events.jsonl data/events-$(date +%Y%m%d).jsonl
```

Do not prune `state.json` (high-water mark, rate-cap timestamps, outbox byte offsets, answered `reply_to` ids) unless you intend to ignore backlog / reset caps / risk resending outbox lines.

## Commands

| Command | What it does |
|---|---|
| `list-groups` | Prints group chats: guid, display name, participant handles, last message date |
| `once` | One poll of new messages (and new outbox lines), then exit |
| `run` | Poll forever (`poll_interval_seconds`, default 10) |

```bash
cd tools/imessage-group-bot
python3 bot.py --config config.json list-groups
python3 bot.py --config config.json once
python3 bot.py --config config.json run
```

## Config keys

All in one JSON file (stdlib `json`). Copy `config.example.json`. No real phone numbers belong in git.

| Key | Meaning |
|---|---|
| `dry_run` | JSON `true`/`false` only. Any other value (null, 0, `""`, strings) is treated as `true`. |
| `enabled` | JSON `true`/`false` only. Any other value is treated as `false`. |
| `bot_prefix` | Default `🤖 Dev:`. Must start with 🤖. Still used as the legacy/dev prefix when `desks` is omitted. |
| `chat_db_path` | Usually `~/Library/Messages/chat.db` |
| `group_guid` | Only this chat is watched |
| `trigger_word` | Legacy/dev trigger. Confirmed `@dev`. Kept for older configs. |
| `desks` | Optional list of desk objects (see below). When omitted, the legacy keys become a stub desk and a default `@ops` outbox desk is added. |
| `max_reply_chars` | Default `200` |
| `allowlist_handles` | Todd/Rudy handles (Mike = `is_from_me`) |
| `poll_interval_seconds` | Default `10` |
| `delivery_confirm_seconds` | Wait for `is_from_me` row after send (default `15`) |
| `rate_caps.min_seconds_between_replies` | Default `20` (shared across **all** desks) |
| `rate_caps.max_replies_per_hour` | Default `10` (group total, not per desk) |
| `rate_caps.max_replies_per_day` | Default `40` (group total, not per desk) |
| `quiet_hours.start` / `end` / `timezone` | Default **21:00–06:00** `America/Los_Angeles` (overnight wrap). Empty start/end disables. |
| `kill_flag_file` | Presence of this file blocks sends |
| `state_file` | High-water ROWID, processed ids, rate timestamps, pause, outbox offsets, answered reply_to |
| `events_log` | JSONL decisions (dry-run and live), including every outbox sent/held/rejected |
| `alerts_log` | Send failures and loop errors |
| `queue_file` | Legacy JSONL path for the Todd Dev Manager desk (same as the `@dev` desk queue) |
| `outbox_file` | Optional legacy path for the `@dev` outbox (default `var/outbox-dev.jsonl`) |
| `alert_hook_command` | Optional local command (not for texting). Empty = none |
| `responder.type` | `stub` (default) or `openai_compatible` (stub desks only) |
| `responder.api_key_env` | Env var **name** for the API key (never put the key in the file) |
| `responder.base_url` / `model` / `timeout_seconds` | OpenAI-compatible chat completions |

### `desks[]` entries

| Key | Meaning |
|---|---|
| `trigger_word` | e.g. `@dev` or `@ops` |
| `bot_prefix` | Must start with 🤖. Sent replies use this prefix. |
| `queue_file` | JSONL of triggers for that desk |
| `outbox_file` | JSONL answers written by a desk agent |
| `reply_mode` | `stub` (immediate canned reply) or `outbox` (queue only; send from outbox). `@ops` defaults to `outbox`. |

Exactly **one** bot reply per trigger still holds: a stub send marks that message guid answered, so a later outbox line for the same `reply_to` is rejected as a duplicate.

## Queue format

Each allowed trigger that is not a Mike stop/start command is one JSON object per line on that desk's `queue_file`. Stub desks skip quiet-hours triggers (not queued). Outbox desks still queue during quiet hours so a desk agent can answer; the send is held.

Default paths (relative to the config file's directory unless you set absolute paths):

- `@dev`: `queue_file` from config (example: `./data/desk-queue.jsonl`; Mac install historically `var/desk-queue.jsonl`)
- `@ops`: `var/desk-queue-ops.jsonl` when `desks` is omitted; example config uses `./data/desk-queue-ops.jsonl`

Fields a desk agent needs:

```json
{
  "ts": "2026-09-26T20:15:00+00:00",
  "event": "desk_queue",
  "guid": "<iMessage message guid>",
  "message_guid": "<same as guid>",
  "rowid": 12345,
  "timestamp": "2026-09-26T20:14:58+00:00",
  "chat_guid": "iMessage;+;chat…",
  "sender_handle": "+15555550101",
  "is_from_me": false,
  "desk": "@ops",
  "trigger_word": "@ops",
  "trigger_text": "@ops is the studio up?",
  "question": "is the studio up?"
}
```

- `guid` / `message_guid`: the chat.db message guid (use this as outbox `reply_to`)
- `rowid`: chat.db ROWID
- `timestamp`: Apple date from the message, ISO-8601 UTC (falls back to processing time)
- `ts`: when the bot queued the line
- `chat_guid`: configured group
- `sender_handle`: E.164/email, or `me` when `is_from_me`
- `desk` / `trigger_word`: which desk matched
- `question`: text after the trigger, trigger stripped
- `trigger_text`: original message text

## Outbox format

A desk agent **appends** one JSON object per line to that desk's `outbox_file`. Do not rewrite the file; the bot tracks a byte offset in `state.json`.

Default paths:

- `@dev`: `var/outbox-dev.jsonl` (example: `./data/outbox-dev.jsonl`)
- `@ops`: `var/outbox-ops.jsonl` (example: `./data/outbox-ops.jsonl`)

```json
{
  "reply_to": "<message guid from the queue line>",
  "chat_guid": "<group guid>",
  "text": "<answer>",
  "ts": "2026-09-26T20:16:00+00:00"
}
```

On every poll the bot reads **new** complete lines (trailing newline required) and:

1. **Rejects** (advances the offset, never sends) if `chat_guid` is not the configured group, if `reply_to` is not a queued trigger **for that desk**, or if that `reply_to` was already answered (idempotent, persisted in state). Invalid JSON / missing fields are also rejected.
2. **Holds** (does not advance the offset) on quiet hours, kill switch / `enabled: false`, or shared rate caps, so the line is retried later.
3. **Sends** with the desk prefix, after the same one-line / 200-character / strip-markdown-and-newlines sanitizer. Dry-run logs `would_send` and **never** calls `osascript`. Live send uses the same delivery confirmation as stub replies.

Every outbox decision is written to `events_log` with `"event": "outbox"`, `"outcome": "sent"|"held"|"rejected"`, and `"reason"`.

## Behavior

- Read-only sqlite: `file:<path>?mode=ro`. Decodes `attributedBody` when `text` is NULL (no `imsg` dependency).
- Trigger: text starts with a configured desk trigger **and** sender is Mike (`is_from_me`) or an allowlisted handle.
- Skip: leading `🤖` (self-loop), `associated_message_type != 0` (tapbacks/reactions), edits (`date_edited`), empty/attachment-only, item_type ≠ 0, backlog from before first start (high-water ROWID). Stub quiet hours: `suppressed: quiet_hours`, not queued.
- One reply per trigger message (idempotent on ROWID/guid, and on outbox `reply_to`).
- Reply: one line, ≤200 chars, desk prefix, markdown/newlines stripped.
- `stub` responder (default for `@dev`): `🤖 Dev: got it, routing to the dev desk: <question>`. A bare `@dev` with no question gets `🤖 Dev: got it, standing by at the dev desk`.
- `outbox` desks do not call the stub/OpenAI responder on the trigger. The later outbox `text` is sanitized and prefixed.
- `openai_compatible` is off unless `responder.type` is exactly `openai_compatible`. It is not called until kill-switch, `enabled`, quiet hours, and rate caps have already allowed a reply. On any error it falls back to stub. Money / leases / partners / Greene / JV → `🤖 Dev: Mike will answer that`.
- Live send: `osascript` with text and chat GUID as argv (so 🤖 is never JSON `\\u`-escaped into AppleScript), then look for a new `is_from_me` row with that text within 15s; retry once; each osascript attempt counts toward rate caps whether or not delivery confirms; then alerts log + optional hook. The hook must not send iMessage.
- Kill switch (any one blocks send): `enabled: false`, kill flag file, `@dev stop` or `@ops stop` from **Mike only**. `@dev start` / `@ops start` from Mike clears the flag file and runtime pause (it cannot override `enabled: false`). Mike's stop/start still apply the flag during quiet hours; the acknowledgement reply is suppressed.

## Throwaway-group test plan

Use a **Mike-only throwaway group first** (Mike talking to himself in a group he creates for this test). Do not point `group_guid` at the real Todd/Rudy thread until that passes. Then a 3-person throwaway if needed.

1. Create the throwaway group. `list-groups`, set `group_guid`, keep `dry_run: true`, run `once`/`run`.
2. From Mike send `@dev ping`. Confirm `events.jsonl` has `would_send` starting `🤖 Dev:` and `osascript_not_invoked`. Confirm no Messages send. Confirm a line in the dev queue with `question` = `ping`.
3. From Mike send `@ops ping`. Confirm **no** immediate `would_send`. Confirm a line in the ops queue (`guid`, `question` with trigger stripped). Append an outbox line with that `reply_to` and the group's `chat_guid`. Run `once` again. Confirm an `outbox` event with `outcome=sent`, `would_send` starting `🤖 Ops:`, and `osascript_not_invoked`.
4. Wrong `chat_guid`, unknown `reply_to`, and a duplicate of a sent `reply_to` must log `outcome=rejected` with reasons `wrong_chat_guid` / `unknown_reply_to` / `duplicate`.
5. Hit `@dev` then immediately an ops outbox send (or two stub `@dev`s) within 20s; the second send should log `rate_cap:min_interval` (caps are shared across desks).
6. During quiet hours, an ops outbox line should log `outcome=held` / `quiet_hours` and send after the window (offset must not skip the line).
7. `touch` the kill flag file; `@dev ping` should log `kill_flag_file`. Outbox lines should hold, not drop.
8. From Mike: `@dev stop` then `@ops start` (or the reverse). Confirm flag file create/remove and `paused` / `running` in the log.
9. Restart the process with the same `state.json` and confirm the already-sent outbox line is **not** resent.
10. Only after a dry-run day: `dry_run: false` **and** `--live` on the throwaway group. Confirm one `🤖 Dev:` stub line and one `🤖 Ops:` outbox line in the thread, and that the bot does not reply to its own lines.
11. Mike approves before pointing `group_guid` at the real group.

## Tests (Linux / CI, no macOS)

```bash
cd tools/imessage-group-bot
python3 -m unittest discover -s tests -v
```

No pip packages. Synthetic `chat.db` is built in-process.

## Layout

```
tools/imessage-group-bot/
  bot.py
  config.example.json
  com.healthai.imessage-group-bot.plist.example
  imessage_group_bot/
  tests/
```
