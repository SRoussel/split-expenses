#!/usr/bin/env python3
"""
Parse bank statement PDFs, prompt for each expense (self vs. split),
and save split expenses to a CSV.

Usage:
    python split_statements.py /path/to/statements
    python split_statements.py /path/to/statements -o splits.csv
    python split_statements.py /path/to/statements --dump   # just show parsed transactions

Requires:  pip install pdfplumber
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
    sys.exit("Missing dependency. Install it with:  pip install pdfplumber")

CATEGORIES = ["utilities", "groceries", "dining", "entertainment", "travel", "gift", "household"]
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
    r"balance forward|total|interest paid|interest earned|payment thank you|"
    r"autopay payment|online transfer|transfer (to|from)",
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


def parse_pdf(path):
    """Yield expense dicts {date, amount, vendor} from one statement PDF."""
    with pdfplumber.open(path) as pdf:
        pages = [(p.extract_text() or "") for p in pdf.pages]
    full_text = "\n".join(pages)
    year = guess_year(full_text, path.name)

    # Credit-card statements list purchases as positive; bank statements mark
    # withdrawals via section headers or a minus sign. Track the section.
    section = None  # "withdrawal" | "deposit" | None
    transactions = []

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
            continue
        if section == "withdrawal":
            is_expense = True
        else:
            # No section known: treat an explicit minus as an expense.
            is_expense = neg
        if not is_expense:
            continue

        transactions.append(
            {
                "date": normalize_date(m.group("date"), year),
                "amount": f"{value:.2f}",
                "vendor": clean_vendor(desc),
            }
        )
    return transactions


# ---------------------------------------------------------------------------
# State (so re-running doesn't ask about the same transactions twice)
# ---------------------------------------------------------------------------

def txn_key(source, index, txn):
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


def ask_category():
    print(paint("  Category:", "bold"))
    for i, cat in enumerate(CATEGORIES, 1):
        print(f"    {paint(i, 'cyan')}. {cat}")
    while True:
        ans = input("  Choose category (number or name): ").strip().lower()
        if ans.isdigit() and 1 <= int(ans) <= len(CATEGORIES):
            return CATEGORIES[int(ans) - 1]
        if ans in CATEGORIES:
            return ans
        print(paint("  Invalid choice.", "red"))


def append_split(csv_path, txn, category):
    new_file = not csv_path.exists()
    with open(csv_path, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        if new_file:
            w.writeheader()
        w.writerow({**txn, "category": category})


def review(txns_by_file, csv_path, state_path):
    state = load_state(state_path)
    done = set(state["done"])
    rules = state["vendor_rules"]  # vendor -> "self" | {"split": category}

    pending = []
    for source, txns in txns_by_file:
        for i, t in enumerate(txns):
            k = txn_key(source, i, t)
            if k not in done:
                pending.append((k, source, t))

    if not pending:
        print(paint("No new transactions to review.", "green"))
        return

    print(f"\n{paint(len(pending), 'bold')} transaction(s) to review.")
    print(f"Keys:  {paint('[s]', 'green')} self   {paint('[p]', 'yellow')} split   "
          f"{paint('[k]', 'dim')} skip for now   {paint('[q]', 'dim')} quit\n")

    split_count = 0
    for n, (k, source, t) in enumerate(pending, 1):
        vendor_key = vendor_match_key(t["vendor"])
        rule = rules.get(vendor_key)

        progress = paint(f"[{n}/{len(pending)}]", "dim")
        amount_txt = "${:>9}".format(t["amount"])
        line = "{}  {}  {}".format(
            paint(t["date"], "dim"),
            paint(amount_txt, "bold", "cyan"),
            paint(t["vendor"], "bold"),
        )

        # Remembered vendor: apply automatically, no prompt.
        if rule is not None:
            if rule == "self":
                print(f"{progress} {line}  {paint('-> self (remembered)', 'green')}")
            else:
                append_split(csv_path, t, rule["split"])
                split_count += 1
                note = "-> split/{} (remembered)".format(rule["split"])
                print(f"{progress} {line}  {paint(note, 'yellow')}")
            done.add(k)
            state["done"] = sorted(done)
            save_state(state_path, state)
            continue

        print(f"{progress} {line}   {paint(f'({source})', 'dim')}")
        ans = ask_choice("  Self or split? [s/p/k/q]: ", {"s", "p", "k", "q"})

        if ans == "q":
            break
        if ans == "k":
            print()
            continue

        if ans == "s":
            choice = "self"
        else:
            category = ask_category()
            append_split(csv_path, t, category)
            split_count += 1
            choice = {"split": category}

        if ask_choice("  Remember this for this vendor? [y/n]: ", {"y", "n"}) == "y":
            rules[vendor_key] = choice

        done.add(k)
        state["done"] = sorted(done)
        state["vendor_rules"] = rules
        save_state(state_path, state)
        print()

    summary = "Saved {} split transaction(s) to {}".format(split_count, csv_path)
    print("\n" + paint(summary, "green", "bold"))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Categorize bank statement expenses as self or split.")
    ap.add_argument("directory", type=Path, help="Directory containing statement PDFs")
    ap.add_argument("-o", "--output", type=Path, default=Path("split_transactions.csv"),
                    help="CSV file for split transactions (default: split_transactions.csv)")
    ap.add_argument("--state", type=Path, default=Path(".split_state.json"),
                    help="State file tracking reviewed transactions")
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

    if args.clear_rules and args.state.exists():
        st = load_state(args.state)
        st["vendor_rules"] = {}
        save_state(args.state, st)
        print(paint("Cleared remembered vendor choices.", "green"))

    if not args.directory.is_dir():
        sys.exit(f"Not a directory: {args.directory}")

    if args.reset and args.state.exists():
        args.state.unlink()

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
        print("{}: found {} expense(s)".format(paint(pdf.name, "bold"), paint(len(txns), "cyan")))
        txns_by_file.append((pdf.name, txns))

    if args.dump:
        for source, txns in txns_by_file:
            print("\n" + paint("== {} ==".format(source), "bold"))
            for t in txns:
                amount_txt = "{:>10}".format(t["amount"])
                print("{}  {}  {}".format(paint(t["date"], "dim"), paint(amount_txt, "cyan"), t["vendor"]))
        return

    try:
        review(txns_by_file, args.output, args.state)
    except (KeyboardInterrupt, EOFError):
        print("\nInterrupted. Progress so far has been saved.")


if __name__ == "__main__":
    main()
