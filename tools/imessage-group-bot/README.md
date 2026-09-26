# iMessage group bot (multi-desk, `🤖 Dev:` / `🤖 Ops:`)

Self-contained Python 3 **stdlib** bot for one iMessage group chat on Mike's Mac Studio. It polls `~/Library/Messages/chat.db` and, when allowed, replies via AppleScript from Mike's own number.

Several desks share the same bot and group. Each desk has its own trigger word, reply prefix, queue file, outbox file, and reply mode:

- **`@dev`** (default `stub`): immediate canned reply prefixed `🤖 Dev:`, and the trigger is appended to the dev queue. When `notify_webhook` is configured with a URL, the stub is skipped; both desks instead send a short `on it` ack (see `ack_on_queue`) and the real answer comes from the outbox.
- **`@ops`** (default `outbox`): the trigger is queued only — no canned reply. A desk agent (or answering-service webhook) appends an answer to the ops outbox; the bot sends it later, prefixed `🤖 Ops:`.

This folder does not touch the HMS web app. **Nothing in this PR sends a real iMessage** unless an operator later sets `dry_run: false` **and** passes `--live` on a Mac.

Linear: [HEA-41](https://linear.app/healtho2/issue/HEA-41/imessage-group-bot-on-mac-studio-dev-one-line-replies). Binding spec: Mike's decision 2026-09-25 3:21 PM PT (free Mac Studio route), plus 3:32 PM PT for trigger word and quiet hours. Mike approved a second operations desk trigger on 2026-09-26.

## Decided defaults (Mike 2026-09-25 / 2026-09-26)

- **Triggers:** `@dev` and `@ops` (case-insensitive **standalone tokens anywhere** in the message, with a non-empty question after the token). Same allowlist for both (Mike via `is_from_me`, plus `allowlist_handles`). A bare trailing `@ops` / `@dev` with no following text does not fire. Emails and words (`jim@dev.com`, `foo@ops`, `@devops`, `@operations`) do not match. If both appear, the **earliest** token wins (one desk per message).
- **Prefixes:** `🤖 Dev:` and `🤖 Ops:`.
- **Reply modes:** `@dev` = `stub` (immediate canned reply unless `notify_webhook` has a URL). `@ops` = `outbox` (queue; send from outbox). Both desks POST the queued question to `notify_webhook` when a URL is set.
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
| `notify-test` | Sample notify: webhook POST and/or `bot-ping TEST` on the inbox PR (minimal) |
| `pending` | JSONL of queued `@dev`/`@ops` rows that do not yet have an outbox answer |

```bash
cd tools/imessage-group-bot
python3 bot.py --config config.json list-groups
python3 bot.py --config config.json once
python3 bot.py --config config.json run
python3 bot.py --config config.json notify-test
python3 bot.py --config config.json pending
```

## Config keys

All in one JSON file (stdlib `json`). Copy `config.example.json`. No real phone numbers belong in git.

| Key | Meaning |
|---|---|
| `dry_run` | JSON `true`/`false` only. Any other value (null, 0, `""`, strings) is treated as `true`. |
| `enabled` | JSON `true`/`false` only. Any other value is treated as `false`. |
| `bot_prefix` | Default `🤖 Dev:`. Must start with 🤖. Still used as the legacy/dev prefix when `desks` is omitted. |
| `chat_db_path` | Usually `~/Library/Messages/chat.db` |
| `group_guid` | Send target. All bot replies go to this chat. Also watched for triggers. |
| `watch_chat_guids` | Optional extra chat guids to **read** triggers from (same iMessage group under another Apple ID). Missing or `[]` = current single-chat behavior. Replies still go to `group_guid`. |
| `from_me_handle` | Optional E.164/email for the Messages owner (Mike's phone). `is_from_me` in an alias chat is treated as this handle for allowlist, queue `sender_handle`, and cross-chat dedupe. Also allows stop/start from that handle even when `is_from_me=0`. |
| `trigger_word` | Legacy/dev trigger. Confirmed `@dev`. Kept for older configs. |
| `desks` | Optional list of desk objects (see below). When omitted, the legacy keys become a stub desk and a default `@ops` outbox desk is added. |
| `max_reply_chars` | Default `200` if omitted. Example config uses `500`. Outbox replies keep newlines up to this cap. |
| `ack_on_queue` | JSON `true`/`false`. Default `true`. When notify is configured (webhook URL and/or `notify_github`), send an instant `<prefix> on it` after queueing. |
| `notify_webhook` | Optional object. If omitted, or if the resolved URL is empty, no HTTP POST. |
| `notify_webhook.url_env` | Env var **name** for the webhook URL (default `HMS_BOT_WEBHOOK_URL`) |
| `notify_webhook.key_env` | Env var **name** for the auth key (default `HMS_BOT_WEBHOOK_KEY`) |
| `notify_webhook.key_header` | HTTP header for the key (default `Authorization`) |
| `notify_webhook.key_prefix` | Prefix before the key (default `Bearer `) |
| `notify_webhook.timeout_seconds` | POST timeout (default `10`) |
| `notify_github` | Optional object. When `repo` + `pr` are set, each queued question posts **one** comment on that PR's issue thread via `gh`. Works in addition to or instead of the webhook. |
| `notify_github.repo` | Default `mike-health/hms-command-center` |
| `notify_github.pr` | Inbox PR number (example: `19`). Required to enable this transport. |
| `notify_github.gh_path` | Path to `gh`. launchd PATH may omit Homebrew. The bot tries `/opt/homebrew/bin/gh`, then `/usr/local/bin/gh`, then this value (default `gh`). Set an absolute path to pin it. |
| `notify_github.timeout_seconds` | `gh` timeout (default `15`) |
| `notify_github.content` | `minimal` (default, for public repos) or `full` (private repos only). Minimal comment body is only `bot-ping <ping_id>` — no question text, names, phones, or chat ids. |
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

URL and key are read from those environment variables. If unset, the bot also reads `var/webhook.env` (relative to the config file) as `KEY=VALUE` lines. Keep that file mode `600` so launchd does not need the env injected. Never put the URL or key in `config.json`.

GitHub notify uses the Mac's existing `gh` auth (`gh api repos/{repo}/issues/{pr}/comments -f body=...`). The inbox PR is **#19** (`HMS Mgt bot inbox (do not merge)`); do not merge it. That repo is **public**, so comments on #19 are public. Default `content` is `minimal`: the comment is only `bot-ping` plus a 12-hex `ping_id` stored on the queue line. Match the ping with `python3 bot.py --config config.json pending`. Use `content: "full"` only if the repo is private.

### `desks[]` entries

| Key | Meaning |
|---|---|
| `trigger_word` | e.g. `@dev` or `@ops` |
| `bot_prefix` | Must start with 🤖. Sent replies use this prefix. |
| `queue_file` | JSONL of triggers for that desk |
| `outbox_file` | JSONL answers written by a desk agent |
| `reply_mode` | `stub` (immediate canned reply) or `outbox` (queue only; send from outbox). `@ops` defaults to `outbox`. |

A stub canned send still marks that message guid answered, so a later outbox line for the same `reply_to` is rejected as a duplicate. A webhook **queue ack** (`on it`) does **not** mark `reply_to` answered — the outbox answer is still sent.

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
3. **Sends** with the desk prefix. Newlines in `text` are preserved (whitespace is still collapsed **per line**). Length is clamped to `max_reply_chars` (example: 500). Only markdown markers `*` `_` `` ` `` are stripped; normal punctuation stays. Dry-run logs `would_send` and **never** calls `osascript`. Live send uses the same delivery confirmation as stub replies.

Every outbox decision is written to `events_log` with `"event": "outbox"`, `"outcome": "sent"|"held"|"rejected"`, and `"reason"`.

## Behavior

- Read-only sqlite: `file:<path>?mode=ro`. Decodes `attributedBody` when `text` is NULL (no `imsg` dependency).
- Trigger: a configured desk trigger appears as a **standalone token anywhere** in the text **and** sender is Mike (`is_from_me`, `from_me_handle`, or an allowlisted handle). The queue `question` is the text after that token (trimmed). Self-loop (`🤖` prefix) still wins over a nested trigger in **every** watched chat.
- Dual Apple ID: one iMessage group can appear as two `chat.db` rows. Set `group_guid` to the chat whose `last_addressed_handle` is the **bot** address (replies come from that identity). Put the other row in `watch_chat_guids`. Queue lines record `source_chat_guid` and `reply_chat_guid`. Outbox `chat_guid` may be any watched guid; sends always go to `group_guid`. Duplicate copies (same message guid, or same text+sender within 60s) produce one reply.
- Skip: leading `🤖` (self-loop), `associated_message_type != 0` (tapbacks/reactions), edits (`date_edited`), empty/attachment-only, item_type ≠ 0, backlog from before first start (high-water ROWID). Stub quiet hours: `suppressed: quiet_hours`, not queued — unless notify is configured (webhook URL and/or `notify_github`), in which case the question is still queued and notified (the ack is suppressed in the quiet window). A trigger token with no following non-whitespace text is `not_trigger`.
- One reply per trigger message (idempotent on ROWID/guid). Outbox `reply_to` is marked answered only when the **outbox** line is sent, not when a queue ack is sent. Earliest desk token in the message wins if several appear.
- Stub canned reply: one line, desk prefix, markdown/newlines stripped, clamped to `max_reply_chars`. Outbox replies may be multi-line.
- `stub` responder (default for `@dev` **without** notify configured): `🤖 Dev: got it, routing to the dev desk: <question>`. (A message that is only `@dev` with no question is not a trigger.)
- Health check: if the text after the trigger is only `test` (case-insensitive; surrounding whitespace and trailing `.` `!` `?` ignored), the bot replies instantly `<desk prefix> I'm here` and does **not** queue or notify. `@ops test the schedule` is a normal ops question.
- `notify_webhook` / `notify_github`: on a real queued question (`@dev` or `@ops`). Webhook: HTTP JSON payload (stays off-GitHub). GitHub `minimal` (default): one PR comment whose entire body is `bot-ping <ping_id>`. GitHub `full` (private repos): human line + fenced JSON. Short timeout, one retry per transport. Failures go to `alerts.jsonl`; the poll loop keeps running. Not sent for health-check `test` or Mike stop/start. `ping_id` is stored on the queue line.
- When either transport is configured, `@dev` does **not** send the stub routing text. If `ack_on_queue` is true (default), both desks send `<prefix> on it` immediately; the answering service writes the real reply to the desk outbox (`reply_to` = the queue guid).
- `outbox` desks do not call the stub/OpenAI responder on the trigger. The later outbox `text` is sanitized (newlines kept) and prefixed.
- `openai_compatible` is off unless `responder.type` is exactly `openai_compatible`. It is not called until kill-switch, `enabled`, quiet hours, and rate caps have already allowed a reply. On any error it falls back to stub. Money / leases / partners / Greene / JV → `🤖 Dev: Mike will answer that`.
- Live send: `osascript` with text and chat GUID as argv (so 🤖 is never JSON `\\u`-escaped into AppleScript), then look for a new `is_from_me` row with that text within 15s; retry once; each osascript attempt counts toward rate caps whether or not delivery confirms; then alerts log + optional hook. The hook must not send iMessage.
- Kill switch (any one blocks send): `enabled: false`, kill flag file, `@dev stop` or `@ops stop` from **Mike only** when the **whole message** is that command (`Hi @ops stop` is a normal question, not a kill). `@dev start` / `@ops start` from Mike clears the flag file and runtime pause (it cannot override `enabled: false`). Mike's stop/start still apply the flag during quiet hours; the acknowledgement reply is suppressed.

## Throwaway-group test plan

Use a **Mike-only throwaway group first** (Mike talking to himself in a group he creates for this test). Do not point `group_guid` at the real Todd/Rudy thread until that passes. Then a 3-person throwaway if needed.

1. Create the throwaway group. `list-groups`, set `group_guid`, keep `dry_run: true`, run `once`/`run`.
2. From Mike send `@dev ping`. Confirm `events.jsonl` has `would_send` starting `🤖 Dev:` and `osascript_not_invoked`. Confirm no Messages send. Confirm a line in the dev queue with `question` = `ping`. Also try a mid-sentence health check (`Hi rudy … @ops test`) and confirm an instant `🤖 Ops: I'm here` with **no** ops queue line.
3. From Mike send `@ops ping`. Without a webhook URL, confirm **no** immediate `would_send`. With a webhook URL and `ack_on_queue`, confirm `🤖 Ops: on it` then later an outbox `🤖 Ops:` answer. Confirm a line in the ops queue (`guid`, `question` with trigger stripped). Append an outbox line with that `reply_to` and the group's `chat_guid`. Run `once` again. Confirm an `outbox` event with `outcome=sent`, `would_send` starting `🤖 Ops:`, and `osascript_not_invoked`. Multi-line outbox `text` should keep newlines in `would_send`.
4. Wrong `chat_guid`, unknown `reply_to`, and a duplicate of a sent `reply_to` must log `outcome=rejected` with reasons `wrong_chat_guid` / `unknown_reply_to` / `duplicate`.
5. Hit `@dev` then immediately an ops outbox send (or two stub `@dev`s) within 20s; the second send should log `rate_cap:min_interval` (caps are shared across desks). Queue acks do not consume the rate-cap window.
6. During quiet hours, an ops outbox line should log `outcome=held` / `quiet_hours` and send after the window (offset must not skip the line).
7. `touch` the kill flag file; `@dev ping` should log `kill_flag_file`. Outbox lines should hold, not drop.
8. From Mike: `@dev stop` then `@ops start` (or the reverse). Confirm flag file create/remove and `paused` / `running` in the log. Confirm `notify-test` is **not** required for this step; stop/start must **not** POST the webhook.
9. Restart the process with the same `state.json` and confirm the already-sent outbox line is **not** resent.
10. With `notify_github` (PR **#19**, `content: minimal`) and/or `notify_webhook`, send `@ops ping` and confirm a GitHub comment that is only `bot-ping <12 hex>` (or a `notify_failed` alert). `pending` should list that queue row with the same `ping_id`. `notify-test` posts `bot-ping TEST`.
11. Only after a dry-run day: `dry_run: false` **and** `--live` on the throwaway group. Confirm one `🤖 Dev:` stub or ack line and one `🤖 Ops:` outbox line in the thread, and that the bot does not reply to its own lines.
12. Mike approves before pointing `group_guid` at the real group.

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
