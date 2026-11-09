"""Account balances for the desktop page's net worth view.

Two sources. Downloads: a PDF statement's closing balance ("Ending balance on January 9, 2026
$1,234.56" on bank statements, "New Balance Total $1,234.56" on cards) and an OFX
download's <LEDGERBAL>, a bank CSV's running balance, or a brokerage's list of holdings
(added up), each with the account's last four digits so it can be matched to an account
you set up once. Statements go in statements/, balance-only downloads in balances/. And balances you type in, for accounts with no
statements here (retirement, a brokerage, the house).

Everything stays in desktop-data/: accounts.json (your accounts and typed balances) and
statement-balances.json (a cache, so the PDFs aren't read again until they change).
"""

import json
import re
import uuid
from datetime import datetime
from pathlib import Path

TYPES = {
    # type: (group, counts as debt)
    "checking": ("cash", False),
    "savings": ("cash", False),
    "investment": ("invested", False),
    "retirement": ("retirement", False),
    "property": ("property", False),
    "other": ("property", False),
    "credit card": ("debt", True),
    "mortgage": ("debt", True),
    "loan": ("debt", True),
}
MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december"


def to_cents(text):
    s = text.replace("$", "").replace(",", "").strip()
    neg = s.startswith("-") or (s.startswith("(") and s.endswith(")"))
    try:
        return round(float(s.strip("-()")) * 100) * (-1 if neg else 1)
    except ValueError:
        return None


def long_date(text):
    try:
        return datetime.strptime(re.sub(r"\s+", " ", text.strip()), "%B %d, %Y").strftime("%Y-%m-%d")
    except ValueError:
        return None


def last4(digits):
    d = re.sub(r"\D", "", digits)
    return d[-4:] if len(d) >= 4 else None


def balance_from_text(text):
    """The closing balance in a statement's text: {ref, kind, date, cents}, or None.

    Bank statements: "Ending balance on <date> $X" and "Account number: 1234 5678 9012".
    Card statements: "New Balance Total $X", with the period's end date taken from a line
    like "Account # 1234 ... ! December 12 - January 11, 2026".
    """
    acct = re.search(r"Account (?:number:|#)\s*([\d ]{8,30}\d)", text, re.I)
    ref = last4(acct.group(1)) if acct else None
    if not ref:
        return None
    bank = re.search(rf"Ending balance on ((?:{MONTHS})\s+\d{{1,2}},\s+\d{{4}})\s+(-?\$?-?[\d,]+\.\d\d)", text, re.I)
    if bank:
        date, cents = long_date(bank.group(1)), to_cents(bank.group(2))
        if date and cents is not None:
            return {"ref": ref, "kind": "bank", "date": date, "cents": cents}
    card = re.search(r"New Balance Total\s+(-?\$?-?[\d,]+\.\d\d)", text, re.I)
    if card:
        period = re.search(
            rf"({MONTHS})\s+(\d{{1,2}}),?\s*(\d{{4}})?\s*(?:-|to)\s*({MONTHS})\s+(\d{{1,2}}),\s*(\d{{4}})", text, re.I
        )
        date = long_date(f"{period.group(4)} {period.group(5)}, {period.group(6)}") if period else None
        cents = to_cents(card.group(1))
        if date and cents is not None:
            return {"ref": ref, "kind": "card", "date": date, "cents": cents}
    return None


def balance_from_ofx(text):
    acct = re.search(r"<ACCTID>\s*([^<\r\n]+)", text, re.I)
    amount = re.search(r"<LEDGERBAL>.*?<BALAMT>\s*([^<\r\n]+)", text, re.I | re.S)
    when = re.search(r"<LEDGERBAL>.*?<DTASOF>\s*(\d{8})", text, re.I | re.S)
    if not (acct and amount and when):
        return None
    ref = last4(acct.group(1))
    cents = to_cents(amount.group(1))
    d = when.group(1)
    if not ref or cents is None:
        return None
    kind = "card" if re.search(r"<CCACCTFROM>", text, re.I) else "bank"
    # Banks disagree on the sign of a card's balance; what's owed is kept positive.
    return {
        "ref": ref,
        "kind": kind,
        "date": f"{d[:4]}-{d[4:6]}-{d[6:8]}",
        "cents": abs(cents) if kind == "card" else cents,
    }


# ---------------------------------------------------------------------------
# CSV downloads: a bank's running balance, or a brokerage's list of holdings
# ---------------------------------------------------------------------------

RUNNING_COLUMNS = ("running bal.", "running balance", "balance", "ledger balance", "available balance")
VALUE_COLUMNS = ("current value", "market value", "total value", "ending value", "value", "market value ($)")
ACCOUNT_COLUMNS = ("account number", "account", "account name", "acct", "account #")
DATE_COLUMNS = ("date", "transaction date", "posted date", "posting date", "post date", "trans. date")
CSV_DATES = ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%b-%d-%Y", "%b %d, %Y", "%B %d, %Y")


def csv_date(text):
    for fmt in CSV_DATES:
        try:
            return datetime.strptime(text.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return None


def ref_from_name(name):
    """The last four digits of an account in a file name ("brokerage-1234.csv"), not a year."""
    groups = [g for g in re.findall(r"(?<!\d)\d{4}(?!\d)", name) if not 1990 <= int(g) <= 2099]
    return groups[-1] if groups else None


def column(header, names):
    cells = [h.strip().lower() for h in header]
    for n in names:
        if n in cells:
            return cells.index(n)
    return None


def balances_from_csv(text, filename, file_date):
    """Balances in a CSV download, one per month at most: [{ref, kind, date, cents}], or a
    reason it couldn't tell. A running-balance column gives the balance on each day; a
    list of holdings gives one total, as of a date in the file (or when it was saved)."""
    import csv
    import io

    rows = [r for r in csv.reader(io.StringIO(text))]
    for start, header in enumerate(rows[:40]):
        date_i, running_i = column(header, DATE_COLUMNS), column(header, RUNNING_COLUMNS)
        value_i, account_i = column(header, VALUE_COLUMNS), column(header, ACCOUNT_COLUMNS)
        if date_i is not None and running_i is not None:
            return running_balances(rows[start + 1 :], date_i, running_i, ref_from_name(filename))
        if value_i is not None:
            return holdings_total(rows[start + 1 :], value_i, account_i, text, filename, file_date)
    return "no balance or value column"


def running_balances(rows, date_i, bal_i, ref):
    if not ref:
        return "put the account's last four digits in the file name, like checking-1234.csv"
    points = []
    for r in rows:
        if len(r) <= max(date_i, bal_i):
            continue
        d, cents = csv_date(r[date_i]), to_cents(r[bal_i]) if r[bal_i].strip() else None
        if d and cents is not None:
            points.append((d, cents))
    if not points:
        return "no balances in it"
    # Banks list newest first or oldest first; within a day the last row in time order is the day's balance.
    if points[0][0] > points[-1][0]:
        points.reverse()
    by_month = {}
    for d, cents in points:
        by_month[d[:7]] = (d, cents)
    return [{"ref": ref, "kind": "bank", "date": d, "cents": c} for d, c in by_month.values()]


def holdings_total(rows, value_i, account_i, text, filename, file_date):
    totals, total_rows = {}, {}
    for r in rows:
        if len(r) <= value_i:
            continue
        cents = to_cents(r[value_i]) if re.search(r"\d", r[value_i]) else None
        if cents is None:
            continue
        acct = r[account_i] if account_i is not None and account_i < len(r) else ""
        ref = (re.sub(r"\D", "", acct)[-4:] or None) if re.search(r"\d{4}", acct) else None
        ref = ref or ref_from_name(filename)
        first = next((c.strip() for c in r if c.strip()), "")
        # "Total" or "Account Total" as the row's first word, not a fund named "Total Stock Market".
        if re.match(r"(account )?totals?\b", first, re.I) and value_i != r.index(next(c for c in r if c.strip())):
            total_rows[ref] = cents  # a total row already adds up the others
        else:
            totals[ref] = totals.get(ref, 0) + cents
    if None in total_rows and any(r is not None for r in totals):
        del total_rows[None]  # a grand total across accounts, when each row says its account
    totals.update(total_rows)
    if not totals:
        return "no values in it"
    if None in totals:
        return "put the account's last four digits in the file name, like brokerage-1234.csv"
    as_of = re.search(
        r"(?:as of|date downloaded|downloaded)[^0-9A-Za-z]*([A-Za-z]{3,9}[- ]\d{1,2},?[- ]\d{4}|\d{1,2}/\d{1,2}/\d{2,4})",
        text,
        re.I,
    )
    date = (csv_date(as_of.group(1).replace(",", ", ").replace("  ", " ")) if as_of else None) or file_date
    return [{"ref": ref, "kind": "investment", "date": date, "cents": c} for ref, c in totals.items()]


def read_balances(path):
    """Balances in one file, as a list, or a reason (a string) when it can't tell."""
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        import pdfplumber  # only needed here, and only when a PDF changed

        with pdfplumber.open(path) as pdf:
            text = "\n".join((p.extract_text() or "") for p in pdf.pages[:3])
        found = balance_from_text(text)
        return [found] if found else []
    text = path.read_bytes().decode("utf-8-sig", "replace")
    if suffix == ".csv":
        saved = datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d")
        return balances_from_csv(text, path.name, saved)
    found = balance_from_ofx(text)
    return [found] if found else []


CACHE_VERSION = 2
FOLDERS = {"statements": (".pdf", ".ofx", ".qfx", ".csv"), "balances": (".ofx", ".qfx", ".csv")}


def statement_balances(root, me, cache_path):
    """Every balance in statements/ and balances/ (a subfolder <name>/ for the other person's),
    cached by file. Returns (found, problems): problems are files that look like they should
    have balances but couldn't be matched to an account."""
    root = Path(root)
    try:
        cache = json.loads(cache_path.read_text())
        if cache.get("version") != CACHE_VERSION:
            cache = {}
    except (OSError, ValueError):
        cache = {}
    files_cache = cache.get("files", {})
    found, problems, fresh = [], [], {}
    for name, exts in FOLDERS.items():
        folder = root / name
        if not folder.is_dir():
            continue
        for path in sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in exts):
            key = str(path.relative_to(root))
            stamp = f"{path.stat().st_mtime_ns}:{path.stat().st_size}"
            hit = files_cache.get(key)
            if hit and hit.get("stamp") == stamp:
                result = hit.get("result")
            else:
                try:
                    result = read_balances(path)
                except Exception:  # an unreadable file just has no balance
                    result = []
            fresh[key] = {"stamp": stamp, "result": result}
            parts = path.relative_to(folder).parts
            person = parts[0].lower() if len(parts) > 1 else me
            if isinstance(result, str):
                # A bank CSV in statements/ with no balance column is just transactions: say nothing.
                if name == "balances" or "last four" in result:
                    problems.append({"file": key, "person": person, "reason": result})
                continue
            found += [{**b, "person": person, "file": key} for b in result]
    fresh_cache = {"version": CACHE_VERSION, "files": fresh}
    if fresh_cache != cache:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(fresh_cache, indent=1))
    return found, problems


# ---------------------------------------------------------------------------
# Your accounts and typed-in balances (desktop-data/accounts.json)
# ---------------------------------------------------------------------------


def read_accounts(path):
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        data = {}
    accounts = [a for a in data.get("accounts", []) if isinstance(a, dict) and a.get("type") in TYPES]
    ids = {a.get("id") for a in accounts}
    balances = [
        b
        for b in data.get("balances", [])
        if isinstance(b, dict)
        and b.get("account") in ids
        and isinstance(b.get("cents"), int)
        and valid_date(b.get("date"))
    ]
    return {"accounts": accounts, "balances": balances}


def write_accounts(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(path)


def valid_date(d):
    return isinstance(d, str) and bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", d))


def clean_name(name):
    if not isinstance(name, str) or not name.strip():
        raise ValueError("give the account a name")
    return " ".join(name.split())[:60]


def change_accounts(path, people, body):
    """One change from the page: add or edit an account, or save a set of balances."""
    data = read_accounts(path)
    accounts = {a["id"]: a for a in data["accounts"]}
    op = body.get("op") if isinstance(body, dict) else None

    if op in ("add", "edit"):
        acct = (
            accounts.get(body.get("id"))
            if op == "edit"
            else {"id": uuid.uuid4().hex[:12], "closed": False, "match": None}
        )
        if acct is None:
            raise ValueError("no such account")
        if "name" in body or op == "add":
            acct["name"] = clean_name(body.get("name"))
        if "type" in body or op == "add":
            if body.get("type") not in TYPES:
                raise ValueError("unknown account type")
            acct["type"] = body["type"]
        if "owner" in body or op == "add":
            if body.get("owner") not in [*people, "joint"]:
                raise ValueError("whose account is it?")
            acct["owner"] = body["owner"]
        if "match" in body:
            m = body["match"]
            if m is not None and not (isinstance(m, str) and re.fullmatch(r"\d{4}", m)):
                raise ValueError("match is the last four digits of the account number")
            acct["match"] = m
        if "closed" in body:
            acct["closed"] = bool(body["closed"])
        accounts[acct["id"]] = acct
        data["accounts"] = list(accounts.values())
    elif op == "balances":
        date = body.get("date")
        values = body.get("values")
        if not valid_date(date):
            raise ValueError("pick a date")
        if not isinstance(values, dict) or not values:
            raise ValueError("no balances to save")
        for account_id, cents in values.items():
            if account_id not in accounts:
                raise ValueError("no such account")
            if cents is not None and (not isinstance(cents, int) or abs(cents) > 10**13):
                raise ValueError("balances must be whole cents")
        kept = [b for b in data["balances"] if not (b["date"] == date and b["account"] in values)]
        kept += [{"account": a, "date": date, "cents": c} for a, c in values.items() if c is not None]
        data["balances"] = sorted(kept, key=lambda b: (b["date"], b["account"]))
    elif op == "delete":
        acct_id = body.get("id")
        if acct_id not in accounts:
            raise ValueError("no such account")
        data["accounts"] = [a for a in data["accounts"] if a["id"] != acct_id]
        data["balances"] = [b for b in data["balances"] if b["account"] != acct_id]
    else:
        raise ValueError("unknown change")
    write_accounts(path, data)
    return data
