"""Keeping each person's files apart when one computer handles both of you."""

import re
import sys
from pathlib import Path


def person_dir(name):
    """data/<name>/ holds one person's review state, transaction files and summary."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", name or ""):
        sys.exit("--person must be a short name: letters, numbers, - or _.")
    return Path("data") / name.lower()
