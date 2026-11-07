#!/usr/bin/env python3
"""
Shared-expense ledger: track who paid, and who owes whom.

Every entry is appended to a CSV (default: ledger.csv). The balance is always
derived from that file, so you can inspect or hand-edit it at any time.

Balance convention: positive = partner owes you, negative = you owe partner.

Examples:
    python split_ledger.py init --i-owe 500            # starting deficit
    python split_ledger.py init --partner-owes 600
    python split_ledger.py add 84.20 me groceries      # you paid, split 50/50
    python split_ledger.py add 120 partner power bill  # name can be several words
    python split_ledger.py add 60 me dinner --my-share 70   # you owe 70% of this one
    python split_ledger.py add                         # prompts for amount, payer, name
    python split_ledger.py settle                      # settle the full balance
    python split_ledger.py settle 100 me               # you paid partner $100
    python split_ledger.py balance
    python split_ledger.py history
"""

import argparse
import csv
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
        return f"Partner owes you {fmt(balance)}"
    if balance < 0:
        return f"You owe partner {fmt(balance)}"
    return "All settled up."


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
        my_part = money(amount * my_share / 100)
        partner_part = amount - my_part
        # If I paid, partner owes me their part; if partner paid, I owe my part.
        return partner_part if row["payer"] == "me" else -my_part
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
    print(f"Recorded: {who} paid {fmt(amount)} for {name} (your share {row['my_share']}%).")
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
    print("Starting balance recorded.")
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
    print(f"Recorded: {who} {fmt(amount)}.")
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

    print(f"{'Date':<11}{'Entry':<22}{'Amount':>11}  {'Balance':>14}  Name")
    print("-" * 78)
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
        print(f"{r['date']:<11}{label:<22}{fmt(Decimal(r['amount'])):>11}  "
              f"{sign + fmt(running):>14}  {r['name']}")
    print("-" * 78)
    print(describe(running))
    print("(+ = partner owes you, - = you owe partner)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--ledger", default=argparse.SUPPRESS,
                        help="Ledger CSV file (default: ledger.csv)")

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

    p = sub.add_parser("balance", parents=[common], help="Show who owes whom")
    p.set_defaults(func=cmd_balance)

    p = sub.add_parser("history", parents=[common], help="Show entries with running balance")
    p.add_argument("-n", "--limit", type=int, help="Only show the last N entries")
    p.set_defaults(func=cmd_history)

    args = ap.parse_args()
    try:
        args.func(args, Path(getattr(args, "ledger", "ledger.csv")))
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled.")


if __name__ == "__main__":
    main()
