"""Reading the transaction downloads banks offer besides PDFs: CSV, and OFX/QFX.

Each reader returns transactions shaped like the PDF parser's: {date, amount,
vendor, direction, _key}. `_key` identifies the transaction without the file
name, so downloading an overlapping date range again doesn't ask twice.
"""

import csv
import html
import io
import re
from collections import Counter
from datetime import datetime

# Header names, lowercased. Earlier ones win when a file has several.
DATE_COLUMNS = ("transaction date", "trans. date", "trans date", "date", "posted date", "posting date", "post date")
DESC_COLUMNS = ("description", "payee", "merchant", "name", "transaction description", "details", "memo")
AMOUNT_COLUMNS = ("amount", "transaction amount", "amount (usd)")
DEBIT_COLUMNS = ("debit", "debit amount", "withdrawal", "withdrawals", "money out", "charges")
CREDIT_COLUMNS = ("credit", "credit amount", "deposit", "deposits", "money in")

DATE_FORMATS = ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%Y/%m/%d", "%m-%d-%Y")

SIGNS = ("auto", "negative-out", "positive-out")


def clean_vendor(desc):
    desc = re.sub(r"\s+", " ", desc).strip()
    return re.sub(r"\s+(?:#|ref|id)?\s?\d{6,}$", "", desc, flags=re.I)


def parse_date(raw):
    raw = raw.strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return None


def parse_money(raw):
    """A signed amount, or None. Handles $, commas, (12.34) and 12.34- for negatives."""
    s = (raw or "").strip()
    if not s:
        return None
    neg = s.startswith("-") or s.endswith("-") or (s.startswith("(") and s.endswith(")"))
    digits = re.sub(r"[^\d.]", "", s)
    if not digits or digits == ".":
        return None
    try:
        value = float(digits)
    except ValueError:
        return None
    return -value if neg else value


def read_text(path):
    data = path.read_bytes()
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("latin-1")


def find(header, names):
    """The index of the first of `names` in the header row, or None."""
    cells = [h.strip().lower() for h in header]
    for name in names:
        if name in cells:
            return cells.index(name)
    return None


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------


def find_header(rows):
    """The header row's index and its (date, description, amount, debit, credit) columns.

    It's the first row naming a date, a description and an amount; some banks put a
    summary above it.
    """
    for i, header in enumerate(rows[:40]):
        cols = tuple(
            find(header, names) for names in (DATE_COLUMNS, DESC_COLUMNS, AMOUNT_COLUMNS, DEBIT_COLUMNS, CREDIT_COLUMNS)
        )
        date_i, desc_i, amount_i, debit_i, _ = cols
        if date_i is not None and desc_i is not None and (amount_i is not None or debit_i is not None):
            return i, cols
    raise ValueError("no header row with a date, a description and an amount")


def cell(row, i):
    return row[i] if i is not None and i < len(row) else ""


def parse_csv(path, sign="auto"):
    """Transactions in a bank's CSV download, and a note on how amounts were read.

    Banks don't agree on which sign is money out: checking accounts and most cards
    show purchases as negative, some cards as positive. With one amount column,
    `sign` says which; "auto" goes with whatever most rows are, since most rows
    are purchases. Separate debit and credit columns need no guessing.
    """
    rows = list(csv.reader(io.StringIO(read_text(path))))
    start, cols = find_header(rows)
    date_i, desc_i, amount_i, debit_i, credit_i = cols

    found = []  # (date, signed amount, vendor) with signed: negative = money out
    two_columns = amount_i is None
    raw_signs = Counter()
    for row in rows[start + 1 :]:
        date = parse_date(cell(row, date_i))
        vendor = clean_vendor(cell(row, desc_i))
        if not date or not vendor:
            continue
        if two_columns:
            out, inn = parse_money(cell(row, debit_i)), parse_money(cell(row, credit_i))
            if out:
                found.append((date, -abs(out), vendor))
            elif inn:
                found.append((date, abs(inn), vendor))
        else:
            amount = parse_money(cell(row, amount_i))
            if amount:
                raw_signs["-" if amount < 0 else "+"] += 1
                found.append((date, amount, vendor))

    note = "debit and credit columns"
    if not two_columns:
        if sign == "auto":
            sign = "positive-out" if raw_signs["+"] > raw_signs["-"] else "negative-out"
            note = f"auto: amounts {'above' if sign == 'positive-out' else 'below'} zero read as money out"
        else:
            note = f"amounts {'above' if sign == 'positive-out' else 'below'} zero read as money out"
        if sign == "positive-out":
            found = [(d, -a, v) for d, a, v in found]

    seen = Counter()
    txns = []
    for date, amount, vendor in found:
        direction = "out" if amount < 0 else "in"
        text = f"{abs(amount):.2f}"
        seen[(date, text, vendor, direction)] += 1
        n = seen[(date, text, vendor, direction)]
        txns.append(
            {
                "date": date,
                "amount": text,
                "vendor": vendor,
                "direction": direction,
                "_key": f"csv|{date}|{text}|{vendor}|{direction}|{n}",
            }
        )
    return txns, note


# ---------------------------------------------------------------------------
# OFX / QFX (Quicken and Money downloads): both the old SGML style and XML
# ---------------------------------------------------------------------------


def ofx_field(block, tag):
    m = re.search(rf"<{tag}>\s*([^<\r\n]*)", block, re.I)
    return html.unescape(m.group(1).strip()) if m else ""


def parse_ofx(path):
    """Transactions in an OFX or QFX file. Negative amounts are money out (the format says so)."""
    text = read_text(path)
    if "<OFX" not in text.upper():
        raise ValueError("not an OFX file")
    txns = []
    # Each account's statement, so transaction ids from two accounts can't collide.
    statements = re.split(r"<ACCTID>", text, flags=re.I)
    for part in statements[1:] if len(statements) > 1 else statements:
        account = re.match(r"\s*([^<\r\n]*)", part).group(1).strip() if len(statements) > 1 else ""
        blocks = re.findall(r"<STMTTRN>(.*?)</STMTTRN>", part, re.I | re.S)
        if not blocks:  # some files never close the tag
            blocks = re.split(r"<STMTTRN>", part, flags=re.I)[1:]
        for block in blocks:
            amount = parse_money(ofx_field(block, "TRNAMT"))
            raw_date = ofx_field(block, "DTUSER") or ofx_field(block, "DTPOSTED")
            date = parse_date(f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:8]}") if len(raw_date) >= 8 else None
            vendor = clean_vendor(ofx_field(block, "NAME") or ofx_field(block, "MEMO"))
            if not amount or not date or not vendor:
                continue
            fitid = ofx_field(block, "FITID")
            direction = "out" if amount < 0 else "in"
            text_amount = f"{abs(amount):.2f}"
            key = f"ofx|{account}|{fitid}" if fitid else f"ofx|{account}|{date}|{text_amount}|{vendor}|{direction}"
            txns.append({"date": date, "amount": text_amount, "vendor": vendor, "direction": direction, "_key": key})
    return txns


def is_export(path):
    return path.suffix.lower() in (".csv", ".ofx", ".qfx")


def read_export(path, csv_sign="auto"):
    """(transactions, note) for a CSV, OFX or QFX file."""
    if path.suffix.lower() == ".csv":
        return parse_csv(path, csv_sign)
    return parse_ofx(path), "OFX"
