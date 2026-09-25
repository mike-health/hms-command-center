# iMessage group bot (`🤖 Dev:`)

Self-contained Python 3 **stdlib** bot for one iMessage group chat on Mike's Mac Studio. It polls `~/Library/Messages/chat.db` and, when allowed, replies via AppleScript from Mike's own number. Every bot line is prefixed `🤖 Dev:`.

This folder does not touch the HMS web app. **Nothing in this PR sends a real iMessage** unless an operator later sets `dry_run: false` **and** passes `--live` on a Mac.

Linear: [HEA-41](https://linear.app/healtho2/issue/HEA-41/imessage-group-bot-on-mac-studio-dev-one-line-replies). Binding spec: Mike's decision 2026-09-25 3:21 PM PT (free Mac Studio route), plus 3:32 PM PT for trigger word and quiet hours.

## Decided defaults (Mike 2026-09-25)

- **Trigger word:** `@dev` (case-insensitive, start of message, then a boundary).
- **Quiet hours:** 21:00–06:00 `America/Los_Angeles`, overnight wrap included. No send in that window. A trigger in quiet hours is logged as `suppressed: quiet_hours` and is **not** queued for later. Explicit empty `quiet_hours.start` / `end` in a local config disables the window.

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

## Commands

| Command | What it does |
|---|---|
| `list-groups` | Prints group chats: guid, display name, participant handles, last message date |
| `once` | One poll of new messages, then exit |
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
| `dry_run` | Default `true`. Must be `false` for live send. |
| `enabled` | Kill switch. `false` blocks sends (stop/start ack still logs). |
| `chat_db_path` | Usually `~/Library/Messages/chat.db` |
| `group_guid` | Only this chat is watched |
| `trigger_word` | Confirmed `@dev` |
| `bot_prefix` | Default `🤖 Dev:` |
| `max_reply_chars` | Default `200` |
| `allowlist_handles` | Todd/Rudy handles (Mike = `is_from_me`) |
| `poll_interval_seconds` | Default `10` |
| `delivery_confirm_seconds` | Wait for `is_from_me` row after send (default `15`) |
| `rate_caps.min_seconds_between_replies` | Default `20` |
| `rate_caps.max_replies_per_hour` | Default `10` |
| `rate_caps.max_replies_per_day` | Default `40` |
| `quiet_hours.start` / `end` / `timezone` | Default **21:00–06:00** `America/Los_Angeles` (overnight wrap). Empty start/end disables. |
| `kill_flag_file` | Presence of this file blocks sends |
| `state_file` | High-water ROWID, processed ids, rate timestamps, pause |
| `events_log` | JSONL decisions (dry-run and live) |
| `alerts_log` | Send failures and loop errors |
| `queue_file` | JSONL for the Todd Dev Manager desk |
| `alert_hook_command` | Optional local command (not for texting). Empty = none |
| `responder.type` | `stub` (default) or `openai_compatible` |
| `responder.api_key_env` | Env var **name** for the API key (never put the key in the file) |
| `responder.base_url` / `model` / `timeout_seconds` | OpenAI-compatible chat completions |

## Behavior

- Read-only sqlite: `file:<path>?mode=ro`. Decodes `attributedBody` when `text` is NULL (no `imsg` dependency).
- Trigger: text starts with the trigger word **and** sender is Mike (`is_from_me`) or an allowlisted handle.
- Skip: leading `🤖` (self-loop), `associated_message_type != 0` (tapbacks/reactions), edits (`date_edited`), empty/attachment-only, item_type ≠ 0, backlog from before first start (high-water ROWID), quiet hours (`suppressed: quiet_hours`, not queued).
- One reply per trigger message (idempotent on ROWID/guid).
- Reply: one line, ≤200 chars, prefix `🤖 Dev:`, markdown/newlines stripped.
- `stub` responder: `🤖 Dev: got it, routing to the dev desk: <question>`.
- `openai_compatible`: POST `{base_url}/chat/completions`; on any error, fall back to stub and log it. Money / leases / partners / Greene / JV → `🤖 Dev: Mike will answer that`.
- Triggers that would be answered (not suppressed by quiet hours) are appended to `queue_file` for a later desk agent.
- Live send: `send … to chat id "<guid>"`, then look for a new `is_from_me` row with that text within 15s; retry once; then alerts log + optional hook. The hook must not send iMessage.
- Kill switch (any one blocks send): `enabled: false`, kill flag file, `@dev stop` from **Mike only**. `@dev start` from Mike clears the flag file and runtime pause (it cannot override `enabled: false`).

## Throwaway-group test plan

1. Create a 3-person test group (not the real Todd/Rudy thread).
2. `list-groups`, set `group_guid`, keep `dry_run: true`, run `once`/`run`.
3. From an allowlisted handle send `@dev ping`. Confirm `events.jsonl` has `would_send` and `osascript_not_invoked`. Confirm no Messages send.
4. Hit `@dev` twice within 20s; second line should log `rate_cap:min_interval`.
5. `touch` the kill flag file; `@dev ping` should log `kill_flag_file`.
6. From Mike: `@dev stop` then `@dev start`. Confirm flag file create/remove and `paused` / `running` in the log.
7. Only after a dry-run day: `dry_run: false` **and** `--live` on the throwaway group. Confirm one `🤖 Dev:` line in the thread and that the bot does not reply to its own line.
8. Mike approves before pointing `group_guid` at the real group.

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
