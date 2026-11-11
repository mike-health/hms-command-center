"""CLI: list-groups, once, run. Live send requires --live AND dry_run false."""

from __future__ import print_function

import argparse
import json
import sys

from .chat_db import ChatDB
from .config import load_config
from .engine import Engine, ensure_data_dirs


def build_parser():
    parser = argparse.ArgumentParser(
        prog="imessage-group-bot",
        description=(
            "Poll chat.db for one iMessage group and optionally reply as 🤖 Dev:. "
            "Dry-run is the default. A real AppleScript send requires dry_run=false "
            "in config AND --live on the command line."
        ),
    )
    parser.add_argument(
        "--config",
        required=True,
        help="Path to config JSON (copy from config.example.json)",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Allow AppleScript send ONLY if config also has dry_run false",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list-groups", help="Print group chats from chat.db (guid, name, handles, last date)")
    sub.add_parser("once", help="Process new messages for the configured group and exit")
    sub.add_parser("run", help="Poll forever (launchd)")
    return parser


def cmd_list_groups(config, out=None):
    out = out or sys.stdout
    db = ChatDB(config.chat_db_path)
    groups = db.list_groups()
    if not groups:
        out.write("No group chats found.\n")
        return 0
    out.write("guid\tdisplay_name\thandles\tlast_message_date\n")
    for group in groups:
        handles = ",".join(group["handles"])
        name = group["display_name"] or group["chat_identifier"] or ""
        out.write(
            "%s\t%s\t%s\t%s\n"
            % (group["guid"], name, handles, group["last_message_date"])
        )
    return 0


def _announce_mode(config, live_flag, out):
    if config.live_send_allowed(live_flag):
        out.write(
            "LIVE SEND ENABLED: osascript will be invoked for allowed replies.\n"
        )
        return
    reasons = []
    if config.dry_run:
        reasons.append("config dry_run=true")
    if not live_flag:
        reasons.append("--live not passed")
    out.write("DRY-RUN: osascript will not be invoked (%s).\n" % "; ".join(reasons))


def cmd_once(config, live_flag, out=None, engine=None):
    out = out or sys.stdout
    ensure_data_dirs(config)
    _announce_mode(config, live_flag, out)
    bot = engine or Engine(config, live_flag=live_flag)
    result = bot.process_once()
    out.write(json.dumps(result, sort_keys=True) + "\n")
    return 0


def cmd_run(config, live_flag, out=None, engine=None):
    out = out or sys.stdout
    ensure_data_dirs(config)
    _announce_mode(config, live_flag, out)
    bot = engine or Engine(config, live_flag=live_flag)
    bot.run_forever()
    return 0


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    config = load_config(args.config)
    if args.command == "list-groups":
        return cmd_list_groups(config)
    if args.command == "once":
        return cmd_once(config, args.live)
    if args.command == "run":
        return cmd_run(config, args.live)
    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    sys.exit(main())
