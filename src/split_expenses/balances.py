"""Account balances for the desktop page's net worth view.

Two sources. Statements: a PDF's closing balance ("Ending balance on January 9, 2026
$1,234.56" on bank statements, "New Balance Total $1,234.56" on cards) and an OFX
download's <LEDGERBAL>, each with the account's last four digits so it can be matched
to an account you set up once. And balances you type in, for accounts with no
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
STATEMENT_EXTS = (".pdf", ".ofx", ".qfx")
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


def read_statement(path):
    if path.suffix.lower() == ".pdf":
        import pdfplumber  # only needed here, and only when a PDF changed

        with pdfplumber.open(path) as pdf:
            text = "\n".join((p.extract_text() or "") for p in pdf.pages[:3])
        return balance_from_text(text)
    return balance_from_ofx(path.read_bytes().decode("utf-8", "replace"))


def statement_balances(root, me, cache_path):
    """Every closing balance found in statements/ (statements/<name>/ for someone else's), cached by file."""
    root = Path(root)
    folder = root / "statements"
    try:
        cache = json.loads(cache_path.read_text())
    except (OSError, ValueError):
        cache = {}
    found, fresh = [], {}
    files = (
        sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in STATEMENT_EXTS)
        if folder.is_dir()
        else []
    )
    for path in files:
        key = str(path.relative_to(root))
        stamp = f"{path.stat().st_mtime_ns}:{path.stat().st_size}"
        hit = cache.get(key)
        if hit and hit.get("stamp") == stamp:
            result = hit.get("balance")
        else:
            try:
                result = read_statement(path)
            except Exception:  # an unreadable file just has no balance
                result = None
        fresh[key] = {"stamp": stamp, "balance": result}
        if result:
            parts = path.relative_to(folder).parts
            person = parts[0].lower() if len(parts) > 1 else me
            found.append({**result, "person": person, "file": key})
    if fresh != cache:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(fresh, indent=1))
    return found


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
