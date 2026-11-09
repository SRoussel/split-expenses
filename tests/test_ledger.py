"""Tests for split-ledger: the balance math, each command, and the summary file.

    uv run python -m unittest discover -s tests -v

Commands run through main() with real arguments, against a ledger in a
temporary folder, so argument parsing is covered too.
"""

import contextlib
import io
import json
import os
import tempfile
import unittest
from argparse import Namespace
from decimal import Decimal
from pathlib import Path
from unittest import mock

from split_expenses import split_ledger as sl
from split_expenses.categories import INCOME, SPENDING

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "web" / "tests" / "fixtures"


class InTempDir(unittest.TestCase):
    """Each test runs in its own empty folder, like a fresh checkout."""

    def setUp(self):
        self._old = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory()
        os.chdir(self._tmp.name)
        self.addCleanup(self._restore)

    def _restore(self):
        os.chdir(self._old)
        self._tmp.cleanup()

    def run_ledger(self, *args):
        """Run `split-ledger ARGS` and return what it printed. A sys.exit is raised as SystemExit."""
        out = io.StringIO()
        with mock.patch("sys.argv", ["split-ledger", *args, "--no-color"]), contextlib.redirect_stdout(out):
            sl.main()
        return out.getvalue()

    def rows(self):
        return sl.load_ledger(Path("ledger.csv"))

    def balance(self):
        return sl.current_balance(self.rows())


class ParseTests(unittest.TestCase):
    def test_amounts(self):
        self.assertEqual(sl.parse_amount("$1,200.5"), Decimal("1200.50"))
        self.assertEqual(sl.parse_amount("0.005"), Decimal("0.01"), "rounded half up to the cent")
        for bad in ("0", "-5", "abc", ""):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                sl.parse_amount(bad)

    def test_payer(self):
        for text in ("me", "I", " m ", "you"):
            self.assertEqual(sl.parse_payer(text), "me")
        for text in ("partner", "P"):
            self.assertEqual(sl.parse_payer(text), "partner")
        with self.assertRaises(ValueError):
            sl.parse_payer("sam")

    def test_percent_and_date_and_name(self):
        self.assertEqual(sl.parse_percent("70%"), Decimal("70"))
        with self.assertRaises(ValueError):
            sl.parse_percent("101")
        self.assertEqual(sl.parse_date("2026-02-03"), "2026-02-03")
        with self.assertRaises(ValueError):
            sl.parse_date("02/03/2026")
        self.assertEqual(sl.parse_name("  power   bill "), "power bill")
        with self.assertRaises(ValueError):
            sl.parse_name("   ")


class EffectTests(unittest.TestCase):
    """Positive = partner owes you. Must match web/shared/owed.ts."""

    def effect(self, **row):
        return sl.effect({"payer": "", "my_share": "", **row})

    def test_expenses(self):
        self.assertEqual(self.effect(type="expense", payer="me", amount="100.00", my_share="50"), Decimal("50.00"))
        self.assertEqual(self.effect(type="expense", payer="me", amount="100.00", my_share="70"), Decimal("30.00"))
        self.assertEqual(
            self.effect(type="expense", payer="partner", amount="100.00", my_share="70"), Decimal("-70.00")
        )
        self.assertEqual(
            self.effect(type="expense", payer="me", amount="100.00", my_share=""),
            Decimal("50.00"),
            "a blank share means 50/50",
        )

    def test_odd_half_cent_goes_to_the_payer(self):
        # $1.01 split evenly: the other person owes 51¢ (half up), the payer covers 50¢.
        self.assertEqual(self.effect(type="expense", payer="me", amount="1.01", my_share="50"), Decimal("0.51"))
        self.assertEqual(self.effect(type="expense", payer="partner", amount="1.01", my_share="50"), Decimal("-0.51"))

    def test_settlements_and_starting_balances(self):
        self.assertEqual(self.effect(type="settlement", payer="me", amount="20.00"), Decimal("20.00"))
        self.assertEqual(self.effect(type="settlement", payer="partner", amount="20.00"), Decimal("-20.00"))
        self.assertEqual(self.effect(type="opening_me_owes", amount="500.00"), Decimal("-500.00"))
        self.assertEqual(self.effect(type="opening_partner_owes", amount="600.00"), Decimal("600.00"))

    def test_unknown_type_stops(self):
        with self.assertRaises(ValueError):
            self.effect(type="refund", amount="1.00")


class CommandTests(InTempDir):
    def test_add(self):
        out = self.run_ledger("add", "84.20", "me", "groceries", "and", "stuff", "--date", "2026-01-15")
        self.assertIn("Partner owes you $42.10", out)
        self.assertEqual(
            self.rows(),
            [
                {
                    "date": "2026-01-15",
                    "type": "expense",
                    "payer": "me",
                    "amount": "84.20",
                    "my_share": "50",
                    "name": "groceries and stuff",
                }
            ],
        )
        self.run_ledger("add", "120", "partner", "power bill", "--my-share", "70")
        self.assertEqual(self.balance(), Decimal("42.10") - Decimal("84.00"))
        self.assertEqual(Path("ledger.csv").read_text().splitlines()[0], ",".join(sl.FIELDS), "one header only")

    def test_add_rejects_bad_input(self):
        with self.assertRaises(SystemExit):
            self.run_ledger("add", "-5", "me", "oops")
        with self.assertRaises(SystemExit):
            self.run_ledger("add", "5", "me", "oops", "--my-share", "150")
        self.assertFalse(Path("ledger.csv").exists(), "nothing written")

    def test_add_prompts_for_what_is_missing(self):
        answers = iter(["abc", "12.50", "maybe", "partner", "lunch"])  # two bad answers are asked again
        with mock.patch("builtins.input", lambda _: next(answers)):
            self.run_ledger("add")
        self.assertEqual(self.rows()[0]["name"], "lunch")
        self.assertEqual(self.balance(), Decimal("-6.25"))

    def test_init(self):
        self.run_ledger("init", "--i-owe", "500")
        self.assertEqual(self.balance(), Decimal("-500.00"))
        with self.assertRaises(SystemExit):
            self.run_ledger("init", "--partner-owes", "100")  # already has one
        self.run_ledger("init", "--partner-owes", "100", "--force")
        self.assertEqual(self.balance(), Decimal("-400.00"))
        with self.assertRaises(SystemExit):
            self.run_ledger("init", "--i-owe", "1", "--partner-owes", "1", "--force")
        with self.assertRaises(SystemExit):
            self.run_ledger("init")

    def test_settle(self):
        with self.assertRaises(SystemExit):
            self.run_ledger("settle")  # nothing to settle
        self.run_ledger("add", "1.01", "partner", "coffee")
        self.run_ledger("settle")
        row = self.rows()[-1]
        self.assertEqual(
            (row["type"], row["payer"], row["amount"]),
            ("settlement", "me", "0.51"),
            "whoever owes pays the whole balance",
        )
        self.assertEqual(self.balance(), 0)
        self.run_ledger("settle", "100", "partner", "--name", "Venmo")
        self.assertEqual(self.rows()[-1]["name"], "Venmo")
        self.assertEqual(self.balance(), Decimal("-100.00"))

    def test_import(self):
        src = str(FIXTURES / "sample_split_transactions.csv")
        out = self.run_ledger("import", src)
        self.assertIn("1 skipped as invalid", out)
        row = self.rows()[0]
        self.assertEqual((row["name"], row["amount"], row["payer"]), ("Expenses 01/15/26-02/03/26", "1349.55", "me"))
        with self.assertRaises(SystemExit):
            self.run_ledger("import", src)  # same name twice
        self.run_ledger("import", src, "--force", "--payer", "partner", "--my-share", "60")
        self.assertEqual(len(self.rows()), 2)
        self.assertEqual(self.balance(), Decimal("674.78") - Decimal("809.73"))

    def test_import_refuses_returns_only(self):
        Path("returns.csv").write_text("date,amount,vendor,category\n2026-01-02,-20.00,SHOP,household\n")
        with self.assertRaises(SystemExit):
            self.run_ledger("import", "returns.csv")
        self.assertFalse(Path("ledger.csv").exists())

    def test_balance_and_history(self):
        self.assertIn("empty", self.run_ledger("balance"))
        self.run_ledger("init", "--partner-owes", "10", "--date", "2026-01-01")
        self.run_ledger("add", "20", "me", "a", "--date", "2026-01-02")
        self.run_ledger("settle", "5", "partner", "--date", "2026-01-03")
        self.assertIn("Partner owes you $15.00", self.run_ledger("balance"))
        lines = self.run_ledger("history").splitlines()
        self.assertIn("+$10.00", lines[2])
        self.assertIn("+$20.00", lines[3])
        self.assertIn("+$15.00", lines[4])
        last = self.run_ledger("history", "-n", "1").splitlines()
        self.assertEqual(len([line for line in last if line.startswith("2026-")]), 1, "one entry shown")
        self.assertIn("+$15.00", last[2], "the running balance still counts the hidden entries")
        self.assertIn("Partner owes you $15.00", last[-2])


class ArchiveTests(InTempDir):
    def test_archive_moves_the_batch_and_keeps_the_history(self):
        for name in ("split_transactions.csv", "personal_transactions.csv", "split_summary.json", ".split_state.json"):
            Path(name).write_text("x")
        args = Namespace(person=None)
        with mock.patch("builtins.print"):
            sl.cmd_archive(args, None)
        archived = sorted(p.relative_to("archive").as_posix() for p in Path("archive").rglob("*.*"))
        self.assertEqual(len(archived), 3)
        self.assertFalse(Path("split_transactions.csv").exists())
        self.assertTrue(Path(".split_state.json").exists(), "review history stays")
        Path("split_transactions.csv").write_text("x")  # a second batch the same day
        with mock.patch("builtins.print"):
            sl.cmd_archive(args, None)
        self.assertEqual(len(list(Path("archive").iterdir())), 2, "a second folder, nothing overwritten")
        with self.assertRaises(SystemExit), mock.patch("builtins.print"):
            sl.cmd_archive(args, None)  # nothing left to archive

    def test_finish_summarizes_then_archives(self):
        for name in ("split_transactions.csv", "personal_transactions.csv"):
            Path(name).write_text((FIXTURES / f"sample_{name}").read_text())
        args = Namespace(person=None, no_personal=False, name=None)
        with mock.patch("builtins.print"):
            sl.cmd_finish(args, None)
        [dest] = list(Path("archive").iterdir())
        self.assertEqual(
            json.loads((dest / "split_summary.json").read_text()),
            json.loads((FIXTURES / "expected_summary_v2.json").read_text()),
        )
        self.assertTrue((dest / "split_transactions.csv").exists())
        self.assertFalse(Path("split_summary.json").exists())
        with self.assertRaises(SystemExit), mock.patch("builtins.print"):
            sl.cmd_finish(args, None)  # nothing to summarize: nothing moved
        self.assertEqual(len(list(Path("archive").iterdir())), 1)

    def test_finish_refuses_a_leftover_summary(self):
        Path("split_transactions.csv").write_text((FIXTURES / "sample_split_transactions.csv").read_text())
        Path("split_summary.json").write_text("{}")
        with self.assertRaises(SystemExit), mock.patch("builtins.print"):
            sl.cmd_finish(Namespace(person=None, no_personal=False, name=None), None)
        self.assertFalse(Path("archive").exists())


class SummaryTests(unittest.TestCase):
    def summarize(self, out, **kw):
        args = Namespace(
            csv=str(FIXTURES / "sample_split_transactions.csv"),
            personal=str(FIXTURES / "sample_personal_transactions.csv"),
            person=None,
            no_personal=False,
            output=str(out),
            name=None,
        )
        for k, v in kw.items():
            setattr(args, k, v)
        with mock.patch("builtins.print"):
            sl.cmd_summarize(args, None)
        return json.loads(Path(out).read_text())

    def test_matches_the_file_the_web_app_tests_use(self):
        with tempfile.TemporaryDirectory() as d:
            got = self.summarize(Path(d) / "s.json")
        self.assertEqual(got, json.loads((FIXTURES / "expected_summary_v2.json").read_text()))

    def test_contains_only_totals(self):
        with tempfile.TemporaryDirectory() as d:
            self.summarize(Path(d) / "s.json")
            text = (Path(d) / "s.json").read_text()
        self.assertNotIn("FAKE", text, "no merchant names")
        self.assertNotIn("2026-01-16", text, "no dates of individual purchases")

    def test_no_personal(self):
        with tempfile.TemporaryDirectory() as d:
            got = self.summarize(Path(d) / "s.json", no_personal=True)
        self.assertNotIn("personal", got)
        self.assertEqual(got["shared"]["total_cents"], 134955)

    def test_category_lists_match_the_web_app(self):
        web = json.loads((ROOT / "web" / "shared" / "categories.json").read_text())
        self.assertEqual(web["spending"], SPENDING)
        self.assertEqual(web["income"], INCOME)


if __name__ == "__main__":
    unittest.main()
