#!/usr/bin/env python3
"""
Shared-expense ledger: track who paid, and who owes whom.

Every entry is appended to a CSV (default: ledger.csv). The balance is always
derived from that file, so you can inspect or hand-edit it at any time.

Balance convention: positive = partner owes you, negative = you owe partner.

Examples:
    uv run split-ledger init --i-owe 500                 # starting deficit
    uv run split-ledger init --partner-owes 600
    uv run split-ledger add 84.20 me groceries           # you paid, split 50/50
    uv run split-ledger add 120 partner power bill       # name can be several words
    uv run split-ledger add 60 me dinner --my-share 70   # you owe 70% of this one
    uv run split-ledger add                              # prompts for amount, payer, name
    uv run split-ledger import split_transactions.csv    # total -> "Expenses mm/dd/yy-mm/dd/yy"
    uv run split-ledger summarize split_transactions.csv # -> split_summary.json for the web app
    uv run split-ledger settle                           # settle the full balance
    uv run split-ledger settle 100 me                    # you paid partner $100
    uv run split-ledger balance
    uv run split-ledger history
"""

import argparse
import csv
import json
import os
import sys
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path

FIELDS = ["date", "type", "payer", "amount", "my_share", "name"]
CENT = Decimal("0.01")

EXPENSE = "expense"
SETTLEMENT = "settlement"
OPENING_ME = "opening_me_owes"
OPENING_PARTNER = "opening_partner_owes"

# Terminal colors (auto-disabled when piped, if NO_COLOR is set, or --no-color).
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
# Helpers
# ---------------------------------------------------------------------------

def money(x):
    return Decimal(x).quantize(CENT, rounding=ROUND_HALF_UP)


def parse_amount(s):
    try:
        d = Decimal(str(s).replace("$", "").replace(",", "").strip())
    except InvalidOperation:
        raise ValueError(f"Not a valid amount: {s!r}")
    if d <= 0:
        raise ValueError("Amount must be greater than zero.")
    return money(d)


def parse_date(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d").date().isoformat()
    except ValueError:
        raise ValueError(f"Date must be YYYY-MM-DD, got {s!r}")


def parse_percent(s):
    try:
        p = Decimal(str(s).replace("%", "").strip())
    except InvalidOperation:
        raise ValueError(f"Not a valid percentage: {s!r}")
    if not (0 <= p <= 100):
        raise ValueError("Share must be between 0 and 100.")
    return p


def parse_name(s):
    s = " ".join(str(s).split())
    if not s:
        raise ValueError("Please give this payment a name (e.g. 'groceries').")
    return s


def parse_payer(s):
    s = s.strip().lower()
    aliases = {"me": "me", "i": "me", "you": "me", "m": "me",
               "partner": "partner", "p": "partner"}
    if s not in aliases:
        raise ValueError("Payer must be 'me' or 'partner'.")
    return aliases[s]


def fmt(d):
    return f"${money(abs(d)):,.2f}"


def describe(balance):
    if balance > 0:
        return paint(f"Partner owes you {fmt(balance)}", "bold", "green")
    if balance < 0:
        return paint(f"You owe partner {fmt(balance)}", "bold", "red")
    return paint("All settled up.", "bold", "green")


# ---------------------------------------------------------------------------
# Ledger I/O and balance derivation
# ---------------------------------------------------------------------------

def load_ledger(path):
    if not path.exists():
        return []
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def append_row(path, row):
    new_file = not path.exists() or path.stat().st_size == 0
    if path.parent and not path.parent.exists():
        path.parent.mkdir(parents=True)
    with open(path, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new_file:
            w.writeheader()
        w.writerow(row)


def effect(row):
    """How much this row changes the balance (positive = partner owes you more)."""
    amount = Decimal(row["amount"])
    kind = row["type"]

    if kind == OPENING_ME:
        return -amount
    if kind == OPENING_PARTNER:
        return amount
    if kind == SETTLEMENT:
        # Whoever paid is sending money to the other, reducing what they owe.
        return amount if row["payer"] == "me" else -amount
    if kind == EXPENSE:
        my_share = Decimal(row["my_share"] or "50")
        # The person who didn't pay owes their share, rounded half up to the cent;
        # the payer covers the rest. So on an odd half-cent the payer gets the
        # one-cent discount. This matches the web app (web/shared/owed.ts).
        if row["payer"] == "me":
            return money(amount * (100 - my_share) / 100)  # partner owes me their part
        return -money(amount * my_share / 100)  # I owe partner my part
    raise ValueError(f"Unknown entry type in ledger: {kind!r}")


def current_balance(rows):
    return sum((effect(r) for r in rows), Decimal("0.00"))


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def prompt(text, parser):
    while True:
        try:
            return parser(input(text))
        except ValueError as e:
            print(f"  {e}")


def cmd_add(args, path):
    try:
        amount = parse_amount(args.amount) if args.amount else prompt("Amount: $", parse_amount)
        payer = parse_payer(args.payer) if args.payer else prompt("Who paid? [me/partner]: ", parse_payer)
        share = parse_percent(args.my_share)
        name = parse_name(" ".join(args.name)) if args.name else prompt(
            "Name (what was it for?): ", parse_name)
        when = parse_date(args.date) if args.date else date.today().isoformat()
    except ValueError as e:
        sys.exit(f"Error: {e}")

    row = {
        "date": when,
        "type": EXPENSE,
        "payer": payer,
        "amount": f"{amount:.2f}",
        "my_share": f"{share.normalize():f}",
        "name": name,
    }
    append_row(path, row)

    who = "You" if payer == "me" else "Partner"
    print(f"{paint('Recorded:', 'green')} {who} paid {fmt(amount)} for {name} "
          f"(your share {row['my_share']}%).")
    print(describe(current_balance(load_ledger(path))))


def cmd_init(args, path):
    if args.i_owe is None and args.partner_owes is None:
        sys.exit("Specify --i-owe AMOUNT or --partner-owes AMOUNT.")
    if args.i_owe is not None and args.partner_owes is not None:
        sys.exit("Specify only one of --i-owe / --partner-owes.")

    rows = load_ledger(path)
    if any(r["type"] in (OPENING_ME, OPENING_PARTNER) for r in rows) and not args.force:
        sys.exit("A starting balance already exists in this ledger. "
                 "Use --force to add another, or edit the CSV directly.")

    try:
        if args.i_owe is not None:
            amount, kind = parse_amount(args.i_owe), OPENING_ME
        else:
            amount, kind = parse_amount(args.partner_owes), OPENING_PARTNER
        when = parse_date(args.date) if args.date else date.today().isoformat()
    except ValueError as e:
        sys.exit(f"Error: {e}")

    append_row(path, {
        "date": when, "type": kind, "payer": "", "amount": f"{amount:.2f}",
        "my_share": "", "name": "Starting balance",
    })
    print(paint("Starting balance recorded.", "green"))
    print(describe(current_balance(load_ledger(path))))


def cmd_settle(args, path):
    balance = current_balance(load_ledger(path))
    try:
        if args.amount:
            amount = parse_amount(args.amount)
            payer = parse_payer(args.payer) if args.payer else prompt(
                "Who made the payment? [me/partner]: ", parse_payer)
        else:
            if balance == 0:
                sys.exit("Nothing to settle: balance is zero.")
            amount = abs(balance)
            # If you owe partner (negative), you pay; if partner owes you, they pay.
            payer = "me" if balance < 0 else "partner"
        when = parse_date(args.date) if args.date else date.today().isoformat()
    except ValueError as e:
        sys.exit(f"Error: {e}")

    # Settlement effect: payer "me" -> +amount (balance rises toward zero from negative).
    append_row(path, {
        "date": when, "type": SETTLEMENT, "payer": payer, "amount": f"{amount:.2f}",
        "my_share": "", "name": args.name or "Settlement",
    })
    who = "You paid partner" if payer == "me" else "Partner paid you"
    print(f"{paint('Recorded:', 'green')} {who} {fmt(amount)}.")
    print(describe(current_balance(load_ledger(path))))


def read_split_csv(src):
    """Total a split_transactions.csv: (total, dates, totals by category, rows skipped)."""
    total = Decimal("0.00")
    dates, by_category, skipped = [], {}, 0
    with open(src, newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or not {"date", "amount"} <= set(reader.fieldnames):
            sys.exit("CSV must have 'date' and 'amount' columns.")
        for r in reader:
            try:
                amt = parse_amount(r["amount"])
                d = datetime.strptime(r["date"].strip(), "%Y-%m-%d").date()
            except (ValueError, AttributeError):
                skipped += 1
                continue
            total += amt
            dates.append(d)
            cat = (r.get("category") or "uncategorized").strip() or "uncategorized"
            by_category[cat] = by_category.get(cat, Decimal("0.00")) + amt
    if not dates:
        sys.exit("No valid transactions found in that CSV.")
    return total, dates, by_category, skipped


def default_name(dates):
    start, end = min(dates), max(dates)
    return f"Expenses {start:%m/%d/%y}-{end:%m/%d/%y}"


def cents(amount):
    return int(money(amount) * 100)


def cmd_summarize(args, _path):
    """Write split_summary.json: the only thing the web app's import accepts.

    It holds the name, date range, number of transactions, total and (unless
    --no-categories) the total per category. No dates of individual purchases,
    no merchants, no amounts per transaction: those stay on this computer.
    """
    src = Path(args.csv)
    if not src.is_file():
        sys.exit(f"File not found: {src}")
    total, dates, by_category, skipped = read_split_csv(src)

    summary = {
        "format": "split-summary",
        "version": 1,
        "name": args.name or default_name(dates),
        "start": min(dates).isoformat(),
        "end": max(dates).isoformat(),
        "count": len(dates),
        "total_cents": cents(total),
    }
    if not args.no_categories:
        summary["categories"] = {cat: cents(by_category[cat]) for cat in sorted(by_category)}

    out = Path(args.output)
    out.write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Summarized {len(dates)} transaction(s) from {src.name}"
          + (f" ({skipped} skipped as invalid)" if skipped else "") + f" into {out}:")
    print(f"  {summary['name']}: {fmt(total)}")
    for cat, c in summary.get("categories", {}).items():
        print(f"  {cat:<15}{paint(f'{fmt(Decimal(c) / 100):>12}', 'cyan')}")
    print(f"That file is everything the web app will receive. Open it to check: {out}")


def cmd_import(args, path):
    """Total a split_transactions.csv from the statement script into one entry."""
    src = Path(args.csv)
    if not src.is_file():
        sys.exit(f"File not found: {src}")

    try:
        payer = parse_payer(args.payer)
        share = parse_percent(args.my_share)
        when = parse_date(args.date) if args.date else date.today().isoformat()
    except ValueError as e:
        sys.exit(f"Error: {e}")

    total, dates, by_category, skipped = read_split_csv(src)
    name = args.name or default_name(dates)

    rows = load_ledger(path)
    if any(r["name"] == name for r in rows) and not args.force:
        sys.exit(f"The ledger already has an entry named '{name}'. "
                 "Use --force to add it again, or --name to give it a different name.")

    row = {
        "date": when,
        "type": EXPENSE,
        "payer": payer,
        "amount": f"{money(total):.2f}",
        "my_share": f"{share.normalize():f}",
        "name": name,
    }
    append_row(path, row)

    print(f"Imported {len(dates)} transaction(s) from {src.name}"
          + (f" ({skipped} skipped as invalid)" if skipped else "") + ":")
    for cat in sorted(by_category):
        print(f"  {cat:<15}{paint(f'{fmt(by_category[cat]):>12}', 'cyan')}")
    who = "You" if payer == "me" else "Partner"
    print(f"{paint('Recorded:', 'green')} {who} paid {fmt(total)} for {name} "
          f"(your share {row['my_share']}%).")
    print(describe(current_balance(load_ledger(path))))


def cmd_balance(args, path):
    rows = load_ledger(path)
    if not rows:
        print("Ledger is empty. All settled up.")
        return
    print(describe(current_balance(rows)))


def cmd_history(args, path):
    rows = load_ledger(path)
    if not rows:
        print("Ledger is empty.")
        return
    if args.limit:
        shown = rows[-args.limit:]
        running = current_balance(rows[:-args.limit])
    else:
        shown, running = rows, Decimal("0.00")

    print(paint(f"{'Date':<11}{'Entry':<22}{'Amount':>11}  {'Balance':>14}  Name", "bold"))
    print(paint("-" * 78, "dim"))
    for r in shown:
        running += effect(r)
        kind = r["type"]
        if kind == EXPENSE:
            label = f"{'You' if r['payer'] == 'me' else 'Partner'} paid"
            if r["my_share"] and Decimal(r["my_share"]) != 50:
                label += f" ({r['my_share']}%)"
        elif kind == SETTLEMENT:
            label = f"{'You' if r['payer'] == 'me' else 'Partner'} settled"
        elif kind == OPENING_ME:
            label = "Start: you owe"
        else:
            label = "Start: partner owes"
        sign = "+" if running > 0 else "-" if running < 0 else " "
        bal_txt = f"{sign + fmt(running):>14}"
        bal_color = "green" if running > 0 else "red" if running < 0 else "dim"
        label_color = "cyan" if kind == SETTLEMENT else "magenta" if kind.startswith("opening") else None
        label_txt = f"{label:<22}"
        date_txt = f"{r['date']:<11}"
        print(f"{paint(date_txt, 'dim')}"
              f"{paint(label_txt, label_color) if label_color else label_txt}"
              f"{fmt(Decimal(r['amount'])):>11}  "
              f"{paint(bal_txt, bal_color)}  {r['name']}")
    print(paint("-" * 78, "dim"))
    print(describe(running))
    print(paint("(+ = partner owes you, - = you owe partner)", "dim"))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--ledger", default=argparse.SUPPRESS,
                        help="Ledger CSV file (default: ledger.csv)")
    common.add_argument("--no-color", action="store_true", default=argparse.SUPPRESS,
                        help="Disable colored output")

    ap = argparse.ArgumentParser(description="Track shared expenses and who owes whom.",
                                 parents=[common])
    sub =ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("add", parents=[common], help="Record an expense")
    p.add_argument("amount", nargs="?", help="Amount paid (prompts if omitted)")
    p.add_argument("payer", nargs="?", help="'me' or 'partner' (prompts if omitted)")
    p.add_argument("name", nargs="*",
                   help="Name of the payment, e.g. groceries (prompts if omitted)")
    p.add_argument("--date", help="YYYY-MM-DD (default: today)")
    p.add_argument("--my-share", default="50",
                   help="Your percentage of this expense (default: 50)")
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("init", parents=[common], help="Set a starting deficit")
    p.add_argument("--i-owe", metavar="AMOUNT", help="You owe partner this much")
    p.add_argument("--partner-owes", metavar="AMOUNT", help="Partner owes you this much")
    p.add_argument("--date", help="YYYY-MM-DD (default: today)")
    p.add_argument("--force", action="store_true",
                   help="Allow adding a starting balance even if one exists")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("settle", parents=[common],
                       help="Record a payment between you (omit amount to settle fully)")
    p.add_argument("amount", nargs="?", help="Amount paid (default: full balance)")
    p.add_argument("payer", nargs="?", help="Who made the payment: 'me' or 'partner'")
    p.add_argument("--name", help="Name for the settlement (default: Settlement)")
    p.add_argument("--date", help="YYYY-MM-DD (default: today)")
    p.set_defaults(func=cmd_settle)

    p = sub.add_parser("import", parents=[common],
                       help="Add the total of a split_transactions.csv as one entry")
    p.add_argument("csv", help="CSV from split_statements.py")
    p.add_argument("--payer", default="me",
                   help="Who paid these expenses: 'me' (default) or 'partner'")
    p.add_argument("--my-share", default="50",
                   help="Your percentage of the total (default: 50)")
    p.add_argument("--name", help="Override the entry name (default: Expenses mm/dd/yy-mm/dd/yy)")
    p.add_argument("--date", help="Ledger date YYYY-MM-DD (default: today)")
    p.add_argument("--force", action="store_true",
                   help="Allow importing even if an entry with the same name exists")
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("summarize", parents=[common],
                       help="Write split_summary.json (totals only) for the web app's import")
    p.add_argument("csv", help="CSV from split-statements")
    p.add_argument("-o", "--output", default="split_summary.json",
                   help="Where to write the summary (default: split_summary.json)")
    p.add_argument("--name", help="Override the entry name (default: Expenses mm/dd/yy-mm/dd/yy)")
    p.add_argument("--no-categories", action="store_true",
                   help="Leave out the per-category totals; only the overall total is kept")
    p.set_defaults(func=cmd_summarize)

    p = sub.add_parser("balance", parents=[common], help="Show who owes whom")
    p.set_defaults(func=cmd_balance)

    p = sub.add_parser("history", parents=[common], help="Show entries with running balance")
    p.add_argument("-n", "--limit", type=int, help="Only show the last N entries")
    p.set_defaults(func=cmd_history)

    args = ap.parse_args()
    if getattr(args, "no_color", False):
        global USE_COLOR
        USE_COLOR = False
    try:
        args.func(args, Path(getattr(args, "ledger", "ledger.csv")))
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled.")


if __name__ == "__main__":
    main()
