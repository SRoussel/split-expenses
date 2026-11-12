import csv
import http.client
import json
import os
import tempfile
import threading
import unittest
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from split_expenses import insights
from split_expenses.insights import (
    app_status,
    change_added,
    classify,
    export,
    load,
    merchant_names,
    remember,
    rename,
    send_to_app,
    sent,
)


def write(folder, name, rows, mtime):
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "amount", "vendor", "category"])
        w.writerows(rows)
    os.utime(path, (mtime, mtime))


class LoadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_finds_every_batch_and_whose_it_is(self):
        write(self.root, "split_transactions.csv", [["2026-03-01", "10.00", "A", "dining"]], 300)
        write(self.root / "data" / "jordan", "personal_transactions.csv", [["2026-03-02", "5.00", "B", "gift"]], 300)
        write(
            self.root / "archive" / "2026-02-01",
            "personal_transactions.csv",
            [["2026-01-02", "7.00", "C", "health"]],
            200,
        )
        write(
            self.root / "archive" / "jordan" / "2026-02-01",
            "split_transactions.csv",
            [["2026-01-03", "8.00", "D", "groceries"]],
            200,
        )
        data = load(self.root)
        got = sorted((t["person"], t["vendor"], t["kind"], t["cents"]) for t in data["transactions"])
        self.assertEqual(
            got,
            [
                ("jordan", "B", "personal", 500),
                ("jordan", "D", "shared", 800),
                ("me", "A", "shared", 1000),
                ("me", "C", "personal", 700),
            ],
        )
        self.assertEqual(
            {s["dir"] for s in data["sources"]}, {".", "data/jordan", "archive/2026-02-01", "archive/jordan/2026-02-01"}
        )

    def test_newest_batch_wins_and_older_copies_are_dropped(self):
        old = self.root / "archive" / "old"
        write(
            old,
            "split_transactions.csv",
            [["2026-01-05", "12.00", "CAFE", "dining"], ["2026-01-05", "12.00", "CAFE", "dining"]],
            100,
        )
        write(old, "personal_transactions.csv", [["2026-01-06", "3.00", "ONLY OLD", "other"]], 100)
        # Gone through again: the cafe is now personal, and only once.
        write(self.root, "personal_transactions.csv", [["2026-01-05", "12.00", "CAFE", "dining"]], 200)
        txns = load(self.root)["transactions"]
        cafe = [t for t in txns if t["vendor"] == "CAFE"]
        self.assertEqual(len(cafe), 1)
        self.assertEqual(cafe[0]["kind"], "personal")
        self.assertEqual([t["vendor"] for t in txns if t["vendor"] == "ONLY OLD"], ["ONLY OLD"])

    def test_repeats_within_a_batch_are_real(self):
        rows = [["2026-01-05", "4.50", "COFFEE", "dining"], ["2026-01-05", "4.50", "COFFEE", "dining"]]
        write(self.root, "personal_transactions.csv", rows, 100)
        txns = load(self.root)["transactions"]
        self.assertEqual(len(txns), 2)
        self.assertEqual(len({t["id"] for t in txns}), 2)

    def test_amounts_zero_lines_bad_rows_and_unknown_categories(self):
        rows = [
            ["2026-01-05", "1,200.50", "RENT", "household"],
            ["2026-01-06", "-20.00", "RETURN", "household"],
            ["2026-01-07", "0.00", "INTEREST CHARGED", "fees"],
            ["not a date", "5.00", "X", "other"],
            ["2026-01-08", "abc", "Y", "other"],
            ["2026-01-09", "9.00", "Z", "mystery"],
            ["2026-01-10", "3000", "PAYROLL", "income"],
        ]
        write(self.root, "personal_transactions.csv", rows, 100)
        data = load(self.root)
        got = {t["vendor"]: (t["cents"], t["category"]) for t in data["transactions"]}
        self.assertEqual(
            got,
            {
                "RENT": (120050, "household"),
                "RETURN": (-2000, "household"),
                "Z": (900, "other"),
                "PAYROLL": (300000, "income"),
            },
        )
        self.assertEqual(data["sources"][0]["skipped"], 2)  # the zero line is left out, not counted as bad

    def test_retired_categories_read_as_their_replacement(self):
        from split_expenses.split_statements import load_state

        write(
            self.root,
            "personal_transactions.csv",
            [["2026-01-05", "15.00", "NEWS", "subscriptions"], ["2026-01-06", "2.00", "BANK", "fees"]],
            100,
        )
        self.assertEqual({t["category"] for t in load(self.root)["transactions"]}, {"other"})
        state = self.root / ".split_state.json"
        state.write_text(
            json.dumps(
                {
                    "done": [],
                    "vendor_rules": {
                        "news": {"self": "subscriptions"},
                        "x": "exclude",
                        "in:y": {"return": "fees", "shared": True},
                    },
                }
            )
        )
        self.assertEqual(
            load_state(state)["vendor_rules"],
            {"news": {"self": "other"}, "x": "exclude", "in:y": {"return": "other", "shared": True}},
        )

    def test_nothing_there(self):
        self.assertEqual(load(self.root)["transactions"], [])


class MerchantNameTest(unittest.TestCase):
    def test_card_network_noise_is_removed(self):
        vendors = [
            "TST* CAFE BLUEBELL 207-555-0100 ME 6462 1111",
            "TST* CAFE BLUEBELL RIVERTON ME 3731 1111",
            "SQ *NORTH STAR CAFE Riverton ME 6379 1111",
            "FRESHWAY #8000 SPRINGFIELD ME 7947 2222",
            "FRESHWAY #8100 FAIRHAVEN ME 5846 2222",
            "COSTCO GAS #1000 FAIRHAVEN ME 0050 3333",
            "QUICK STOP MART 5600 RIVERTON ME 8744 3333",
            "AMAZON MKTPL*AB1CD2E34 Amzn.com/billWA 0594 2222",
            "CITY POWER DES:CITY POWER PMT ID:12345678901234 INDN:SOMEONE CO",
            "COPPER KETTLE SPRINGFIELD SPRINGFIELD ME 7460 1111",
            "COPPER KETTLE FAIRHAVEFAIRHAVEN ME 5994 3333",
            "MTA*NYCT PAYGO NEW YORK NY 4310 1111",
            "TST*DUMPLING HUT New York NY 4854 1111",
            "WAL-MART #1900 LAKEVILLE NH 9513 1111",
            "SQ *ROSIE'S Milltown ME 7210 1111",
            "TST*HILLTOP COFFEE CO. - Ashford NC 7851 1111",
            "CIRCLE K 07000 BAYTOWN ME 3760 1111",
            "X BAYTOWN ME 1111 2222",
            "SAFFRON KITCHEN South SpringfiME 1234 1111",
        ]
        names = merchant_names(vendors)
        self.assertEqual(
            [names[v] for v in vendors],
            [
                "Cafe Bluebell",
                "Cafe Bluebell",
                "North Star Cafe",
                "Freshway",
                "Freshway",
                "Costco Gas",
                "Quick Stop Mart",
                "Amazon Mktpl",
                "City Power",
                "Copper Kettle",
                "Copper Kettle",
                "Mta*Nyct Paygo",
                "Dumpling Hut",
                "Wal-Mart",
                "Rosie's",
                "Hilltop Coffee Co.",
                "Circle K",
                "X",
                "Saffron Kitchen",
            ],
        )

    def test_mixed_case_names_are_left_as_written(self):
        self.assertEqual(
            merchant_names(["Green Valley Bikes 833-5552644 NY 6772 1111"]),
            {"Green Valley Bikes 833-5552644 NY 6772 1111": "Green Valley Bikes"},
        )


class RenameTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        rows = [
            ["2026-01-05", "5.00", "OWL AND TURTLE BOOKSHOP A 1234 1111", "gift"],
            ["2026-01-06", "6.00", "OWL & TURTLE BOOKSHOP CAF 1234 1111", "gift"],
            ["2026-01-07", "7.00", "FRESHWAY #8000 1234 1111", "groceries"],
        ]
        write(self.root, "personal_transactions.csv", rows, 100)

    def tearDown(self):
        self.tmp.cleanup()

    def merchants(self):
        return sorted({(t["auto"], t["merchant"]) for t in load(self.root)["transactions"]})

    def test_merge_rename_and_undo(self):
        rename(self.root, ["Owl and Turtle Bookshop A", "Owl & Turtle Bookshop Caf"], "  Owl &   Turtle ")
        self.assertEqual(
            self.merchants(),
            [
                ("Freshway", "Freshway"),
                ("Owl & Turtle Bookshop Caf", "Owl & Turtle"),
                ("Owl and Turtle Bookshop A", "Owl & Turtle"),
            ],
        )
        rename(self.root, ["Owl and Turtle Bookshop A"], None)
        self.assertIn(("Owl and Turtle Bookshop A", "Owl and Turtle Bookshop A"), self.merchants())
        rename(self.root, ["Freshway"], "Freshway")  # same as the cleaned-up name: nothing stored
        self.assertEqual(
            json.loads((self.root / "desktop-data" / "merchant_names.json").read_text()),
            {"Owl & Turtle Bookshop Caf": "Owl & Turtle"},
        )
        self.assertFalse((self.root / ".merchant_names.json").exists())

    def test_renames_from_the_first_version_move_into_the_desktop_folder(self):
        (self.root / ".merchant_names.json").write_text(json.dumps({"Freshway": "Fresh Way"}))
        self.assertIn(("Freshway", "Fresh Way"), self.merchants())
        self.assertFalse((self.root / ".merchant_names.json").exists())
        self.assertTrue((self.root / "desktop-data" / "merchant_names.json").exists())

    def test_bad_input(self):
        for names, to in (([], "X"), (["A"], ""), (["A"], "x" * 81), ("A", "X"), ([1], "X")):
            with self.assertRaises(ValueError):
                rename(self.root, names, to)

    def test_a_broken_file_is_ignored(self):
        (self.root / "desktop-data").mkdir()
        (self.root / "desktop-data" / "merchant_names.json").write_text("{not json")
        self.assertEqual(len(self.merchants()), 3)


class ClassifyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        write(
            self.root, "split_transactions.csv", [["2026-01-05", "40.00", "FRESHWAY #8000 1234 1111", "groceries"]], 100
        )
        write(
            self.root, "personal_transactions.csv", [["2026-01-06", "9.00", "CAFE BLUEBELL 1234 1111", "dining"]], 100
        )
        self.csvs = {p.name: p.read_text() for p in self.root.glob("*.csv")}

    def tearDown(self):
        self.tmp.cleanup()

    def txn(self, vendor):
        return next(t for t in load(self.root)["transactions"] if t["vendor"].startswith(vendor))

    def test_refile_and_put_back(self):
        cafe = self.txn("CAFE")
        classify(self.root, [{"id": cafe["id"], "category": "gift", "kind": "shared"}])
        cafe = self.txn("CAFE")
        self.assertEqual((cafe["category"], cafe["kind"]), ("gift", "shared"))
        self.assertEqual(cafe["original"], {"category": "dining", "kind": "personal"})
        self.assertNotIn("original", self.txn("FRESHWAY"))

        classify(self.root, [{"id": cafe["id"], "category": "dining", "kind": "personal"}])
        self.assertNotIn("original", self.txn("CAFE"))
        self.assertEqual(json.loads((self.root / "desktop-data" / "edits.json").read_text()), {})
        # The scripts' files never change.
        self.assertEqual({p.name: p.read_text() for p in self.root.glob("*.csv")}, self.csvs)

    def test_bad_changes_change_nothing(self):
        cafe = self.txn("CAFE")["id"]
        for changes in (
            [],
            [{"id": "nope", "category": "gift", "kind": "shared"}],
            [{"id": cafe, "category": "rent", "kind": "shared"}],
            [{"id": cafe, "category": "gift", "kind": "both"}],
            [{"id": cafe, "category": "income", "kind": "shared"}],
            [{"id": cafe, "category": "gift", "kind": "shared"}, {"id": "nope", "category": "gift", "kind": "shared"}],
        ):
            with self.assertRaises(ValueError):
                classify(self.root, changes)
        self.assertFalse((self.root / "desktop-data" / "edits.json").exists())

    def test_rules_go_where_split_statements_reads_them(self):
        (self.root / ".split_state.json").write_text(json.dumps({"done": ["x"], "vendor_rules": {"old": "exclude"}}))
        n = remember(
            self.root,
            [
                {"vendor": "FRESHWAY #8000 1234 1111", "person": "me", "category": "household", "kind": "shared"},
                {"vendor": "CAFE BLUEBELL 1234 1111", "person": "jordan", "category": "dining", "kind": "personal"},
            ],
        )
        self.assertEqual(n, 2)
        mine = json.loads((self.root / ".split_state.json").read_text())
        self.assertEqual(mine["done"], ["x"])
        self.assertEqual(mine["vendor_rules"], {"old": "exclude", "freshway": {"split": "household"}})
        theirs = json.loads((self.root / "data" / "jordan" / ".split_state.json").read_text())
        self.assertEqual(theirs["vendor_rules"], {"cafe bluebell": {"self": "dining"}})

    def test_bad_rules(self):
        good = {"vendor": "FRESHWAY", "person": "me", "category": "groceries", "kind": "shared"}
        for bad in ({"person": "../etc"}, {"category": "income", "kind": "personal"}, {"vendor": " "}, {"kind": "x"}):
            with self.assertRaises(ValueError):
                remember(self.root, [{**good, **bad}])
        (self.root / ".split_state.json").write_text("{broken")
        with self.assertRaises(ValueError):
            remember(self.root, [good])
        self.assertEqual((self.root / ".split_state.json").read_text(), "{broken")


FIXTURES = Path(__file__).resolve().parents[1] / "web" / "tests" / "fixtures"


class ExportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for src, dest in (
            ("sample_split_transactions.csv", "split_transactions.csv"),
            ("sample_personal_transactions.csv", "personal_transactions.csv"),
        ):
            (self.root / dest).write_text((FIXTURES / src).read_text())

    def tearDown(self):
        self.tmp.cleanup()

    def test_same_file_as_split_ledger_summarize(self):
        # web/tests/fixtures/expected_summary_v2.json is what split-ledger writes for these files,
        # and what the web app's tests import; the export has to match it byte for byte.
        out = export(self.root, {"person": "me", "start": "2000-01-01", "end": "2100-01-01"})
        self.assertEqual(
            json.dumps(out["summary"], indent=2) + "\n", (FIXTURES / "expected_summary_v2.json").read_text()
        )
        self.assertEqual(out["filename"], "split_summary-me-2026-01-15-to-2026-02-03.json")

    def test_dates_name_refilings_and_leaving_out_personal(self):
        cafe = next(t for t in load(self.root)["transactions"] if t["category"] == "dining" and t["kind"] == "shared")
        classify(self.root, [{"id": cafe["id"], "category": "dining", "kind": "personal"}])
        s = export(self.root, {"person": "me", "start": "2026-01-01", "end": "2026-01-31", "name": "  January  "})[
            "summary"
        ]
        self.assertEqual(s["name"], "January")
        self.assertTrue(s["end"] <= "2026-01-31")
        self.assertNotIn("dining", s["shared"]["months"]["2026-01"])
        self.assertEqual(s["personal"]["months"]["2026-01"]["dining"], 1840 + cafe["cents"])

        s = export(self.root, {"person": "me", "start": "2026-01-01", "end": "2026-12-31", "personal": False})[
            "summary"
        ]
        self.assertNotIn("personal", s)

    def test_the_app_saves_the_file_itself(self):
        downloads = self.root / "dl"
        os.environ["SPLIT_DOWNLOADS"] = str(downloads)
        try:
            out = export(self.root, {"person": "me", "start": "2000-01-01", "end": "2100-01-01", "save": True})
        finally:
            del os.environ["SPLIT_DOWNLOADS"]
        self.assertEqual(out["saved"], str(downloads / out["filename"]))
        self.assertEqual(json.loads(Path(out["saved"]).read_text()), out["summary"])
        self.assertIsNone(export(self.root, {"person": "me", "start": "2000-01-01", "end": "2100-01-01"})["saved"])

    def test_refusals(self):
        for body in (
            {"person": "me", "start": "2030-01-01", "end": "2030-12-31"},
            {"person": "nobody", "start": "2026-01-01", "end": "2026-12-31"},
            {"person": "me", "start": "2026-12-31", "end": "2026-01-01"},
            {"person": "me", "start": "Jan 1", "end": "2026-01-31"},
            "nope",
        ):
            with self.assertRaises(ValueError):
                export(self.root, body)
        self.assertFalse((self.root / "desktop-data" / "exports.json").exists())

    def test_returns_only_shared_part_is_left_out(self):
        write(self.root, "split_transactions.csv", [["2026-03-01", "-20.00", "RETURN", "household"]], 100)
        write(self.root, "personal_transactions.csv", [["2026-03-02", "8.00", "CAFE", "dining"]], 100)
        s = export(self.root, {"person": "me", "start": "2026-03-01", "end": "2026-03-31"})["summary"]
        self.assertNotIn("shared", s)
        self.assertEqual(s["personal"]["months"], {"2026-03": {"dining": 800}})
        with self.assertRaises(ValueError):
            export(self.root, {"person": "me", "start": "2026-03-01", "end": "2026-03-31", "personal": False})

    def test_what_was_sent_already(self):
        summary = json.loads((FIXTURES / "expected_summary_v2.json").read_text())
        for folder in (self.root / "archive" / "2026-02-04", self.root / "archive" / "jordan" / "2026-02-05"):
            folder.mkdir(parents=True)
            (folder / "split_summary.json").write_text(json.dumps(summary))
        export(self.root, {"person": "me", "start": "2026-02-01", "end": "2026-02-28"})
        got = [(e["person"], e["from"], e["start"], e["end"]) for e in sent(self.root)]
        self.assertIn(("me", "archive/2026-02-04", "2026-01-15", "2026-02-03"), got)
        self.assertIn(("jordan", "archive/jordan/2026-02-05", "2026-01-15", "2026-02-03"), got)
        self.assertIn(("me", "exported here", "2026-02-01", "2026-02-03"), got)
        self.assertEqual(load(self.root)["sent"], sent(self.root))


class FakeApp(BaseHTTPRequestHandler):
    """Stands in for the deployed app's desktop routes, and records what it was sent."""

    KEY = "split_" + "k" * 43
    calls = []
    fail_import = False

    def reply(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_any(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        FakeApp.calls.append((method, self.path, body, self.headers.get("Authorization")))
        if self.headers.get("Authorization") != f"Bearer {self.KEY}":
            return self.reply(401, {"error": "This desktop key was revoked or has expired."})
        if self.path == "/api/desktop/household":
            return self.reply(
                200,
                {
                    "me": "u-me",
                    "members": [
                        {"user_id": "u-me", "display_name": "Alex", "share_pct": 60},
                        {"user_id": "u-jo", "display_name": "Jordan", "share_pct": 40},
                    ],
                    "uploads": [
                        {"id": "b1", "person_id": "u-me", "name": "Old", "start": "2026-01-15", "end": "2026-02-03"}
                    ],
                },
            )
        if self.path == "/api/desktop/import":
            if FakeApp.fail_import:
                return self.reply(400, {"error": "Shared: the categories don't add up to the total."})
            return self.reply(201, {"ok": True})
        if self.path.startswith("/api/desktop/uploads/"):
            return self.reply(200, {"ok": True})
        self.reply(404, {"error": "Not found."})

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def log_message(self, *_args):
        pass


class SendToAppTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for src, dest in (
            ("sample_split_transactions.csv", "split_transactions.csv"),
            ("sample_personal_transactions.csv", "personal_transactions.csv"),
        ):
            (self.root / dest).write_text((FIXTURES / src).read_text())
        (self.root / "data" / "jordan").mkdir(parents=True)
        write(self.root / "data" / "jordan", "split_transactions.csv", [["2026-01-20", "30.00", "CAFE", "dining"]], 100)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeApp)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        FakeApp.calls, FakeApp.fail_import = [], False
        self.connect(FakeApp.KEY)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def connect(self, key):
        (self.root / "desktop-data").mkdir(exist_ok=True)
        url = f"http://127.0.0.1:{self.server.server_address[1]}"
        (self.root / "desktop-data" / "app.json").write_text(json.dumps({"url": url, "key": key}))

    def test_not_set_up(self):
        (self.root / "desktop-data" / "app.json").unlink()
        self.assertEqual(app_status(self.root), {"connected": False})
        with self.assertRaises(ValueError):
            send_to_app(self.root, {"person": "me", "start": "2026-01-01", "end": "2026-12-31"})

    def test_status_lists_uploads_without_giving_out_the_key(self):
        status = app_status(self.root)
        self.assertEqual(status["uploads"][0]["person"], "me")
        self.assertNotIn(FakeApp.KEY, json.dumps(status))

    def test_sends_the_same_summary_the_file_would_have(self):
        out = send_to_app(self.root, {"person": "me", "start": "2000-01-01", "end": "2100-01-01"})
        method, path, payload, auth = [c for c in FakeApp.calls if c[1] == "/api/desktop/import"][0]
        self.assertEqual((method, auth), ("POST", f"Bearer {FakeApp.KEY}"))
        expected = json.loads((FIXTURES / "expected_summary_v2.json").read_text())
        self.assertEqual(payload["name"], expected["name"])
        self.assertEqual(payload["shared"]["months"], expected["shared"]["months"])
        self.assertEqual(payload["shared"]["total_cents"], expected["shared"]["total_cents"])
        self.assertEqual(payload["shared"]["payer_id"], "u-me")
        self.assertEqual(payload["shared"]["payer_share_pct"], 60, "the payer's usual share in the app")
        self.assertEqual(payload["personal"], {"person_id": "u-me", "months": expected["personal"]["months"]})
        self.assertEqual(out["summary"], expected)
        self.assertIn(("me", "sent to the app"), [(e["person"], e["from"]) for e in sent(self.root)])

    def test_the_partners_statement_goes_to_the_partner(self):
        send_to_app(self.root, {"person": "jordan", "start": "2026-01-01", "end": "2026-01-31", "personal": False})
        payload = [c for c in FakeApp.calls if c[1] == "/api/desktop/import"][0][2]
        self.assertEqual((payload["shared"]["payer_id"], payload["shared"]["payer_share_pct"]), ("u-jo", 40))
        self.assertNotIn("personal", payload)

    def test_replacing_takes_the_old_one_out_first(self):
        send_to_app(self.root, {"person": "me", "start": "2000-01-01", "end": "2100-01-01", "replace": ["b1"]})
        paths = [c[1] for c in FakeApp.calls if c[0] == "POST"]
        self.assertEqual(paths, ["/api/desktop/uploads/b1/remove", "/api/desktop/import"])
        for bad in (["../x"], "b1", ["b"] * 21):
            with self.assertRaises(ValueError):
                send_to_app(self.root, {"person": "me", "start": "2000-01-01", "end": "2100-01-01", "replace": bad})

    def test_the_apps_errors_come_through(self):
        FakeApp.fail_import = True
        with self.assertRaisesRegex(ValueError, "taken out, but sending the new one failed: Shared"):
            send_to_app(self.root, {"person": "me", "start": "2000-01-01", "end": "2100-01-01", "replace": ["b1"]})
        self.connect("split_" + "x" * 43)
        self.assertIn("revoked", app_status(self.root)["error"])
        self.assertFalse(any(e["from"] == "sent to the app" for e in sent(self.root)), "nothing noted when it failed")

    def test_only_https_except_this_computer(self):
        for url, ok in (
            ("https://ledger.example.workers.dev", True),
            ("http://localhost:8787", True),
            ("http://127.0.0.1:8787/", True),
            ("http://ledger.example.workers.dev", False),
            ("http://localhost.evil.example", False),
            ("https://example.com/path", False),
            ("ftp://example.com", False),
        ):
            (self.root / "desktop-data" / "app.json").write_text(json.dumps({"url": url, "key": FakeApp.KEY}))
            self.assertEqual(app_status(self.root)["connected"], ok, url)

    def test_redirects_arent_followed_so_the_key_cant_leak(self):
        leaked = []

        class Elsewhere(BaseHTTPRequestHandler):
            def do_GET(self):
                leaked.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *_args):
                pass

        class Redirect(FakeApp):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{other.server_address[1]}/steal")
                self.end_headers()

        other = ThreadingHTTPServer(("127.0.0.1", 0), Elsewhere)
        threading.Thread(target=other.serve_forever, daemon=True).start()
        redirecting = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        threading.Thread(target=redirecting.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{redirecting.server_address[1]}"
            (self.root / "desktop-data" / "app.json").write_text(json.dumps({"url": url, "key": FakeApp.KEY}))
            self.assertIn("redirects elsewhere", app_status(self.root)["error"])
            self.assertEqual(leaked, [], "the other server never saw a request")
        finally:
            for srv in (other, redirecting):
                srv.shutdown()
                srv.server_close()

    def test_unreachable(self):
        import socket

        with socket.socket() as sock:  # a port nothing listens on
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        (self.root / "desktop-data" / "app.json").write_text(
            json.dumps({"url": f"http://127.0.0.1:{port}", "key": FakeApp.KEY})
        )
        self.assertIn("couldn't reach the app", app_status(self.root)["error"])


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        write(
            self.root,
            "personal_transactions.csv",
            [["2026-01-07", "7.00", "FRESHWAY #8000 1234 1111", "groceries"]],
            100,
        )
        static = self.root / "static"
        static.mkdir()
        (static / "index.html").write_text("<p>page</p>")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(insights.Handler, directory=str(static)))
        self.port = self.server.server_address[1]
        insights.Handler.root, insights.Handler.port = self.root, self.port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def request(self, method, path, body=None, **headers):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        headers.setdefault("Host", f"127.0.0.1:{self.port}")
        conn.request(method, path, body=body, headers=headers)
        r = conn.getresponse()
        data = r.read()
        conn.close()
        return r.status, data

    def post(self, payload, **headers):
        headers.setdefault("Origin", f"http://127.0.0.1:{self.port}")
        headers.setdefault("Content-Type", "application/json")
        return self.request("POST", "/api/merchants", json.dumps(payload), **headers)

    def test_serves_the_page_and_the_data(self):
        self.assertEqual(self.request("GET", "/"), (200, b"<p>page</p>"))
        status, body = self.request("GET", "/api/data")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["transactions"][0]["merchant"], "Freshway")

    def test_other_sites_cant_make_the_browser_ask(self):
        self.assertEqual(self.request("GET", "/api/data", **{"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.request("GET", "/api/app", **{"Sec-Fetch-Site": "same-site"})[0], 403)
        self.assertEqual(self.request("GET", "/api/data", **{"Sec-Fetch-Site": "same-origin"})[0], 200)
        self.assertEqual(
            self.request("GET", "/", **{"Sec-Fetch-Site": "cross-site"})[0], 200, "the page itself is fine"
        )

    def test_other_host_names_are_refused(self):
        self.assertEqual(self.request("GET", "/api/data", Host=f"evil.example:{self.port}")[0], 403)
        self.assertEqual(self.post({"names": ["Freshway"], "to": "X"}, Host="evil.example")[0], 403)

    def test_renames_only_from_this_page_as_json(self):
        self.assertEqual(self.post({"names": ["Freshway"], "to": "X"}, Origin="https://evil.example")[0], 403)
        self.assertEqual(self.post({"names": ["Freshway"], "to": "X"}, Origin="null")[0], 403)
        self.assertEqual(self.post({"names": ["Freshway"], "to": "X"}, Origin="")[0], 403)
        self.assertEqual(self.post({"names": ["Freshway"], "to": "X"}, **{"Content-Type": "text/plain"})[0], 415)
        self.assertFalse((self.root / "desktop-data").exists())

        self.assertEqual(self.post({"names": [], "to": "X"})[0], 400)
        status, body = self.post({"names": ["Freshway"], "to": "Fresh Way Market"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["transactions"][0]["merchant"], "Fresh Way Market")

    def post_to(self, path, payload):
        headers = {"Origin": f"http://127.0.0.1:{self.port}", "Content-Type": "application/json"}
        return self.request("POST", path, json.dumps(payload), **headers)

    def test_classify_and_rules_routes(self):
        txn = json.loads(self.request("GET", "/api/data")[1])["transactions"][0]
        change = {"changes": [{"id": txn["id"], "category": "household", "kind": "shared"}]}
        status, body = self.post_to("/api/classify", change)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["transactions"][0]["kind"], "shared")
        rule = {"rules": [{"vendor": txn["vendor"], "person": "me", "category": "household", "kind": "shared"}]}
        self.assertEqual(self.post_to("/api/rules", rule)[0], 200)
        rules = json.loads((self.root / ".split_state.json").read_text())["vendor_rules"]
        self.assertEqual(rules, {"freshway": {"split": "household"}})
        self.assertEqual(self.post_to("/api/nope", {})[0], 404)

    def test_projection_numbers_are_kept(self):
        status, body = self.post_to("/api/projection", {"age": "38", "tax": "12"})
        self.assertEqual((status, json.loads(body)), (200, {"age": "38", "tax": "12"}))
        self.assertEqual(json.loads(self.request("GET", "/api/worth")[1])["projection"], {"age": "38", "tax": "12"})
        self.assertEqual(self.post_to("/api/projection", {"evil": "1"})[0], 400)
        self.assertEqual(self.post_to("/api/projection", {"age": 38})[0], 400)
        self.assertEqual(self.post_to("/api/projection", {"age": "x" * 21})[0], 400)


class AddedTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        write(self.root, "personal_transactions.csv", [["2026-03-01", "10.00", "A", "dining"]], 300)
        write(self.root / "data" / "jordan", "personal_transactions.csv", [["2026-03-02", "5.00", "B", "gift"]], 300)

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, **fields):
        t = {"op": "add", "date": "2026-03-05", "cents": 2500, "vendor": "  Farmers   market ", "category": "groceries"}
        return change_added(self.root, {**t, "kind": "shared", "person": "me", **fields})

    def test_typed_in_transactions_show_up_with_the_rest(self):
        self.add()
        self.add(person="jordan", kind="personal", category="income", cents=10000, vendor="Cash gift")
        hand = [t for t in load(self.root)["transactions"] if t.get("added")]
        got = sorted((t["person"], t["vendor"], t["category"], t["kind"], t["cents"]) for t in hand)
        self.assertEqual(
            got,
            [
                ("jordan", "Cash gift", "income", "personal", 10000),
                ("me", "Farmers market", "groceries", "shared", 2500),
            ],
        )
        self.assertTrue(all(t["source"] == "desktop-data/added.json" for t in hand))

    def test_checks_what_it_saves(self):
        for bad in (
            {"date": "2026-02-30"},
            {"cents": 0},
            {"cents": 12.5},
            {"vendor": " "},
            {"category": "nope"},
            {"category": "income"},  # shared income
            {"person": "sam"},  # nobody by that name here
            {"person": "../x"},
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.add(**bad)
        self.assertFalse((self.root / "desktop-data" / "added.json").exists())

    def test_edit_refile_and_delete(self):
        ident = next(iter(self.add()))
        classify(self.root, [{"id": ident, "category": "dining", "kind": "shared"}])
        self.assertEqual([t["category"] for t in load(self.root)["transactions"] if t["id"] == ident], ["dining"])
        change_added(
            self.root,
            {
                "op": "edit",
                "id": ident,
                "date": "2026-03-06",
                "cents": 3000,
                "vendor": "Market",
                "category": "household",
                "kind": "personal",
                "person": "me",
            },
        )
        t = next(t for t in load(self.root)["transactions"] if t["id"] == ident)
        self.assertEqual(
            (t["date"], t["cents"], t["category"], t["kind"]), ("2026-03-06", 3000, "household", "personal")
        )
        self.assertNotIn("original", t, "the form's category replaces the earlier refiling")
        change_added(self.root, {"op": "delete", "id": ident})
        self.assertFalse(any(t.get("added") for t in load(self.root)["transactions"]))
        with self.assertRaises(ValueError):
            change_added(self.root, {"op": "delete", "id": ident})

    def test_repeats_every_month_and_deletes_together(self):
        added = self.add(date="2026-01-31", months=4, vendor="Rent", category="housing", cents=240000)
        dates = sorted(t["date"] for t in added.values())
        self.assertEqual(dates, ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"])
        self.assertEqual(len({t["series"] for t in added.values()}), 1)
        self.add()  # a one-off, not in the series
        first = next(k for k, t in added.items() if t["date"] == "2026-03-31")
        change_added(self.root, {"op": "delete", "id": first})
        self.assertEqual(len([t for t in load(self.root)["transactions"] if t.get("added")]), 4)
        rest = next(k for k, t in added.items() if t["date"] == "2026-01-31")
        change_added(self.root, {"op": "delete", "id": rest, "series": True})
        left = [t["vendor"] for t in load(self.root)["transactions"] if t.get("added")]
        self.assertEqual(left, ["Farmers market"])
        for bad in (0, 121, "3", True):
            with self.subTest(months=bad), self.assertRaises(ValueError):
                self.add(months=bad)


if __name__ == "__main__":
    unittest.main()
