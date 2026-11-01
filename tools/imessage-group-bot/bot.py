#!/usr/bin/env python3
"""Entry point that works without installing the package."""

import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from imessage_group_bot.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
