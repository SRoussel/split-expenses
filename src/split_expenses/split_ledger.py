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
    uv run split-ledger summarize                        # -> split_summary.json (totals only) for the web app
    uv run split-ledger summarize --person sam           # same, from data/sam/
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

try:
    from .categories import INCOME, SPENDING
    from .people import person_dir
except ImportError:  # run as a plain script
    from categories import INCOME, SPENDING
    from people import person_dir

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


def parse_signed_amount(s):
    """An amount from a transactions CSV. Negative = a return. Zero isn't allowed."""
    try:
        d = Decimal(str(s).replace("$", "").replace(",", "").strip())
    except InvalidOperation:
        raise ValueError(f"Not a valid amount: {s!r}")
    if d == 0:
        raise ValueError("Amount can't be zero.")
    return money(d)


def read_txn_csv(src, allowed):
    """Read a transactions CSV from split-statements (date, amount, vendor, category).

    Returns totals only: overall, per category, and per month per category.
    Rows with a bad date or amount are skipped and counted. An unknown
    category stops with an error, so nothing gets silently mislabelled.
    """
    total = Decimal("0.00")
    dates, by_category, by_month, skipped = [], {}, {}, 0
    with open(src, newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or not {"date", "amount"} <= set(reader.fieldnames):
            sys.exit(f"{src}: needs 'date' and 'amount' columns.")
        for line_no, r in enumerate(reader, 2):
            try:
                amt = parse_signed_amount(r["amount"])
                d = datetime.strptime(r["date"].strip(), "%Y-%m-%d").date()
            except (ValueError, AttributeError):
                skipped += 1
                continue
            cat = (r.get("category") or "").strip().lower()
            if cat in ("", "uncategorized"):
                cat = "other"
            if cat not in allowed:
                sys.exit(f"{src}, line {line_no}: unknown category {cat!r}. "
                         f"Use one of: {', '.join(allowed)}.")
            total += amt
            dates.append(d)
            by_category[cat] = by_category.get(cat, Decimal("0.00")) + amt
            month = by_month.setdefault(f"{d:%Y-%m}", {})
            month[cat] = month.get(cat, Decimal("0.00")) + amt
    return {"total": total, "dates": dates, "by_category": by_category,
            "by_month": by_month, "skipped": skipped}


def default_name(dates):
    start, end = min(dates), max(dates)
    return f"Expenses {start:%m/%d/%y}-{end:%m/%d/%y}"


def cents(amount):
    return int(money(amount) * 100)


def months_in_cents(by_month):
    return {m: {c: cents(v) for c, v in sorted(cats.items())} for m, cats in sorted(by_month.items())}


def cmd_summarize(args, _path):
    """Write split_summary.json: the only thing the web app's import accepts.

    Totals per month and category, for the shared transactions and (unless
    --no-personal) your own spending and income. No individual purchases,
    merchants or dates of purchases: those stay on this computer.
    """
    base = person_dir(args.person) if args.person else Path(".")
    split_src = Path(args.csv) if args.csv else base / "split_transactions.csv"
    personal_src = Path(args.personal) if args.personal else base / "personal_transactions.csv"
    out = Path(args.output) if args.output else base / "split_summary.json"
    if args.csv and not split_src.is_file():
        sys.exit(f"File not found: {split_src}")
    if args.personal and not personal_src.is_file():
        sys.exit(f"File not found: {personal_src}")

    shared = read_txn_csv(split_src, SPENDING) if split_src.is_file() else None
    personal = None
    if not args.no_personal and personal_src.is_file():
        personal = read_txn_csv(personal_src, SPENDING + [INCOME])
    if shared and not shared["dates"]:
        shared = None
    if personal and not personal["dates"]:
        personal = None
    if shared and shared["total"] <= 0:
        print(paint("The shared transactions add up to $0 or less (returns only?), so they're left out.", "yellow"))
        shared = None
    if personal and personal["by_category"].get(INCOME, Decimal(0)) < 0:
        sys.exit(f"{personal_src}: income can't be negative.")
    if not shared and not personal:
        sys.exit(f"Nothing to summarize: no transactions in {split_src} or {personal_src}.")

    dates = (shared["dates"] if shared else []) + (personal["dates"] if personal else [])
    summary = {
        "format": "split-summary",
        "version": 2,
        "name": args.name or default_name(dates),
        "start": min(dates).isoformat(),
        "end": max(dates).isoformat(),
    }
    if shared:
        summary["shared"] = {
            "count": len(shared["dates"]),
            "total_cents": cents(shared["total"]),
            "months": months_in_cents(shared["by_month"]),
        }
    if personal:
        summary["personal"] = {
            "count": len(personal["dates"]),
            "months": months_in_cents(personal["by_month"]),
        }

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=2) + "\n")

    print(f"{paint(summary['name'], 'bold')}  ({summary['start']} to {summary['end']})")
    for label, part in (("Shared", shared), ("Personal", personal)):
        if not part:
            continue
        skipped = f", {part['skipped']} skipped as invalid" if part["skipped"] else ""
        print(f"  {label}: {len(part['dates'])} transaction(s){skipped}")
        for cat, amount in sorted(part["by_category"].items()):
            print(f"    {cat:<15}{paint(f'{fmt(amount):>12}', 'cyan')}" + (" (money in)" if cat == INCOME else ""))
    print(f"Wrote {out}. That file is everything the web app will receive; open it to check.")


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

    data = read_txn_csv(src, SPENDING)
    total, dates, by_category, skipped = data["total"], data["dates"], data["by_category"], data["skipped"]
    if not dates:
        sys.exit("No valid transactions found in that CSV.")
    if total <= 0:
        sys.exit("Those transactions add up to $0 or less (returns only?), so there's nothing to import.")
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
    p.add_argument("csv", nargs="?",
                   help="Shared transactions CSV (default: split_transactions.csv, or data/<person>/...)")
    p.add_argument("--personal", help="Personal transactions CSV (default: personal_transactions.csv)")
    p.add_argument("--person", help="Use the files in data/<person>/ (as written by split-statements --person)")
    p.add_argument("--no-personal", action="store_true", help="Leave out personal spending and income")
    p.add_argument("-o", "--output", help="Where to write the summary (default: split_summary.json)")
    p.add_argument("--name", help="Override the entry name (default: Expenses mm/dd/yy-mm/dd/yy)")
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
