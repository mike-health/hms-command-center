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

## Log retention

The bot **never rotates or deletes** `events.jsonl`, `alerts.jsonl`, `desk-queue.jsonl`, `state.json`, or the launchd logs. They grow until an operator prunes them. Keep **30 days** of JSONL unless ops policy says otherwise.

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

Do not prune `state.json` (high-water mark and rate-cap timestamps) unless you intend to ignore backlog / reset caps.

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
| `dry_run` | JSON `true`/`false` only. Any other value (null, 0, `""`, strings) is treated as `true`. |
| `enabled` | JSON `true`/`false` only. Any other value is treated as `false`. |
| `bot_prefix` | Default `🤖 Dev:`. Must start with 🤖. |
| `chat_db_path` | Usually `~/Library/Messages/chat.db` |
| `group_guid` | Only this chat is watched |
| `trigger_word` | Confirmed `@dev` |
| `max_reply_chars` | Default `200` |
| `allowlist_handles` | Todd/Rudy handles (Mike = `is_from_me`) |
| `poll_interval_seconds` | Default `10` |
| `delivery_confirm_seconds` | Wait for `is_from_me` row after send (default `15`) |
| `rate_caps.min_seconds_between_replies` | Default `20`. Explicit `0` means no minimum interval (not the default). |
| `rate_caps.max_replies_per_hour` | Default `10`. Explicit `0` means no replies this hour. |
| `rate_caps.max_replies_per_day` | Default `40`. Explicit `0` means no replies today. |
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
| `linear.api_key_env` | Env var **name** for the Linear key (default `LINEAR_API_KEY`). Never commit the key. |
| `linear.api_key_file` | Optional path **outside the repo** to a file containing the key |
| `linear.team_key` | Default `HEA` |
| `linear.project_names` | Default `Clinic Development - Todd` and `Supervision Standard Rollout`. Legacy `project_name` / `projects` still work. |
| `linear.title_prefix` | Default `Pleasant Hill:`. Also includes titles that contain `Pleasant Hill` (e.g. a supervision-standard parent issue). **`Pleasanton:` titles are excluded on purpose.** |
| `linear.allow_writes` | Default **`false`**. A Linear mutation also requires `dry_run: false` **and** `--live`. |
| `linear.proposal_ttl_seconds` | Default `86400` (24h) |
| `linear.confirm_from_me` | Default `true` (Mike) |
| `linear.confirm_handles` | Todd (and only other people allowed to confirm date writes) |
| `linear.owners` | Map of mike/todd/leddy/rudy/architect → assignee names, labels, title tokens |

## Behavior

- Read-only sqlite: `file:<path>?mode=ro`. Decodes `attributedBody` when `text` is NULL (no `imsg` dependency).
- Trigger: text starts with the trigger word **and** sender is Mike (`is_from_me`) or an allowlisted handle.
- Skip: leading `🤖` (self-loop), `associated_message_type != 0` (tapbacks/reactions), edits (`date_edited`), empty/attachment-only, item_type ≠ 0, backlog from before first start (high-water ROWID), quiet hours (`suppressed: quiet_hours`, not queued).
- One reply per trigger message (idempotent on ROWID/guid).
- Reply: one line, ≤200 chars, prefix `🤖 Dev:`, markdown/newlines stripped.
- `stub` responder (default, only author unless `openai_compatible` is set): `🤖 Dev: got it, routing to the dev desk: <question>`. A bare `@dev` with no question gets `🤖 Dev: got it, standing by at the dev desk`.
- `openai_compatible` is off unless `responder.type` is exactly `openai_compatible`. It is not called until kill-switch, `enabled`, quiet hours, rate caps, **and** the dry-run/`--live` gate have already allowed a live send. On any error it falls back to stub. Money / leases / partners / Greene / JV → `🤖 Dev: Mike will answer that`.
- Every outgoing line is clamped at one choke point (`clamp_reply`): one line, ≤200 chars, prefix `🤖 Dev:`, markdown stripped without eating `->` or `(expires 24h)`, and currency amounts removed (`$1,200`, `1200 USD`, `$1.2k`, `€`/`£`). That includes stub echoes, OpenAI, and Linear replies.
- Triggers that would be answered (not suppressed by quiet hours) are appended to `queue_file` for a later desk agent.
- Live send: `osascript` with text and chat GUID as argv (so 🤖 is never JSON `\\u`-escaped into AppleScript), then look for a new `is_from_me` row with that text within 15s; retry once; each osascript attempt counts toward rate caps whether or not delivery confirms; then alerts log + optional hook. The hook must not send iMessage.
- Kill switch (any one blocks send): `enabled: false`, kill flag file, `@dev stop` from **Mike only**. `@dev start` from Mike clears the flag file and runtime pause (it cannot override `enabled: false`). Mike's stop/start still apply the flag during quiet hours; the acknowledgement reply is suppressed.
- Pleasant Hill Linear (team HEA, configurable `project_names`, default Clinic Development + Supervision Standard Rollout). Titles starting with `Pleasant Hill:` or containing `Pleasant Hill`. **`Pleasanton:` titles are excluded (intended)** so Pleasanton clinic issues are not mixed in. `@dev what's next on Pleasant Hill`, `@dev what's late on Pleasant Hill`, `@dev what's Leddy doing this week`, `@dev what's the next gate on Pleasant Hill` (lowest open M1–M4 in the title). Replies are one line, ≤200 chars, never include currency amounts, and strip `(Owner: …)` title suffixes. Todd and Leddy have no Linear accounts: unassigned issues use `(Owner: Todd)` / `(Owner: Leddy)` in the title; the bot parses that when there is no assignee, and still matches remaining title tokens.
- Date moves (`@dev survey moved to 10/20`) create a **proposal** with a 4+ character confirm code from `secrets`. Linear is not updated until Mike (`is_from_me`) or Todd (`confirm_handles`) sends `@dev confirm 7K2P` within 24h **and** the live-send gate passes. Rudy cannot confirm. Ambiguous matches ask instead of guessing. Expiry, proposals, confirms, and rejected confirms are JSONL-logged. Linear error details stay in the log; the group gets a generic line.
- Linear **writes** require `dry_run: false` **and** `--live` **and** `linear.allow_writes: true`. The GraphQL `issueUpdate` runs only after that live-send gate. Otherwise the mutation is logged as `linear_write_blocked` / `would_mutate` and not sent.

## Throwaway-group test plan

1. Create a 3-person test group (not the real Todd/Rudy thread).
2. `list-groups`, set `group_guid`, keep `dry_run: true`, run `once`/`run`.
3. From an allowlisted handle send `@dev ping`. Confirm `events.jsonl` has `would_send` and `osascript_not_invoked`. Confirm no Messages send.
4. Hit `@dev` twice within 20s; second line should log `rate_cap:min_interval`.
5. `touch` the kill flag file; `@dev ping` should log `kill_flag_file`.
6. From Mike: `@dev stop` then `@dev start`. Confirm flag file create/remove and `paused` / `running` in the log.
7. Point `LINEAR_API_KEY` (or `api_key_file`) at a key that can read HEA. Keep `dry_run: true` and `linear.allow_writes: false`.
8. In the throwaway group send `@dev what's next on Pleasant Hill`, `@dev what's Leddy doing this week`, `@dev what's late on Pleasant Hill`, `@dev what's the next gate on Pleasant Hill`. Confirm one-line `🤖 Dev:` would-sends, **no `$`**, no `(Owner:` suffix, and that `osascript` is not invoked.
9. Send `@dev layout freeze moved to 11/20` (or another unique title). Confirm `linear_proposal` in the log and a confirm code in `would_send`.
10. From a non-confirmer (Rudy test handle): `@dev confirm <code>`. Confirm `linear_confirm_rejected` and no Linear write.
11. From Mike or Todd: `@dev confirm <code>`. Confirm `linear_write_blocked` with `would_mutate` and **no** GraphQL mutation (missing `--live` and/or `allow_writes` false).
12. Optional: wait 24h or set a short `proposal_ttl_seconds` and confirm expiry logging.
13. Only after a dry-run day: `dry_run: false` **and** `--live` on the throwaway group for iMessage delivery. Leave `linear.allow_writes` false until Mike explicitly wants Linear due dates changed.
14. Mike approves before pointing `group_guid` at the real group and before `allow_writes: true`.

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
