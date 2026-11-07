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
CSV_FIELDS = ["date", "amount", "vendor", "category"]

# ---------------------------------------------------------------------------
# Terminal colors (auto-disabled when piped, if NO_COLOR is set, or --no-color)
# ---------------------------------------------------------------------------

USE_COLOR = sys.stdout.isatty() and "NO_COLOR" not in os.environ
if USE_COLOR and os.name == "nt":
    os.system("")  # enables ANSI escape handling in the Windows console

_CODES = {"bold": "1", "dim": "2", "red": "31", "green": "32",
          "yellow": "33", "blue": "34", "magenta": "35", "cyan": "36"}


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


_ID_WORDS = (r"pmt|payment|pymt|bill|ref|reference|conf|confirmation|trace|trn|txn|trans|"
             r"acct|account|inv|invoice|auth|cust|customer|id|no|num|number")
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
    v = re.sub(r"#\s?\d+", " ", v)                    # '#1234' anywhere
    # Any remaining token with 3+ digits (long IDs, masked account numbers).
    v = " ".join(tok for tok in v.split() if len(re.findall(r"\d", tok)) < 3)
    v = re.sub(r"(?:[\s*\-]+\d[\d\-]*)+\s*$", "", v)  # trailing number tokens
    v = DANGLING_LABEL_RE.sub("", v)                  # leftover 'pmt id' etc.
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
    if path.exists():
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            pass
    return {"done": [], "vendor_rules": {}}


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2))


# ---------------------------------------------------------------------------
# CLI interaction
# ---------------------------------------------------------------------------

def ask_choice(prompt, valid):
    while True:
        ans = input(prompt).strip().lower()
        if ans in valid:
            return ans
        print(paint(f"  Please enter one of: {', '.join(sorted(valid))}", "red"))


def ask_category(title="Category"):
    print(paint(f"  {title}:", "bold"))
    for i, cat in enumerate(CATEGORIES, 1):
        print(f"    {paint(i, 'cyan')}. {cat}")
    while True:
        ans = input("  Choose category (number or name): ").strip().lower()
        if ans.isdigit() and 1 <= int(ans) <= len(CATEGORIES):
            return CATEGORIES[int(ans) - 1]
        if ans in CATEGORIES:
            return ans
        print(paint("  Invalid choice.", "red"))


def append_row(csv_path, txn, category, negative=False):
    """Add one transaction to a CSV. Returns are written as negative amounts."""
    new_file = not csv_path.exists()
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with open(csv_path, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        if new_file:
            w.writeheader()
        amount = f"-{txn['amount']}" if negative else txn["amount"]
        w.writerow({"date": txn["date"], "amount": amount, "vendor": txn["vendor"], "category": category})


# Rule values, remembered per vendor (state["vendor_rules"]):
#   money out, key "<vendor>":      {"self": cat} | {"split": cat} | "exclude" | "self" (old, no category)
#   money in,  key "in:<vendor>":   "income" | {"return": cat, "shared": bool} | "exclude"
#   unclear,   key "dir:<vendor>":  "out" | "in" | "exclude"

def apply_choice(choice, txn, paths, counts):
    """Write a transaction where its choice says. Returns a short description."""
    if choice == "exclude":
        counts["excluded"] += 1
        return "excluded"
    if choice == "income":
        append_row(paths["personal"], txn, INCOME)
        counts["income"] += 1
        return "income"
    if "self" in choice:
        append_row(paths["personal"], txn, choice["self"])
        counts["personal"] += 1
        return f"self/{choice['self']}"
    if "split" in choice:
        append_row(paths["split"], txn, choice["split"])
        counts["split"] += 1
        return f"split/{choice['split']}"
    if "return" in choice:
        target = "split" if choice.get("shared") else "personal"
        append_row(paths[target], txn, choice["return"], negative=True)
        counts["returns"] += 1
        return f"return/{choice['return']}" + (" (shared)" if choice.get("shared") else "")
    raise ValueError(f"Unknown choice {choice!r}")


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

    print(f"\n{paint(len(pending), 'bold')} transaction(s) to review.")
    print(f"Money out:  {paint('[s]', 'green')} self   {paint('[p]', 'yellow')} split   "
          f"{paint('[x]', 'magenta')} exclude")
    print(f"Money in:   {paint('[i]', 'green')} income   {paint('[r]', 'yellow')} return   "
          f"{paint('[x]', 'magenta')} exclude")
    print(f"Always:     {paint('[k]', 'dim')} skip for now   {paint('[q]', 'dim')} quit")
    print(paint("Exclude = not spending or income: card payments, transfers between your own "
                "accounts, money between the two of you.\n", "dim"))

    counts = {"split": 0, "personal": 0, "income": 0, "returns": 0, "excluded": 0}

    def finish(k):
        done.add(k)
        state["done"] = sorted(done)
        state["vendor_rules"] = rules
        save_state(state_path, state)

    for n, (k, source, t) in enumerate(pending, 1):
        vendor_key = vendor_match_key(t["vendor"])
        progress = paint(f"[{n}/{len(pending)}]", "dim")
        arrow = {"out": paint("OUT", "red"), "in": paint(" IN", "green"), "unknown": paint("  ?", "yellow")}
        line = "{}  {}  {}  {}".format(
            paint(t["date"], "dim"),
            arrow[t["direction"]],
            paint("${:>9}".format(t["amount"]), "bold", "cyan"),
            paint(t["vendor"], "bold"),
        )

        asked = []  # becomes non-empty once the transaction has been shown for a question

        def show():
            if not asked:
                print(f"{progress} {line}   {paint(f'({source})', 'dim')}")
                asked.append(True)

        # 1. Which way did the money go?
        direction = t["direction"]
        if direction == "unknown":
            remembered = rules.get("dir:" + vendor_key)
            if remembered:
                direction = remembered
            else:
                show()
                print(paint("  The statement doesn't say whether this was money out or in.", "yellow"))
                ans = ask_choice("  Money [o]ut, money [n] in, [x] exclude, [k] skip, [q] quit: ",
                                 {"o", "n", "x", "k", "q"})
                if ans == "q":
                    break
                if ans == "k":
                    print()
                    continue
                direction = {"o": "out", "n": "in", "x": "exclude"}[ans]

        # 2. What was it? Use a remembered choice when there is one.
        rule_key = vendor_key if direction == "out" else "in:" + vendor_key
        choice = "exclude" if direction == "exclude" else rules.get(rule_key)
        if choice == "self":  # remembered by an older version: only "self", no category yet
            show()
            choice = {"self": ask_category("Remembered as self. Which category")}
            rules[rule_key] = choice

        if choice is None:
            show()
            if direction == "out":
                ans = ask_choice("  [s]elf, s[p]lit, e[x]clude, [k] skip, [q] quit: ", {"s", "p", "x", "k", "q"})
            else:
                ans = ask_choice("  [i]ncome, [r]eturn, e[x]clude, [k] skip, [q] quit: ", {"i", "r", "x", "k", "q"})
            if ans == "q":
                break
            if ans == "k":
                print()
                continue
            if ans == "x":
                choice = "exclude"
            elif ans == "i":
                choice = "income"
            elif ans == "s":
                choice = {"self": ask_category()}
            elif ans == "p":
                choice = {"split": ask_category()}
            else:  # return
                cat = ask_category("Which category was the original purchase")
                shared = ask_choice("  Was the original purchase split with your partner? [y/n]: ", {"y", "n"}) == "y"
                choice = {"return": cat, "shared": shared}

        note = apply_choice(choice, t, paths, counts)
        if not asked:  # fully remembered: no questions were needed
            print(f"{progress} {line}  {paint('-> ' + note + ' (remembered)', 'green')}")
        else:
            if ask_choice("  Remember this for this vendor? [y/n]: ", {"y", "n"}) == "y":
                if t["direction"] == "unknown":
                    rules["dir:" + vendor_key] = direction
                if direction != "exclude":
                    rules[rule_key] = choice
            print()
        finish(k)

    print("\n" + paint("Done for now:", "green", "bold"),
          f"{counts['split']} split, {counts['personal']} personal, {counts['income']} income, "
          f"{counts['returns']} return(s), {counts['excluded']} excluded.")
    print(paint(f"Shared: {paths['split']}   Personal: {paths['personal']}", "dim"))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Go through statement transactions: self, split, income, return or exclude.")
    ap.add_argument("directory", type=Path, help="Directory containing statement PDFs")
    ap.add_argument("--person", help="Keep this person's files in data/<person>/ (e.g. --person sam)")
    ap.add_argument("-o", "--output", type=Path,
                    help="CSV for split transactions (default: split_transactions.csv)")
    ap.add_argument("--personal-output", type=Path,
                    help="CSV for your own spending and income (default: personal_transactions.csv)")
    ap.add_argument("--state", type=Path, help="State file tracking reviewed transactions")
    ap.add_argument("--dump", action="store_true",
                    help="Only print parsed transactions; don't prompt (useful to check parsing)")
    ap.add_argument("--reset", action="store_true", help="Forget previously reviewed transactions")
    ap.add_argument("--clear-rules", action="store_true",
                    help="Forget remembered vendor choices (keeps reviewed-transaction history)")
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
        state_path.unlink()

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
        print("{}: {} out, {} in, {} unclear".format(
            paint(pdf.name, "bold"), paint(by_dir["out"], "cyan"), paint(by_dir["in"], "cyan"),
            paint(by_dir["unknown"], "yellow" if by_dir["unknown"] else "cyan")))
        txns_by_file.append((pdf.name, txns))

    if args.dump:
        for source, txns in txns_by_file:
            print("\n" + paint("== {} ==".format(source), "bold"))
            for t in txns:
                amount_txt = "{:>10}".format(t["amount"])
                print("{}  {:<7}  {}  {}".format(
                    paint(t["date"], "dim"), t["direction"], paint(amount_txt, "cyan"), t["vendor"]))
        return

    try:
        review(txns_by_file, paths, state_path)
    except (KeyboardInterrupt, EOFError):
        print("\nInterrupted. Progress so far has been saved.")


if __name__ == "__main__":
    main()
