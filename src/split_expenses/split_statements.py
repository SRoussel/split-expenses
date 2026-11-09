#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["pdfplumber"]
# ///
"""
Parse bank statement PDFs and go through every transaction once:

  money out:  self (your own spending), split (shared with your partner), or exclude
  money in:   income, a return (reduces the category it came from), or exclude

Exclude is for money that isn't spending or income: card payments, transfers
between your own accounts, and money between the two of you.

Outputs (git-ignored): split_transactions.csv (shared) and personal_transactions.csv
(yours, including income). Neither leaves your computer; `split-ledger summarize`
turns them into the totals-only file the web app imports.

Usage:
    uv run split-statements /path/to/statements
    uv run split-statements /path/to/sams/statements --person sam   # keeps Sam's files in data/sam/
    uv run split-statements /path/to/statements --dump              # just show what was parsed
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

try:
    import pdfplumber
except ImportError:
    sys.exit("Missing pdfplumber. Run this script with:  uv run split-statements ...")

try:
    from .categories import INCOME, SPENDING
    from .people import person_dir
except ImportError:  # run as a plain script
    from categories import INCOME, SPENDING
    from people import person_dir

CATEGORIES = SPENDING
# "id" is the transaction's id (see txn_key), so answering a transaction again
# replaces its row instead of adding a second one. Files from older versions
# without it still work; their rows just have no id.
CSV_FIELDS = ["date", "amount", "vendor", "category", "id"]

# ---------------------------------------------------------------------------
# Terminal colors (auto-disabled when piped, if NO_COLOR is set, or --no-color)
# ---------------------------------------------------------------------------

USE_COLOR = sys.stdout.isatty() and "NO_COLOR" not in os.environ
if USE_COLOR and os.name == "nt":
    os.system("")  # enables ANSI escape handling in the Windows console

_CODES = {
    "bold": "1",
    "dim": "2",
    "red": "31",
    "green": "32",
    "yellow": "33",
    "blue": "34",
    "magenta": "35",
    "cyan": "36",
}


def paint(text, *styles):
    if not USE_COLOR:
        return str(text)
    return "\033[" + ";".join(_CODES[s] for s in styles) + "m" + str(text) + "\033[0m"


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

# A transaction line: starts with a date, ends with an amount.
#   01/15  STARBUCKS #1234        -4.75
#   01/15/2026  WHOLE FOODS  $52.10-
LINE_RE = re.compile(
    r"""^\s*
        (?P<date>\d{1,2}/\d{1,2}(?:/\d{2,4})?)      # date
        \s+(?:\d{1,2}/\d{1,2}(?:/\d{2,4})?\s+)?     # optional posting date
        (?P<desc>.+?)                               # description
        \s+(?P<amt>[-(]?\$?\s?[\d,]+\.\d{2}\)?-?)   # amount
        (?:\s+[-(]?\$?[\d,]+\.\d{2}\)?-?)?          # optional running balance
        \s*$""",
    re.VERBOSE,
)

# Section headers that tell us which side of the ledger we are on.
WITHDRAWAL_HEADERS = re.compile(
    r"withdrawals?|debits?|purchases?|checks? paid|payments? and other debits|"
    r"electronic payments|other withdrawals|card transactions",
    re.I,
)
DEPOSIT_HEADERS = re.compile(
    r"deposits?|credits?|payments? and other credits|additions",
    re.I,
)

# Descriptions that are never expenses worth splitting.
SKIP_DESC = re.compile(
    r"beginning balance|ending balance|opening balance|closing balance|"
    r"balance forward|payment thank you|"
    r"autopay payment|online transfer|transfer (to|from)|"
    # Summary lines like "Total fees for this period" or "Totals", but not a
    # merchant whose name starts with "Total" (TOTAL WINE & MORE).
    r"^totals?\s*$|^totals?\b.*\b(?:fees|interest|charges|purchases|payments|credits|debits|deposits|"
    r"withdrawals|checks|transactions|balance|this period|year to date|ytd)\b",
    re.I,
)


def parse_amount(raw):
    """Return (value, is_negative_marker). Value is always positive."""
    s = raw.strip()
    neg = s.startswith("-") or s.endswith("-") or (s.startswith("(") and s.endswith(")"))
    value = float(re.sub(r"[^\d.]", "", s))
    return value, neg


MONTHS = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?"


def plausible_years(s):
    """4-digit years in s that are within a sane range (last 10 years to next year)."""
    cur = datetime.now().year
    found = re.findall(r"(?<!\d)(20\d{2})(?!\d)(?!\.\d)(?!,\d)", s)
    return [int(y) for y in found if cur - 10 <= int(y) <= cur + 1]


def guess_year(text, filename):
    """Find a plausible statement year from the file name or the text.

    Only years in a sane range are considered, so stray numbers (street
    addresses, IDs, etc.) like 2050 are ignored.
    """
    ys = plausible_years(filename)
    if ys:
        return ys[0]

    # Prefer years that appear inside dates: 01/15/2026 or "January 15, 2026".
    dated = re.findall(r"\d{1,2}/\d{1,2}/(20\d{2})", text)
    dated += re.findall(MONTHS + r"\s+\d{1,2},?\s+(20\d{2})", text, re.I)
    ys = plausible_years(" ".join(dated))
    if not ys:
        ys = plausible_years(text)
    if ys:
        return Counter(ys).most_common(1)[0][0]
    return datetime.now().year


def normalize_date(raw, year):
    parts = raw.split("/")
    month, day = int(parts[0]), int(parts[1])
    if len(parts) == 3:
        y = int(parts[2])
        year = y + 2000 if y < 100 else y
    try:
        d = datetime(year, month, day)
        # A year-less date that lands in the future belongs to the prior year
        # (e.g. a December transaction on a January statement).
        if len(parts) < 3 and d > datetime.now() + timedelta(days=7):
            d = datetime(year - 1, month, day)
        return d.strftime("%Y-%m-%d")
    except ValueError:
        return raw


def clean_vendor(desc):
    desc = re.sub(r"\s+", " ", desc).strip()
    # drop long trailing reference numbers / card suffixes
    desc = re.sub(r"\s+(?:#|ref|id)?\s?\d{6,}$", "", desc, flags=re.I)
    return desc


_ID_WORDS = (
    r"pmt|payment|pymt|bill|ref|reference|conf|confirmation|trace|trn|txn|trans|"
    r"acct|account|inv|invoice|auth|cust|customer|id|no|num|number"
)
LABELED_ID_RE = re.compile(
    rf"\b(?:{_ID_WORDS})\b\s*(?:id|no|num|number)?\s*[:#.\-]?\s*[\w\-*]*\d[\w\-*]*",
    re.I,
)
DANGLING_LABEL_RE = re.compile(rf"(?:\s+(?:{_ID_WORDS}))+\s*[:#]?$", re.I)


def vendor_match_key(vendor):
    """Normalize a vendor name for matching remembered choices.

    Ignores trailing numbers and '#1234' style references, so
    'STARBUCKS #1234' and 'STARBUCKS 5678' match the same rule.
    """
    v = vendor.lower()
    # Labeled IDs: 'PMT ID: 123456', 'BILL ID 98765', 'REF# A123', 'CONF 4567' ...
    v = LABELED_ID_RE.sub(" ", v)
    v = re.sub(r"#\s?\d+", " ", v)  # '#1234' anywhere
    # Any remaining token with 3+ digits (long IDs, masked account numbers).
    v = " ".join(tok for tok in v.split() if len(re.findall(r"\d", tok)) < 3)
    v = re.sub(r"(?:[\s*\-]+\d[\d\-]*)+\s*$", "", v)  # trailing number tokens
    v = DANGLING_LABEL_RE.sub("", v)  # leftover 'pmt id' etc.
    v = re.sub(r"[\s:#*\-.,]+$", "", v)
    return re.sub(r"\s+", " ", v).strip() or vendor.lower()


# Lines that older versions of this script skipped (interest, and anything with
# "total" in it). They're kept now, but get their own ids so the ids of lines
# reviewed before stay the same.
NEWLY_KEPT = re.compile(r"interest|finance charge|total", re.I)


def parse_text(full_text, filename):
    """Transactions in a statement's text.

    Each is {date, amount, vendor, direction, _key_index}. direction is "out"
    (money out), "in" (money in) or "unknown" (the line wasn't under a heading
    that says which, and had no minus sign; the review asks). Nothing is
    dropped for being unclear.
    """
    year = guess_year(full_text, filename)

    # Credit-card statements list purchases as positive; bank statements mark
    # withdrawals via section headers or a minus sign. Track the section.
    section = None  # "withdrawal" | "deposit" | None
    transactions = []
    legacy_index = 0  # lines older versions also picked up: money out, not interest
    new_index = 0  # everything else

    for line in full_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue

        m = LINE_RE.match(stripped)
        if not m:
            # Possibly a section header.
            if len(stripped) < 60:
                if DEPOSIT_HEADERS.search(stripped) and not WITHDRAWAL_HEADERS.search(stripped):
                    section = "deposit"
                elif WITHDRAWAL_HEADERS.search(stripped):
                    section = "withdrawal"
            continue

        desc = m.group("desc")
        if SKIP_DESC.search(desc):
            continue

        value, neg = parse_amount(m.group("amt"))
        if section == "deposit":
            direction = "in"
        elif section == "withdrawal":
            direction = "out"
        else:
            # No section: a minus sign means money out. Without one we can't tell.
            direction = "out" if neg else "unknown"

        if direction == "out" and not NEWLY_KEPT.search(desc):
            key_index = ("", legacy_index)
            legacy_index += 1
        else:
            key_index = ("new", new_index)
            new_index += 1

        transactions.append(
            {
                "date": normalize_date(m.group("date"), year),
                "amount": f"{value:.2f}",
                "vendor": clean_vendor(desc),
                "direction": direction,
                "_key_index": key_index,
            }
        )
    return transactions


def parse_pdf(path):
    with pdfplumber.open(path) as pdf:
        pages = [(p.extract_text() or "") for p in pdf.pages]
    return parse_text("\n".join(pages), path.name)


# ---------------------------------------------------------------------------
# State (so re-running doesn't ask about the same transactions twice)
# ---------------------------------------------------------------------------


def txn_key(source, txn):
    """Stable id for a transaction. Ids of lines reviewed by older versions are unchanged."""
    kind, i = txn["_key_index"]
    index = str(i) if kind == "" else f"{txn['direction']}#{i}"
    raw = f"{source}|{index}|{txn['date']}|{txn['amount']}|{txn['vendor']}"
    return hashlib.sha1(raw.encode()).hexdigest()


def load_state(path):
    if not path.exists():
        return {"done": [], "vendor_rules": {}}
    try:
        state = json.loads(path.read_text())
        if not isinstance(state.get("done"), list) or not isinstance(state.get("vendor_rules"), dict):
            raise ValueError("missing 'done' or 'vendor_rules'")
        return state
    except (json.JSONDecodeError, ValueError) as e:
        # Never quietly start over: that would review everything again and duplicate rows.
        sys.exit(
            f"{path} can't be read ({e}). Restore it from a backup (e.g. in archive/), "
            f"or move it away to start with nothing reviewed and nothing remembered."
        )


def write_atomic(path, text):
    """Write a whole file in one step (temp file, then rename), so a crash can't leave half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, newline="") if sys.version_info >= (3, 10) else tmp.write_text(text)
    os.replace(tmp, path)


def save_state(path, state):
    write_atomic(path, json.dumps(state, indent=2))


# ---------------------------------------------------------------------------
# Keys
# ---------------------------------------------------------------------------

# One key per category, in the order of CATEGORIES.
CATEGORY_KEYS = "123456789abc"
assert len(CATEGORY_KEYS) >= len(CATEGORIES)
ENTER, ESC = "", "\x1b"


def getkey(prompt):
    """Wait for one keypress; no Enter needed. Returns "" for Enter, "\x1b" for Esc.

    When input isn't a terminal (piped, or the tests), it reads a line instead
    and uses its first character.
    """
    print(prompt, end="", flush=True)
    if not sys.stdin.isatty():
        ch = input()[:1]
    elif os.name == "nt":
        import msvcrt

        ch = msvcrt.getwch()
        if ch in ("\x00", "\xe0"):  # arrow and function keys come as two codes
            msvcrt.getwch()
            ch = "?"
    else:
        import select
        import termios
        import tty

        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setcbreak(fd)
            ch = os.read(fd, 1).decode(errors="ignore")
            if ch == ESC:  # Esc alone, or the start of an arrow key: drain the rest
                while select.select([fd], [], [], 0.03)[0]:
                    os.read(fd, 8)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
    if ch == "\x03":
        raise KeyboardInterrupt
    if ch == "\x04":
        raise EOFError
    if ch in ("\r", "\n"):
        ch = ENTER
    if sys.stdin.isatty():
        print("Enter" if ch == ENTER else "Esc" if ch == ESC else ch)
    return ch


def ask_key(prompt, valid):
    """getkey() until one of `valid` is pressed (letters match either case)."""
    while True:
        ch = getkey(prompt)
        if ch in valid or ch.lower() in valid:
            return ch
        print(paint("  That key doesn't do anything here.", "red"))


def ask_category(title="Category"):
    """One keypress per category. Returns None if Esc was pressed (go back)."""
    items = [f"{paint(k, 'cyan')} {c:<14}" for k, c in zip(CATEGORY_KEYS, CATEGORIES, strict=True)]
    print(f"  {title}:   {paint('Esc', 'dim')} back")
    for i in range(0, len(items), 4):  # rows of four fit an 80-column terminal
        print("    " + "".join(items[i : i + 4]).rstrip())
    ch = ask_key("  > ", set(CATEGORY_KEYS[: len(CATEGORIES)]) | {ESC})
    return None if ch == ESC else CATEGORIES[CATEGORY_KEYS.index(ch.lower())]


# ---------------------------------------------------------------------------
# Suggestions (all local: your own past answers, then a built-in keyword list)
# ---------------------------------------------------------------------------

# (direction, pattern, suggestion), checked in order. Only ever a suggestion: you press Enter to accept.
KEYWORDS = [
    ("out", r"autopay|card payment|payment to|transfer|zelle|venmo|cash app", "exclude"),
    (
        "out",
        r"uber ?eats|doordash|grubhub|starbucks|coffee|caf[eé]|restaurant|pizza|burger|taco|sushi|"
        r"grill|bakery|chipotle|mcdonald|noodle|kitchen|diner|bistro",
        "dining",
    ),
    (
        "out",
        r"safeway|trader joe|whole foods|kroger|costco|aldi|wegmans|publix|sprouts|h-e-b|"
        r"grocer|supermarket|food market",
        "groceries",
    ),
    (
        "out",
        r"netflix|spotify|hulu|disney|youtube|prime video|icloud|apple\.com/bill|patreon|nytimes|"
        r"subscription|membership",
        "subscriptions",
    ),
    (
        "out",
        r"\buber\b|\blyft\b|shell|chevron|exxon|mobil|\bbp\b|\barco\b|sunoco|valero|parking|"
        r"transit|metro|toll|gas station|fuel",
        "transport",
    ),
    (
        "out",
        r"\bcvs\b|walgreens|rite aid|pharmacy|dental|dentist|clinic|medical|hospital|optometr|"
        r"doctor|health",
        "health",
    ),
    (
        "out",
        r"comcast|xfinity|verizon|at&t|t-mobile|spectrum|electric|edison|pg&e|con ed|"
        r"water|utility|utilities|internet",
        "utilities",
    ),
    (
        "out",
        r"airline|airways|delta|united air|southwest|jetblue|hotel|marriott|hilton|hyatt|"
        r"airbnb|expedia|booking\.com",
        "travel",
    ),
    (
        "out",
        r"cinema|theat(er|re)|\bamc\b|ticketmaster|steam|playstation|xbox|nintendo|bowling|"
        r"museum|concert",
        "entertainment",
    ),
    ("out", r"home depot|lowe'?s|ikea|hardware|wayfair|bed bath", "household"),
    ("out", r"\bfee\b|late fee|overdraft|interest charge|finance charge|annual fee|interest", "fees"),
    ("in", r"payroll|direct dep|salary|paycheck|interest", "income"),
    ("in", r"autopay|payment|transfer|zelle|venmo|cash app", "exclude"),
]

# Words that say nothing about the merchant, ignored when comparing names.
NAME_NOISE = {
    "the",
    "sq",
    "tst",
    "pos",
    "debit",
    "purchase",
    "card",
    "pp",
    "paypal",
    "www",
    "inc",
    "llc",
    "co",
    "com",
    "store",
    "online",
    "recurring",
    "payment",
}


def name_tokens(vendor_key):
    return [t for t in re.split(r"[\s*#./]+", vendor_key) if t and t not in NAME_NOISE]


def describe_choice(choice):
    if choice in ("exclude", "income"):
        return choice
    if "self" in choice:
        return f"self / {choice['self']}"
    if "split" in choice:
        return f"split / {choice['split']}"
    return f"return / {choice['return']}" + (" (shared)" if choice.get("shared") else "")


def suggest(vendor_key, direction, rules):
    """(choice, reason) or None. Your own answers for a similar name come first."""
    mine = name_tokens(vendor_key)
    best, best_shared = None, 0
    for key, value in rules.items():
        if key.startswith("dir:") or (key.startswith("in:") != (direction == "in")) or value == "self":
            continue
        theirs = name_tokens(key[3:] if key.startswith("in:") else key)
        shared = 0
        for x, y in zip(mine, theirs, strict=False):  # names can differ in length
            if x != y:
                break
            shared += 1
        # Two words in common, or one distinctive word ("starbucks", not "the").
        if (shared >= 2 or (shared == 1 and len(mine[0]) >= 5)) and shared > best_shared:
            best, best_shared = (value, f"like {key[3:] if key.startswith('in:') else key}"), shared
    if best:
        return best

    for d, pattern, suggestion in KEYWORDS:
        if d == direction and re.search(pattern, vendor_key, re.I):
            if suggestion in ("exclude", "income"):
                return suggestion, "looks like " + ("a transfer or payment" if suggestion == "exclude" else "income")
            # A category: self or split, whichever you've used more for it before.
            split_votes = sum(1 for v in rules.values() if isinstance(v, dict) and v.get("split") == suggestion)
            self_votes = sum(1 for v in rules.values() if isinstance(v, dict) and v.get("self") == suggestion)
            kind = "split" if split_votes > self_votes else "self"
            return {kind: suggestion}, f"looks like {suggestion}"
    return None


# ---------------------------------------------------------------------------
# Writing answers (and taking them back)
# ---------------------------------------------------------------------------


def read_rows(csv_path):
    """Rows of an output CSV as dicts (older files without an id column get id "")."""
    if not csv_path.exists():
        return []
    with open(csv_path, newline="") as f:
        return [{**{k: "" for k in CSV_FIELDS}, **r} for r in csv.DictReader(f)]


def write_rows(csv_path, rows):
    import io

    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=CSV_FIELDS, extrasaction="ignore")
    w.writeheader()
    w.writerows(rows)
    write_atomic(csv_path, buf.getvalue())


def record(paths, txn_id, target, txn=None, category=None, negative=False):
    """Make the output files say what was just answered for this transaction.

    Any earlier row for the same transaction id is removed from both files first,
    so answering again (after --reset, or with a different answer) replaces it.
    With no target (exclude), the transaction ends up in neither file.
    """
    for path in {paths["split"], paths["personal"]}:
        rows = read_rows(path)
        kept = [r for r in rows if r["id"] != txn_id]
        if path == target:
            amount = f"-{txn['amount']}" if negative else txn["amount"]
            kept.append(
                {"date": txn["date"], "amount": amount, "vendor": txn["vendor"], "category": category, "id": txn_id}
            )
        if len(kept) != len(rows) or path == target:
            write_rows(path, kept)


def recorded_index(paths):
    """What's already in the output files: ids, and (date, amount, vendor) for the duplicate check."""
    ids, looks = set(), set()
    for path in (paths["split"], paths["personal"]):
        for r in read_rows(path):
            if r["id"]:
                ids.add(r["id"])
            looks.add((r["date"], r["amount"].lstrip("-"), r["vendor"]))
    return ids, looks


def snapshot(paths):
    """The output files' contents, so undo can put them back exactly."""
    return {p: (p.read_text() if p.exists() else None) for p in {paths["split"], paths["personal"]}}


def restore(snap):
    for path, text in snap.items():
        if text is None:
            path.unlink(missing_ok=True)
        else:
            write_atomic(path, text)


# Rule values, remembered per vendor (state["vendor_rules"]):
#   money out, key "<vendor>":      {"self": cat} | {"split": cat} | "exclude" | "self" (old, no category)
#   money in,  key "in:<vendor>":   "income" | {"return": cat, "shared": bool} | "exclude"
#   unclear,   key "dir:<vendor>":  "out" | "in" | "exclude"


def apply_choice(choice, txn, txn_id, paths, counts):
    """Write one transaction where its choice says (replacing any earlier answer). Returns the counter name."""
    if choice == "exclude":
        record(paths, txn_id, None)
        counts["excluded"] += 1
        return "excluded"
    if choice == "income":
        record(paths, txn_id, paths["personal"], txn, INCOME)
        counts["income"] += 1
        return "income"
    if "self" in choice:
        record(paths, txn_id, paths["personal"], txn, choice["self"])
        counts["personal"] += 1
        return "personal"
    if "split" in choice:
        record(paths, txn_id, paths["split"], txn, choice["split"])
        counts["split"] += 1
        return "split"
    if "return" in choice:
        target = paths["split"] if choice.get("shared") else paths["personal"]
        record(paths, txn_id, target, txn, choice["return"], negative=True)
        counts["returns"] += 1
        return "returns"
    raise ValueError(f"Unknown choice {choice!r}")


# ---------------------------------------------------------------------------
# The review
# ---------------------------------------------------------------------------


def group_pending(pending):
    """Group what's left to review by merchant and direction, in order of first appearance."""
    groups, index = [], {}
    for k, source, t in pending:
        key = (vendor_match_key(t["vendor"]), t["direction"])
        if key not in index:
            index[key] = len(groups)
            groups.append({"vendor_key": key[0], "direction": key[1], "items": [], "each": False})
        groups[index[key]]["items"].append((k, source, t))
    return groups


def item_lines(items, overrides):
    """A merchant's transactions, numbered, with any per-line answers and unusually big amounts marked."""
    amounts = sorted(float(t["amount"]) for _, _, t in items)
    typical = amounts[len(amounts) // 2]
    lines = []
    for i, (_, _, t) in enumerate(items):
        amount = float(t["amount"])
        text = f"{f'${amount:,.2f}':>11}"
        big = len(items) >= 3 and amount >= 100 and amount > 2.5 * typical
        line = f"    {paint(f'{i + 1:>3}', 'dim')}  {t['date']}  " + (paint(text, "bold", "yellow") if big else text)
        if i in overrides:
            line += "  " + paint("→ " + describe_choice(overrides[i]), "green")
        elif big:
            line += "  " + paint("bigger than usual", "yellow")
        lines.append(line)
    return lines


def ask_lines(n):
    """Line numbers typed as "2", "2,5" or "3-6". Returns [] (with a message) for anything else."""
    raw = input("  Which lines? e.g. 2 or 2,5 or 3-6 (Enter to cancel) > ").strip()
    picked = set()
    for part in filter(None, re.split(r"[\s,]+", raw)):
        m = re.fullmatch(r"(\d+)(?:-(\d+))?", part)
        if not m:
            print(paint(f'  "{part}" isn\'t a line number.', "red"))
            return []
        lo, hi = int(m[1]), int(m[2] or m[1])
        if not 1 <= lo <= hi <= n:
            print(paint(f"  Lines go from 1 to {n}.", "red"))
            return []
        picked.update(range(lo - 1, hi))
    return sorted(picked)


def ask_choice(direction, hint, extra_menu, extra_keys):
    """Ask what the money was.

    Returns (choice, once, None) for an answer, or (None, False, key) when one of
    `extra_keys` (lower case, or ESC) was pressed instead. Shift+key means this time only.
    """
    if direction == "out":
        keys, menu = {"s", "p", "x"}, "s self  p split  x exclude"
    else:
        keys, menu = {"i", "r", "x"}, "i income  r return  x exclude"
    valid = keys | extra_keys | ({ENTER} if hint else set())
    while True:
        ch = ask_key(f"  {menu}{extra_menu} > ", valid)
        low = ch.lower()
        if low in extra_keys:
            return None, False, low
        once = ch != low
        if ch == ENTER:
            return hint[0], False, None
        if low == "x":
            return "exclude", once, None
        if low == "i":
            return "income", once, None
        if low in ("s", "p"):
            cat = ask_category()
            if cat is not None:  # Esc goes back to the question
                return {"self" if low == "s" else "split": cat}, once, None
            continue
        cat = ask_category("Which category was the original purchase")
        if cat is not None:
            shared = ask_key("  Was the original purchase split with your partner? y/n > ", {"y", "n"})
            return {"return": cat, "shared": shared.lower() == "y"}, once, None


def group_line(n, total_groups, g):
    items = g["items"]
    _, source, first = items[0]
    arrow = {"out": paint("OUT", "red"), "in": paint(" IN", "green"), "unknown": paint("  ?", "yellow")}
    total = sum(float(t["amount"]) for _, _, t in items)
    dates = sorted(t["date"] for _, _, t in items)
    count = paint(f" ×{len(items)}", "magenta") if len(items) > 1 else ""
    when = dates[0] if dates[0] == dates[-1] else f"{dates[0]} – {dates[-1]}"
    return "{} {}  {}{}  {}  {}".format(
        paint(f"[{n}/{total_groups}]", "dim"),
        arrow[g["direction"]],
        paint(first["vendor"], "bold"),
        count,
        paint(f"${total:,.2f}", "bold", "cyan"),
        paint(f"{when} · {source}", "dim"),
    )


def review(txns_by_file, paths, state_path):
    state = load_state(state_path)
    done = set(state["done"])
    rules = state["vendor_rules"]

    pending = []
    for source, txns in txns_by_file:
        for t in txns:
            k = txn_key(source, t)
            if k not in done:
                pending.append((k, source, t))
    if not pending:
        print(paint("No new transactions to review.", "green"))
        return

    groups = group_pending(pending)
    print(
        f"\n{paint(len(pending), 'bold')} transaction(s) from {paint(len(groups), 'bold')} merchant(s) to review. "
        "One answer covers every transaction from a merchant, and is remembered for next time.\n"
        "A merchant with several transactions is listed so you can answer single lines differently."
    )
    print(
        paint(
            "  Money out: s self  p split  x exclude      Money in: i income  r return  x exclude\n"
            "  Enter accept suggestion   Shift+key this time only\n"
            "  c change some lines (e.g. a TV at Costco)   e answer each separately\n"
            "  k skip for now   u undo   q quit\n"
            "  Exclude = not spending or income: card payments, transfers between your own accounts, "
            "money between the two of you.\n",
            "dim",
        )
    )

    counts = {"split": 0, "personal": 0, "income": 0, "returns": 0, "excluded": 0, "duplicates": 0}
    history = []  # one entry per applied group, newest last, so 'u' can take answers back

    def save():
        state["done"] = sorted(done)
        state["vendor_rules"] = rules
        save_state(state_path, state)

    def set_rule(key, value, changed):
        if key not in changed:
            changed[key] = rules.get(key)
        rules[key] = value

    def undo():
        """Take back the last answer you gave, and anything applied automatically after it."""
        if not any(a["asked"] for a in history):
            print(paint("  Nothing to undo.", "yellow"))
            return None
        while history:
            action = history.pop()
            restore(action["files"])
            for key, old in action["rules"].items():
                if old is None:
                    rules.pop(key, None)
                else:
                    rules[key] = old
            for k in action["keys"]:
                done.discard(k)
            for name, n in action["counts"].items():
                counts[name] -= n
            save()
            if action["asked"]:
                print(paint(f"  Undid: {action['note']}. Asking again.\n", "yellow"))
                return action["index"]
        return None

    gi = 0
    while gi < len(groups):
        g = groups[gi]
        many = len(g["items"]) > 1 and not g["each"]
        line = group_line(gi + 1, len(groups), g)
        asked, once, changed = False, g["each"], {}
        each_key = "  e each" if many else ""

        def show():
            if not asked:
                print(line)
                if many:
                    print("\n".join(item_lines(g["items"], {})))

        # 1. Which way did the money go?
        direction = g["direction"]
        if direction == "unknown":
            remembered = rules.get("dir:" + g["vendor_key"])
            if remembered and not g["each"]:
                direction = remembered
            else:
                show()
                asked = True
                print(paint("  The statement doesn't say whether this was money out or in.", "yellow"))
                ch = ask_key(
                    f"  o out  n in  x exclude{each_key}  k skip  u undo  q quit > ",
                    {"o", "n", "x", "k", "u", "q"} | ({"e"} if many else set()),
                )
                low = ch.lower()
                if low == "q":
                    break
                if low == "k":
                    gi += 1
                    continue
                if low == "u":
                    back = undo()
                    gi = gi if back is None else back
                    continue
                if low == "e":
                    groups[gi : gi + 1] = [dict(g, items=[item], each=True) for item in g["items"]]
                    continue
                once = once or ch != low
                direction = {"o": "out", "n": "in", "x": "exclude"}[low]
                if not once:
                    set_rule("dir:" + g["vendor_key"], direction, changed)

        # 2. What was it? A remembered answer applies straight away.
        rule_key = g["vendor_key"] if direction == "out" else "in:" + g["vendor_key"]
        choice = "exclude" if direction == "exclude" else (None if g["each"] else rules.get(rule_key))
        if choice == "self":  # remembered by an older version: only "self", no category yet
            show()
            asked = True
            cat = None
            while cat is None:
                cat = ask_category("Remembered as self. Which category")
            choice = {"self": cat}
            set_rule(rule_key, choice, changed)

        # A merchant with several transactions is always shown, even when its answer is
        # remembered, so a one-off (a TV at the grocery store) can be changed first.
        remembered = None
        if many and choice is not None and direction != "exclude":
            remembered, choice = (choice, "remembered"), None

        overrides = {}  # line index -> answer for that line only (never remembered)
        result = None
        while choice is None:
            show()
            asked = True
            hint = remembered or suggest(g["vendor_key"], direction, rules)
            if hint:
                label = "Remembered" if hint is remembered else "Suggested"
                reason = "" if hint is remembered else "  " + paint("(" + hint[1] + ")", "dim")
                print(
                    f"  {label}: {paint(describe_choice(hint[0]), 'bold', 'green')}{reason}   "
                    f"Enter to accept{' for the rest' if overrides else ''}"
                )
            change_key = "  c change lines" if many else ""
            choice, picked_once, result = ask_choice(
                direction,
                hint,
                f"{change_key}{each_key}  k skip  u undo  q quit",
                {"k", "u", "q"} | ({"e", "c"} if many else set()),
            )
            if result == "c":
                lines = ask_lines(len(g["items"]))
                if lines:
                    which = "Line" + ("s" if len(lines) > 1 else "") + " " + ", ".join(str(i + 1) for i in lines)
                    print(f"  {which}, this time only:")
                    alt, _, _ = ask_choice(direction, None, f"  {paint('Esc', 'dim')} back", {ESC})
                    if alt is not None:
                        overrides.update((i, alt) for i in lines)
                    print("\n".join(item_lines(g["items"], overrides)))
                result = None
                continue
            if result:
                break
            once = once or picked_once

        if result == "q":
            break
        if result == "k":
            gi += 1
            continue
        if result == "u":
            back = undo()
            gi = gi if back is None else back
            continue
        if result == "e":
            groups[gi : gi + 1] = [dict(g, items=[item], each=True) for item in g["items"]]
            continue

        # 3. Anything that looks already recorded under another id (same date, amount
        #    and merchant)? That happens when ids change: a renamed PDF, a parser fix.
        #    Never add those silently.
        def choice_for(i):
            return overrides.get(i, choice)

        skip_dups = set()
        if any(choice_for(i) != "exclude" for i in range(len(g["items"]))):
            ids, looks = recorded_index(paths)
            dups = [
                k
                for i, (k, _, t) in enumerate(g["items"])
                if choice_for(i) != "exclude" and k not in ids and (t["date"], t["amount"], t["vendor"]) in looks
            ]
            if dups:
                show()
                asked = True
                print(
                    paint(f"  {len(dups)} of these look already recorded (same date, amount and merchant).", "yellow")
                )
                ans = ask_key("  s skip those (recommended)  a add anyway > ", {"s", "a"})
                if ans.lower() == "s":
                    skip_dups = set(dups)

        # 4. Apply it to every transaction in the group, and remember it unless told not to.
        action = {
            "index": gi,
            "asked": asked,
            "files": snapshot(paths),
            "keys": [],
            "counts": {},
            "rules": changed,
            "note": f"{g['items'][0][2]['vendor']} → {describe_choice(choice)}"
            + (f" ({len(overrides)} line(s) answered differently)" if overrides else ""),
        }
        for i, (k, _, t) in enumerate(g["items"]):
            if k in skip_dups:
                name = "duplicates"
                counts[name] += 1
            else:
                name = apply_choice(choice_for(i), t, k, paths, counts)
            action["counts"][name] = action["counts"].get(name, 0) + 1
            action["keys"].append(k)
            done.add(k)
        if asked and not once and direction != "exclude":
            set_rule(rule_key, choice, changed)
        history.append(action)
        save()

        rest = len(g["items"]) - len(overrides)
        times = f" ×{rest}" if rest > 1 or overrides else ""
        if not asked:
            print(f"{line}  {paint('→ ' + describe_choice(choice) + ' (remembered)', 'green')}")
        else:
            tail = " (this time only)" if once else ""
            more = f", {len(overrides)} line(s) as you set them" if overrides else ""
            print(paint(f"  → {describe_choice(choice)}{times}{tail}{more}\n", "green"))
        gi += 1

    print(
        "\n" + paint("Done for now:", "green", "bold"),
        f"{counts['split']} split, {counts['personal']} personal, {counts['income']} income, "
        f"{counts['returns']} return(s), {counts['excluded']} excluded"
        + (f", {counts['duplicates']} skipped as already recorded." if counts["duplicates"] else "."),
    )
    print(paint(f"Shared: {paths['split']}   Personal: {paths['personal']}", "dim"))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser(
        description="Go through statement transactions: self, split, income, return or exclude."
    )
    ap.add_argument("directory", type=Path, help="Directory containing statement PDFs")
    ap.add_argument("--person", help="Keep this person's files in data/<person>/ (e.g. --person sam)")
    ap.add_argument("-o", "--output", type=Path, help="CSV for split transactions (default: split_transactions.csv)")
    ap.add_argument(
        "--personal-output", type=Path, help="CSV for your own spending and income (default: personal_transactions.csv)"
    )
    ap.add_argument("--state", type=Path, help="State file tracking reviewed transactions")
    ap.add_argument(
        "--dump", action="store_true", help="Only print parsed transactions; don't prompt (useful to check parsing)"
    )
    ap.add_argument(
        "--reset",
        action="store_true",
        help="Review everything again (keeps remembered merchants; answers replace their old rows)",
    )
    ap.add_argument(
        "--clear-rules",
        action="store_true",
        help="Forget remembered vendor choices (keeps reviewed-transaction history)",
    )
    ap.add_argument("--no-color", action="store_true", help="Disable colored output")
    args = ap.parse_args()

    if args.no_color:
        global USE_COLOR
        USE_COLOR = False

    base = person_dir(args.person) if args.person else Path(".")
    paths = {
        "split": args.output or base / "split_transactions.csv",
        "personal": args.personal_output or base / "personal_transactions.csv",
    }
    state_path = args.state or base / ".split_state.json"

    if args.clear_rules and state_path.exists():
        st = load_state(state_path)
        st["vendor_rules"] = {}
        save_state(state_path, st)
        print(paint("Cleared remembered vendor choices.", "green"))

    if not args.directory.is_dir():
        sys.exit(f"Not a directory: {args.directory}")

    if args.reset and state_path.exists():
        st = load_state(state_path)
        st["done"] = []
        save_state(state_path, st)
        print(paint("Forgot which transactions were reviewed (remembered merchants kept).", "green"))

    pdfs = sorted(args.directory.glob("*.pdf")) + sorted(args.directory.glob("*.PDF"))
    if not pdfs:
        sys.exit(f"No PDF files found in {args.directory}")

    txns_by_file = []
    for pdf in pdfs:
        try:
            txns = parse_pdf(pdf)
        except Exception as e:  # corrupt/encrypted PDFs shouldn't kill the run
            print(f"Could not read {pdf.name}: {e}", file=sys.stderr)
            continue
        by_dir = Counter(t["direction"] for t in txns)
        print(
            "{}: {} out, {} in, {} unclear".format(
                paint(pdf.name, "bold"),
                paint(by_dir["out"], "cyan"),
                paint(by_dir["in"], "cyan"),
                paint(by_dir["unknown"], "yellow" if by_dir["unknown"] else "cyan"),
            )
        )
        txns_by_file.append((pdf.name, txns))

    if args.dump:
        for source, txns in txns_by_file:
            print("\n" + paint(f"== {source} ==", "bold"))
            for t in txns:
                amount_txt = "{:>10}".format(t["amount"])
                print(
                    "{}  {:<7}  {}  {}".format(
                        paint(t["date"], "dim"), t["direction"], paint(amount_txt, "cyan"), t["vendor"]
                    )
                )
        return

    try:
        review(txns_by_file, paths, state_path)
    except (KeyboardInterrupt, EOFError):
        print("\nInterrupted. Progress so far has been saved.")


if __name__ == "__main__":
    main()
