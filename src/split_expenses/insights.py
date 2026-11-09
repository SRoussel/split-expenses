"""split-insights: every transaction on this computer, in a local analytics page.

Reads the transaction CSVs that split-statements writes (the current batch, each
person's data/<name>/ batch, and everything in archive/) and serves them, with the
desktop page, on http://127.0.0.1. Nothing leaves this computer.

Changes you make on the page (merchant names, categories, shared or personal) are
kept in desktop-data/, the page's own folder, and go into the summaries it exports
for the phone app. The scripts' files aren't touched, except vendor rules when you
ask for one ("always file it like this"), which go where split-statements keeps them.

Usage:
    uv run split-insights                 # opens the page in your browser
    uv run split-insights --port 8800 --no-open
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
import webbrowser
from collections import Counter
from datetime import datetime
from decimal import Decimal, InvalidOperation
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from . import balances
    from .categories import INCOME, SPENDING, current
except ImportError:  # run as a plain script
    import balances
    from categories import INCOME, SPENDING, current

FILES = {"split_transactions.csv": "shared", "personal_transactions.csv": "personal"}
KINDS = ("shared", "personal")
DESKTOP = "desktop-data"  # the page's own files
ME = "me"  # whose statements the files at the top level (and directly in archive/) are

# The built page. `npm run build:desktop` in web/ writes it.
STATIC = Path(__file__).resolve().parents[2] / "web" / "dist-desktop"


# ---------------------------------------------------------------------------
# Reading the files
# ---------------------------------------------------------------------------


def find_batches(root):
    """Every folder holding transaction CSVs, with whose they are, newest first.

    Newest is by when the files were last written, so a batch you went through
    again wins over an older copy of the same statements.
    """
    root = Path(root)
    found = []

    def add(folder, person):
        files = [folder / name for name in FILES if (folder / name).is_file()]
        if files:
            found.append(
                {"dir": folder, "person": person, "files": files, "mtime": max(f.stat().st_mtime for f in files)}
            )

    add(root, ME)
    data = root / "data"
    if data.is_dir():
        for d in sorted(p for p in data.iterdir() if p.is_dir()):
            add(d, d.name)
    archive = root / "archive"
    if archive.is_dir():
        for d in sorted(p for p in archive.iterdir() if p.is_dir()):
            if any((d / name).is_file() for name in FILES):
                add(d, ME)
            else:  # archive/<person>/<date>/
                for sub in sorted(p for p in d.iterdir() if p.is_dir()):
                    add(sub, d.name)
    found.sort(key=lambda b: b["mtime"], reverse=True)
    return found


def to_cents(raw):
    try:
        d = Decimal(str(raw).replace("$", "").replace(",", "").strip())
    except InvalidOperation:
        return None
    return int((d * 100).to_integral_value())


def read_batch(batch):
    """Rows from one batch's CSVs. Bad rows are skipped and counted."""
    rows, skipped = [], 0
    allowed = set(SPENDING) | {INCOME}
    for path in batch["files"]:
        kind = FILES[path.name]
        with open(path, newline="") as f:
            for r in csv.DictReader(f):
                cents = to_cents(r.get("amount", ""))
                date = (r.get("date") or "").strip()
                try:
                    datetime.strptime(date, "%Y-%m-%d")
                except ValueError:
                    skipped += 1
                    continue
                if cents == 0:  # $0.00 lines, like interest that wasn't charged
                    continue
                if cents is None:
                    skipped += 1
                    continue
                cat = current((r.get("category") or "").strip().lower())
                if cat in ("", "uncategorized") or cat not in allowed:
                    cat = "other"
                rows.append(
                    {
                        "date": date,
                        "cents": cents,
                        "vendor": (r.get("vendor") or "").strip(),
                        "category": cat,
                        "kind": kind,
                    }
                )
    return rows, skipped


def load(root, edited=True):
    """All transactions, each counted once, plus a report on where they came from.

    The same statements can sit in more than one batch (an archived copy and a
    re-review, say). A transaction is matched on person, date, amount and vendor,
    and the newest batch that has it decides its category and whether it's shared.
    Repeats within one batch are real (two coffees on the same day) and all kept.
    """
    root = Path(root)
    claimed = set()
    out, sources = [], []
    for batch in find_batches(root):
        rows, skipped = read_batch(batch)
        person = batch["person"]
        keys = Counter()
        kept = 0
        for r in rows:
            key = (person, r["date"], r["cents"], r["vendor"])
            if key in claimed:
                continue
            keys[key] += 1
            n = keys[key]
            ident = hashlib.sha1(f"{person}|{r['date']}|{r['cents']}|{r['vendor']}|{n}".encode()).hexdigest()[:12]
            out.append({"id": ident, "person": person, "source": rel(batch["dir"], root), **r})
            kept += 1
        claimed.update(keys)
        sources.append(
            {
                "dir": rel(batch["dir"], root),
                "person": person,
                "rows": len(rows),
                "kept": kept,
                "skipped": skipped,
                "updated": datetime.fromtimestamp(batch["mtime"]).isoformat(timespec="seconds"),
            }
        )
    names = merchant_names([t["vendor"] for t in out])
    renamed = read_renames(root)
    edits = read_edits(root) if edited else {}
    for t in out:
        t["auto"] = names[t["vendor"]]  # the cleaned-up name, before your renames
        t["merchant"] = renamed.get(t["auto"], t["auto"])
        e = edits.get(t["id"])
        if e and (e["category"], e["kind"]) != (t["category"], t["kind"]):
            t["original"] = {"category": t["category"], "kind": t["kind"]}
            t["category"], t["kind"] = e["category"], e["kind"]
    out.sort(key=lambda t: (t["date"], t["id"]), reverse=True)
    return {
        "transactions": out,
        "sources": sources,
        "sent": sent(root),
        "categories": SPENDING,
        "income": INCOME,
        "me": ME,
    }


# ---------------------------------------------------------------------------
# The page's own files, in desktop-data/
#
# merchant_names.json  {"Owl and Turtle Bookshop a": "Owl & Turtle Bookshop", ...}
#     Keyed by the cleaned-up name, so one rename covers every way the bank spells it.
#     Giving two merchants the same name merges them.
# edits.json           {"<transaction id>": {"category": "groceries", "kind": "shared"}, ...}
#     Your changes to how a transaction is filed. Only differences are kept.
# ---------------------------------------------------------------------------

MAX_NAME = 80
MAX_CHANGES = 5000


def desktop_file(root, name):
    return Path(root) / DESKTOP / name


def read_json(path):
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(dict(sorted(data.items())), indent=2) + "\n")
    tmp.replace(path)


def read_renames(root):
    path = desktop_file(root, "merchant_names.json")
    old = Path(root) / ".merchant_names.json"  # where the first version kept them
    if not path.exists() and old.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        old.replace(path)
    return {k: v for k, v in read_json(path).items() if isinstance(k, str) and isinstance(v, str) and v.strip()}


def rename(root, names, to):
    """Show every merchant in `names` (cleaned-up names) as `to`. `to` None puts them back."""
    if not isinstance(names, list) or not names or not all(isinstance(n, str) and n for n in names):
        raise ValueError("names must be a list of merchant names")
    if to is not None:
        if not isinstance(to, str) or not to.strip():
            raise ValueError("the new name can't be empty")
        to = " ".join(to.split())
        if len(to) > MAX_NAME:
            raise ValueError(f"keep the name under {MAX_NAME} characters")
    renames = read_renames(root)
    for n in names:
        if to is None or to == n:
            renames.pop(n, None)
        else:
            renames[n] = to
    write_json(desktop_file(root, "merchant_names.json"), renames)
    return renames


def valid_filing(category, kind):
    if kind not in KINDS:
        raise ValueError("kind must be shared or personal")
    if category not in SPENDING and category != INCOME:
        raise ValueError(f"unknown category: {category!r}")
    if category == INCOME and kind == "shared":
        raise ValueError("income can't be shared")


def read_edits(root):
    out = {}
    for k, v in read_json(desktop_file(root, "edits.json")).items():
        if isinstance(v, dict):
            v = {**v, "category": current(v.get("category"))}
            try:
                valid_filing(v.get("category"), v.get("kind"))
            except ValueError:
                continue
            out[k] = {"category": v["category"], "kind": v["kind"]}
    return out


def classify(root, changes):
    """File transactions differently: [{"id": ..., "category": ..., "kind": ...}, ...].

    Each change says how the transaction should end up; setting it back to what the
    CSV says removes the edit.
    """
    if not isinstance(changes, list) or not changes or len(changes) > MAX_CHANGES:
        raise ValueError("changes must be a non-empty list")
    originals = {t["id"]: (t["category"], t["kind"]) for t in load(root, edited=False)["transactions"]}
    edits = read_edits(root)
    for c in changes:
        if not isinstance(c, dict) or c.get("id") not in originals:
            raise ValueError("unknown transaction")
        valid_filing(c.get("category"), c.get("kind"))
        if (c["category"], c["kind"]) == originals[c["id"]]:
            edits.pop(c["id"], None)
        else:
            edits[c["id"]] = {"category": c["category"], "kind": c["kind"]}
    write_json(desktop_file(root, "edits.json"), edits)
    return edits


def remember(root, rules):
    """Teach split-statements: [{"vendor": raw vendor, "person": ..., "category": ..., "kind": ...}].

    Goes into that person's .split_state.json, the same rule the terminal review
    saves when you answer for a vendor, so their next statements are filed this way.
    """
    try:
        from .split_statements import load_state, save_state, vendor_match_key
    except ImportError:  # run as a plain script
        from split_statements import load_state, save_state, vendor_match_key

    if not isinstance(rules, list) or not rules or len(rules) > MAX_CHANGES:
        raise ValueError("rules must be a non-empty list")
    by_path = {}
    for r in rules:
        if not isinstance(r, dict) or not isinstance(r.get("vendor"), str) or not r["vendor"].strip():
            raise ValueError("each rule needs a vendor")
        valid_filing(r.get("category"), r.get("kind"))
        if r["category"] == INCOME:
            raise ValueError("rules are for spending; income is asked about separately")
        person = r.get("person")
        if person == ME:
            path = Path(root) / ".split_state.json"
        elif isinstance(person, str) and re.fullmatch(r"[a-z0-9_-]{1,40}", person):
            path = Path(root) / "data" / person / ".split_state.json"
        else:
            raise ValueError("unknown person")
        by_path.setdefault(path, {})[vendor_match_key(r["vendor"])] = {
            "split" if r["kind"] == "shared" else "self": r["category"]
        }
    for path, new in by_path.items():
        try:
            state = load_state(path)
        except SystemExit as e:  # it refuses to guess about a damaged file; so do we
            raise ValueError(str(e)) from None
        state["vendor_rules"].update(new)
        save_state(path, state)
    return sum(len(v) for v in by_path.values())


# ---------------------------------------------------------------------------
# Exporting a summary for the phone app
#
# The same split_summary.json that `split-ledger finish` writes (totals per month and
# category, nothing else), made from what this page shows, refilings included.
# ---------------------------------------------------------------------------

MAX_SUMMARY_NAME = 200  # the web app's limit


def sent(root):
    """What has already gone to the phone app, as far as this computer knows:
    summaries `finish` archived, and files exported from this page. Newest first."""
    root = Path(root)
    out = []
    archive = root / "archive"
    for path in sorted(archive.rglob("split_summary.json")) if archive.is_dir() else []:
        parts = path.relative_to(archive).parts
        d = read_json(path)
        if d.get("format") == "split-summary" and isinstance(d.get("start"), str) and isinstance(d.get("end"), str):
            person = ME if len(parts) == 2 else parts[0]
            out.append(
                {
                    "person": person,
                    "name": d.get("name", ""),
                    "start": d["start"],
                    "end": d["end"],
                    "from": rel(path.parent, root),
                }
            )
    for e in read_json(desktop_file(root, "exports.json")).get("exports", []):
        if isinstance(e, dict) and all(isinstance(e.get(k), str) for k in ("person", "name", "start", "end")):
            how = "sent to the app" if e.get("how") == "app" else "exported here"
            out.append({**{k: e[k] for k in ("person", "name", "start", "end")}, "from": how})
    return sorted(out, key=lambda e: e["end"], reverse=True)


def build_summary(txns, name=None, personal=True):
    """A split_summary.json (version 2) from transactions, exactly as split-ledger writes it."""

    def months(rows):
        by = {}
        for t in rows:
            cats = by.setdefault(t["date"][:7], {})
            cats[t["category"]] = cats.get(t["category"], 0) + t["cents"]
        return {m: dict(sorted(c.items())) for m, c in sorted(by.items())}

    shared = [t for t in txns if t["kind"] == "shared"]
    mine = [t for t in txns if t["kind"] == "personal"] if personal else []
    if shared and sum(t["cents"] for t in shared) <= 0:
        shared = []  # returns only: nothing for the ledger
    if not shared and not mine:
        raise ValueError("there's nothing to export in those dates")
    mine_months = months(mine)
    for m, cats in mine_months.items():
        if cats.get(INCOME, 0) < 0:
            raise ValueError(f"income in {m} adds up to less than zero; check how it's filed")

    dates = sorted(t["date"] for t in shared + mine)
    start, end = dates[0], dates[-1]
    if not name:
        fmt = lambda d: datetime.strptime(d, "%Y-%m-%d").strftime("%m/%d/%y")  # noqa: E731
        name = f"Expenses {fmt(start)}-{fmt(end)}"
    summary = {"format": "split-summary", "version": 2, "name": name, "start": start, "end": end}
    if shared:
        summary["shared"] = {
            "count": len(shared),
            "total_cents": sum(t["cents"] for t in shared),
            "months": months(shared),
        }
    if mine:
        summary["personal"] = {"count": len(mine), "months": mine_months}
    return summary


def summary_for(root, body):
    """The summary for one person's transactions between two dates, from what this page shows."""
    if not isinstance(body, dict):
        raise ValueError("bad request")
    person, start, end = body.get("person"), body.get("start"), body.get("end")
    for d in (start, end):
        if not isinstance(d, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
            raise ValueError("dates must look like 2026-01-31")
    if start > end:
        raise ValueError("the start date is after the end date")
    name = body.get("name")
    if name is not None:
        if not isinstance(name, str):
            raise ValueError("bad name")
        name = " ".join(name.split())[:MAX_SUMMARY_NAME] or None
    everything = load(root)["transactions"]
    if not any(t["person"] == person for t in everything):
        raise ValueError("unknown person")
    txns = [t for t in everything if t["person"] == person and start <= t["date"] <= end]
    return person, build_summary(txns, name, personal=body.get("personal", True) is not False)


def note_sent(root, person, summary, how):
    """Remember what went to the phone app, so the next export starts after it."""
    path = desktop_file(root, "exports.json")
    log = [e for e in read_json(path).get("exports", []) if isinstance(e, dict)]
    log.append(
        {
            "person": person,
            "name": summary["name"],
            "start": summary["start"],
            "end": summary["end"],
            "how": how,
            "exported": datetime.now().isoformat(timespec="seconds"),
        }
    )
    write_json(path, {"exports": log})


def export(root, body):
    """Make the summary as a file for the phone app to import, and note it was exported."""
    person, summary = summary_for(root, body)
    note_sent(root, person, summary, "file")
    filename = f"split_summary-{person}-{summary['start']}-to-{summary['end']}.json"
    saved = None
    if body.get("save") is True:  # the desktop app: no browser downloads, so save it here
        folder = downloads_dir()
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / filename
        path.write_text(json.dumps(summary, indent=2) + "\n")
        saved = str(path)
    return {"summary": summary, "filename": filename, "saved": saved, "data": load(root)}


# ---------------------------------------------------------------------------
# Sending straight to the app, with a desktop key from `npm run desktop-key`
# (desktop-data/app.json). The key stays here: the page never sees it.
# ---------------------------------------------------------------------------

APP_TIMEOUT = 20


def safe_app_url(url):
    """HTTPS only, so the key is never sent in the clear; plain HTTP just to this computer, for trying it out."""
    return isinstance(url, str) and bool(
        re.fullmatch(r"https://[^/\s]+/?", url) or re.fullmatch(r"http://(?:localhost|127\.0\.0\.1)(?::\d+)?/?", url)
    )


def app_config(root):
    cfg = read_json(desktop_file(root, "app.json"))
    url, key = cfg.get("url"), cfg.get("key")
    if safe_app_url(url) and isinstance(key, str) and re.fullmatch(r"split_[\w-]{43}", key):
        return {"url": url.rstrip("/"), "key": key}
    return None


class NoRedirects(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: urllib would send the key along to wherever it points."""

    def redirect_request(self, *_args, **_kwargs):
        return None


APP_OPENER = urllib.request.build_opener(NoRedirects)


def app_call(cfg, method, path, body=None):
    """One request to the app. Its error messages come back as ValueError, ready to show."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(cfg["url"] + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {cfg['key']}")
    req.add_header("User-Agent", "split-insights")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with APP_OPENER.open(req, timeout=APP_TIMEOUT) as res:
            return json.loads(res.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            message = json.loads(e.read()).get("error")
        except (ValueError, AttributeError):
            message = None
        if 300 <= e.code < 400:
            message = f"the app's address redirects elsewhere; check the address in {DESKTOP}/app.json"
        raise ValueError(message or f"the app said {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        reason = getattr(e, "reason", e)
        raise ValueError(f"couldn't reach the app at {cfg['url']} ({reason})") from None


def app_status(root):
    """For the page: is a key set up, and if so, who's in the household and what's uploaded."""
    cfg = app_config(root)
    if not cfg:
        return {"connected": False}
    try:
        household = app_call(cfg, "GET", "/api/desktop/household")
    except ValueError as e:
        return {"connected": True, "url": cfg["url"], "error": str(e)}
    people = people_in_app(household)
    uploads = [
        {**u, "person": people.get(u.get("person_id"))}
        for u in household.get("uploads", [])
        if isinstance(u, dict) and people.get(u.get("person_id"))
    ]
    return {"connected": True, "url": cfg["url"], "uploads": uploads}


def people_in_app(household):
    """App user ids to the names this page uses: the key's owner is "me", the other is the partner.

    The partner's files live in data/<name>/; whatever that name is, it's the one other
    person, since the app holds exactly two.
    """
    me = household.get("me")
    out = {}
    for m in household.get("members", []):
        if isinstance(m, dict):
            out[m.get("user_id")] = ME if m.get("user_id") == me else "partner"
    return out


def send_to_app(root, body):
    """Send the summary to the app, first taking out the uploads it replaces (if asked)."""
    cfg = app_config(root)
    if not cfg:
        raise ValueError("no desktop key yet: run `npm run desktop-key` in web/ first")
    if not isinstance(body, dict):
        raise ValueError("bad request")
    replace = body.get("replace") or []
    if (
        not isinstance(replace, list)
        or len(replace) > 20
        or not all(isinstance(i, str) and re.fullmatch(r"[\w-]{1,64}", i) for i in replace)
    ):
        raise ValueError("bad list of uploads to replace")
    person, summary = summary_for(root, body)

    household = app_call(cfg, "GET", "/api/desktop/household")
    members = {m["user_id"]: m for m in household.get("members", []) if isinstance(m, dict) and "user_id" in m}
    others = [i for i in members if i != household.get("me")]
    person_id = household.get("me") if person == ME else (others[0] if len(others) == 1 else None)
    if person_id not in members:
        raise ValueError("the app's household doesn't have that person yet")

    payload = {
        "name": summary["name"],
        "start": summary["start"],
        "end": summary["end"],
        "today": datetime.now().strftime("%Y-%m-%d"),
    }
    if "shared" in summary:
        payload["shared"] = {
            "total_cents": summary["shared"]["total_cents"],
            "months": summary["shared"]["months"],
            "payer_id": person_id,  # whoever's statement it is paid for these
            "payer_share_pct": members[person_id]["share_pct"],  # their usual share
        }
    if "personal" in summary:
        payload["personal"] = {"person_id": person_id, "months": summary["personal"]["months"]}

    for upload_id in replace:
        app_call(cfg, "POST", f"/api/desktop/uploads/{upload_id}/remove", {})
    try:
        app_call(cfg, "POST", "/api/desktop/import", payload)
    except ValueError as e:
        if replace:
            raise ValueError(f"the old upload was taken out, but sending the new one failed: {e}") from None
        raise
    note_sent(root, person, summary, "app")
    return {"summary": summary, "data": load(root), "app": app_status(root)}


def downloads_dir():
    """Where the desktop app saves exports: SPLIT_DOWNLOADS, else Windows' Downloads when
    running under WSL (where the phone-transfer tools are), else ~/Downloads."""
    if os.environ.get("SPLIT_DOWNLOADS"):
        return Path(os.environ["SPLIT_DOWNLOADS"]).expanduser()
    users = Path("/mnt/c/Users")
    if users.is_dir():
        found = [
            d / "Downloads"
            for d in users.iterdir()
            if (d / "Downloads").is_dir() and d.name not in ("Public", "Default", "Default User", "All Users")
        ]
        if len(found) == 1:
            return found[0]
    return Path.home() / "Downloads"


# ---------------------------------------------------------------------------
# Net worth: your accounts, their balances, and what statements say (balances.py)
# ---------------------------------------------------------------------------


def worth(root):
    root = Path(root)
    people = sorted({t["person"] for t in load(root)["transactions"]} | {ME})
    data = balances.read_accounts(desktop_file(root, "accounts.json"))
    found, problems = balances.statement_balances(root, ME, desktop_file(root, "statement-balances.json"))
    return {
        **data,
        "found": found,
        "problems": problems,
        "types": {k: {"group": g, "debt": d} for k, (g, d) in balances.TYPES.items()},
        "people": people,
        "me": ME,
    }


def change_worth(root, body):
    people = sorted({t["person"] for t in load(root)["transactions"]} | {ME})
    balances.change_accounts(desktop_file(root, "accounts.json"), people, body)
    return worth(root)


def rel(path, root):
    try:
        return str(path.relative_to(root)) or "."
    except ValueError:
        return str(path)


# ---------------------------------------------------------------------------
# Merchant names: "TST* CAFE BLUEBELL 207-555-0100 ME 6462 1111" -> "Cafe Bluebell"
# ---------------------------------------------------------------------------

PROCESSOR = re.compile(r"^(?:TST|SQ|SP|PY|PP|DD|IC|PAYPAL|GOOGLE|APPLE\.COM|SQU)\s?\*\s?|^SP\s+(?=\w)", re.I)
STATE = re.compile(r"\s+(?:[A-Z]{2})$")
CARD_TAIL = re.compile(r"(?:\s+\d{4}){1,2}$")  # card last-four and merchant code
SMALL_WORDS = {"and", "of", "the", "at", "on", "in", "for", "de"}
# First words of two-word cities: "NEW YORK", "SAN DIEGO", "FORT WORTH".
CITY_STARTS = {"new", "san", "los", "las", "st", "fort", "port", "east", "west", "north", "south", "santa", "el"}


def _base(vendor):
    v = re.sub(r"\s+", " ", vendor).strip()
    v = CARD_TAIL.sub("", v)
    v = re.sub(r"\s+DES:.*$", "", v)  # ACH: "CITY POWER DES:CITY POWER PMT ID:..." -> "CITY POWER"
    v = PROCESSOR.sub("", v)
    v = re.sub(r"\*\s?[A-Z0-9]*\d[A-Z0-9]*\b.*$", "", v, flags=re.I)  # "AMAZON MKTPL*AB1CD2E34 ..." -> "AMAZON MKTPL"
    v = re.sub(r"\s*\d{3}-\d{3,}(?:-\d+)?.*$", "", v)  # phone numbers and whatever follows
    v = re.sub(r"(?<=[A-Za-z])-?\d{6,}.*$", "", v)  # "TRANSIT-123456789012", "SKYLINE AIR0012345678901FORT"
    v = re.sub(r"\s+\d{2}/\d{2}\b.*$", "", v)  # "PHARMACY STOR 09/25 #000123456 PURCHASE ..."
    v = re.sub(r"\s+WWW\.\S*.*$", "", v, flags=re.I)
    v = re.sub(r"\s+#\s?\d+.*$", "", v)  # "FRESHWAY #8000 SPRINGFIELD ME"
    v = re.sub(r"\s+\d{3,}\b.*$", "", v)  # "QUICK STOP MART 5600 RIVERTON ME"
    v = re.sub(r"\s+(?:WWW\.)?\S+\.(?:COM|NET|ORG)\S*.*$", "", v, flags=re.I)
    return v.strip(" -*.,")


def _cities(vendors):
    """Words that come right before a state code, like 'SPRINGFIELD' in '... SPRINGFIELD ME'."""
    seen = Counter()
    for v in vendors:
        v = CARD_TAIL.sub("", re.sub(r"\s+", " ", v).strip())
        m = re.search(r"(\S+)\s+[A-Z]{2}$", v)
        if m and not any(c.isdigit() for c in m.group(1)):
            seen[m.group(1).lower()] += 1
    return {w for w, n in seen.items() if n >= 2}


def merchant_names(vendors):
    """A short, readable name per raw vendor string. Unclear cases keep more of the original."""
    cities = _cities(vendors)
    out = {}
    for vendor in set(vendors):
        v = _base(vendor)
        v = STATE.sub("", v)
        v = re.sub(r"\s+\S*[a-z][A-Z]{2}$", "", v)  # "South SpringfiME": city and state run together
        words = v.split()
        shouting = any(w.isupper() for w in words[:2])
        while (
            len(words) > 1
            and (
                words[-1].lower() in cities
                # An all-caps name followed by "Milltown": the city, written the way the card network sends it
                or (shouting and words[-1][:1].isupper() and words[-1][1:].islower() and len(words[-1]) > 2)
            )
        ):
            words.pop()
            if len(words) > 1 and words[-1].lower() in CITY_STARTS:
                words.pop()
        # "FAIRHAVEFAIRHAVEN": a cut-off name with the city glued on
        if len(words) > 1:
            last = words[-1].lower()
            city = next((c for c in cities if last.endswith(c) and len(last) > len(c) + 2), None)
            if city:
                rest = words[-1][: -len(city)]
                if city.startswith(rest.lower()):
                    words.pop()  # the cut-off part was the city too
                else:
                    words[-1] = rest
        while len(words) > 1 and re.fullmatch(r"[-+&/.,:]+", words[-1]):
            words.pop()  # "HILLTOP COFFEE CO. -"
        # "...SPRINGFSpringfield": a city glued onto a cut-off name
        if len(words) > 1:
            words[-1] = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z]+$)\w*$", "", words[-1]) or words[-1]
        out[vendor] = title(" ".join(words)) if words else vendor
    return out


def title(s):
    if not s.isupper():
        return s
    words = s.lower().split()
    cap = partial(re.sub, r"[a-z][a-z']*", lambda m: m.group(0).capitalize())  # "wal-mart" -> "Wal-Mart"
    return " ".join(w if i and w in SMALL_WORDS else cap(w) for i, w in enumerate(words))


# ---------------------------------------------------------------------------
# The local server
# ---------------------------------------------------------------------------


class Handler(SimpleHTTPRequestHandler):
    root = Path(".")
    port = 0

    def addressed_here(self):
        """Only answer requests addressed to this machine by name, so a web page can't
        point its own domain at 127.0.0.1 and read the data (DNS rebinding)."""
        if self.headers.get("Host") in (f"127.0.0.1:{self.port}", f"localhost:{self.port}"):
            return True
        self.send_error(403)
        return False

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.addressed_here():
            return
        # Another site can't read the answers, but it could make the browser ask, and
        # /api/app then calls the app with the key. Browsers mark those requests.
        if self.path.startswith("/api/") and self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
            self.send_error(403)
            return
        if self.path.split("?")[0] == "/api/data":
            self.send_json(200, load(self.root))
            return
        if self.path.split("?")[0] == "/api/app":
            self.send_json(200, app_status(self.root))
            return
        if self.path.split("?")[0] == "/api/worth":
            self.send_json(200, worth(self.root))
            return
        super().do_GET()

    def do_POST(self):
        if not self.addressed_here():
            return
        # Changes only from this page: other sites can't send JSON here without the
        # browser asking first, and they can't fake the Origin header.
        if self.headers.get("Origin") not in (f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}"):
            self.send_error(403)
            return
        if (self.headers.get("Content-Type") or "").split(";")[0] != "application/json":
            self.send_error(415)
            return
        routes = {
            "/api/merchants": lambda b: rename(self.root, b.get("names"), b.get("to")),
            "/api/classify": lambda b: classify(self.root, b.get("changes")),
            "/api/rules": lambda b: remember(self.root, b.get("rules")),
            "/api/export": lambda b: export(self.root, b),
            "/api/app/send": lambda b: send_to_app(self.root, b),
            "/api/worth": lambda b: change_worth(self.root, b),
        }
        if self.path not in routes:
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 1_000_000:
                raise ValueError("too big")
            body = json.loads(self.rfile.read(length))
            result = routes[self.path](body)
        except (ValueError, AttributeError) as e:
            self.send_json(400, {"error": str(e)})
            return
        self.send_json(200, result if self.path in ("/api/export", "/api/app/send", "/api/worth") else load(self.root))

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def log_message(self, *_args):
        pass


def main(argv=None):
    p = argparse.ArgumentParser(prog="split-insights", description=__doc__.split("\n\n")[0])
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-open", action="store_true", help="don't open the browser")
    p.add_argument("--dir", default=".", help="the folder with your transaction files (default: here)")
    args = p.parse_args(argv)

    root = Path(args.dir).resolve()
    data = load(root)
    n = len(data["transactions"])
    if not n:
        sys.exit(f"No transactions in {root}. Run split-statements first.")
    print(f"{n} transactions from {len(data['sources'])} batch(es):")
    for s in data["sources"]:
        dupes = s["rows"] - s["kept"]
        extra = f", {dupes} already in newer files" if dupes else ""
        print(f"  {s['dir']:<40} {s['kept']:>5} kept{extra}")

    static = STATIC if STATIC.is_dir() else root / "web" / "dist-desktop"
    if not (static / "index.html").is_file():
        sys.exit("The page isn't built yet. Run:  cd web && npm run build:desktop")

    Handler.root, Handler.port = root, args.port
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=str(static)))
    url = f"http://127.0.0.1:{args.port}/"
    print(f"\nOpen {url}  (Ctrl+C to stop; reload the page to pick up new files)")
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
