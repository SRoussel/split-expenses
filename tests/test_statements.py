"""Tests for the statement review and the summary file.

    uv run python -m unittest discover -s tests -v

No real statements are used: the parser is fed sample statement text, and the
review is driven with scripted answers.
"""

import csv
import hashlib
import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

from split_expenses import split_ledger, split_statements as st
from split_expenses.categories import INCOME, SPENDING

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "web" / "tests" / "fixtures"

BANK = """FAKE BANK CHECKING  Statement period 01/01/2026 to 01/31/2026
Deposits and Additions
01/15 FAKE EMPLOYER PAYROLL 3,250.00
01/28 ZELLE FROM SAM 42.00
01/31 INTEREST EARNED 0.42
Withdrawals
01/16 FAKE NOODLE BAR 18.40
01/20 ONLINE TRANSFER TO SAVINGS 500.00
01/22 FAKE CARD AUTOPAY 1,234.56
01/31 INTEREST CHARGED 1.23
01/12 TOTAL WINE & MORE 34.99
01/31 FAKE GROCER 123 52.10
01/31 TOTAL FEES FOR THIS PERIOD 35.00
01/31 TOTALS 1,876.29
Ending balance 9,999.99
"""

CARD = """FAKE CARD  January 2026
Payments and Other Credits
01/05 PAYMENT THANK YOU -1,234.56
01/07 FAKE GADGET STORE -20.00
Purchases
01/10 FAKE CAFE 45.10
"""

NO_SECTIONS = """Activity 2026
01/03 FAKE PHARMACY -12.00
01/04 FAKE MYSTERY CO 30.00
"""


def by_vendor(txns):
    return {t["vendor"]: t for t in txns}


class ParseTests(unittest.TestCase):
    def test_bank_statement_directions(self):
        t = by_vendor(st.parse_text(BANK, "bank-2026-01.pdf"))
        self.assertEqual(t["FAKE EMPLOYER PAYROLL"]["direction"], "in")
        self.assertEqual(t["ZELLE FROM SAM"]["direction"], "in")  # the review excludes it
        self.assertEqual(t["INTEREST EARNED"]["direction"], "in")  # kept now (was skipped)
        self.assertEqual(t["FAKE NOODLE BAR"]["direction"], "out")
        self.assertEqual(t["FAKE CARD AUTOPAY"]["direction"], "out")  # the review excludes it
        self.assertEqual(t["INTEREST CHARGED"]["direction"], "out")
        self.assertNotIn("ONLINE TRANSFER TO SAVINGS", t, "obvious transfers are still skipped")
        self.assertEqual(t["TOTAL WINE & MORE"]["direction"], "out", "a merchant called Total... is kept")
        self.assertNotIn("TOTAL FEES FOR THIS PERIOD", t, "statement summary lines are skipped")
        self.assertNotIn("TOTALS", t)
        self.assertEqual(t["FAKE NOODLE BAR"]["amount"], "18.40")
        self.assertEqual(t["FAKE EMPLOYER PAYROLL"]["date"], "2026-01-15")

    def test_card_statement_credits_are_money_in(self):
        t = by_vendor(st.parse_text(CARD, "card-2026-01.pdf"))
        self.assertEqual(t["FAKE GADGET STORE"]["direction"], "in")  # a return
        self.assertEqual(t["FAKE CAFE"]["direction"], "out")
        self.assertNotIn("PAYMENT THANK YOU", t)

    def test_unclear_lines_are_kept_not_dropped(self):
        t = by_vendor(st.parse_text(NO_SECTIONS, "x-2026.pdf"))
        self.assertEqual(t["FAKE PHARMACY"]["direction"], "out")  # minus sign
        self.assertEqual(t["FAKE MYSTERY CO"]["direction"], "unknown")  # the review asks

    def test_ids_of_already_reviewed_lines_dont_change(self):
        """Older versions numbered only money-out lines (no interest, no deposits).

        Those lines must keep exactly the same id, so re-running an old folder
        doesn't ask about them again.
        """
        source = "bank-2026-01.pdf"
        txns = st.parse_text(BANK, source)
        # Older versions skipped anything with "interest" or "total" in it.
        old_lines = [t for t in txns if t["direction"] == "out"
                     and "INTEREST" not in t["vendor"] and "TOTAL" not in t["vendor"]]
        self.assertIn("FAKE GROCER 123", [t["vendor"] for t in old_lines],
                      "a line after Total Wine keeps its old id")
        for i, t in enumerate(old_lines):
            old = f"{source}|{i}|{t['date']}|{t['amount']}|{t['vendor']}"
            self.assertEqual(st.txn_key(source, t), hashlib.sha1(old.encode()).hexdigest(), t["vendor"])
        keys = [st.txn_key(source, t) for t in txns]
        self.assertEqual(len(keys), len(set(keys)), "every line has its own id")


class ReviewTests(unittest.TestCase):
    """Drive the interactive review with scripted answers."""

    def run_review(self, txns, answers, state=None):
        tmp = Path(self.tmp.name)
        paths = {"split": tmp / "split.csv", "personal": tmp / "personal.csv"}
        state_path = tmp / "state.json"
        if state is not None:
            state_path.write_text(json.dumps(state))
        with mock.patch("builtins.input", side_effect=answers), mock.patch("builtins.print"):
            st.review([("statement.pdf", txns)], paths, state_path)
        def read(p):
            if not p.exists():
                return []
            with open(p, newline="") as f:
                return list(csv.DictReader(f))

        # Skipping everything writes no state at all, which is fine.
        saved = json.loads(state_path.read_text()) if state_path.exists() else {"done": [], "vendor_rules": {}}
        return read(paths["split"]), read(paths["personal"]), saved

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_every_kind_of_answer_lands_in_the_right_place(self):
        txns = by_vendor(st.parse_text(BANK, "b.pdf")) | by_vendor(st.parse_text(CARD, "c.pdf"))
        order = ["FAKE EMPLOYER PAYROLL", "ZELLE FROM SAM", "FAKE NOODLE BAR", "FAKE CARD AUTOPAY",
                 "FAKE GROCER 123", "FAKE GADGET STORE"]
        dining = str(SPENDING.index("dining") + 1)
        groceries = str(SPENDING.index("groceries") + 1)
        answers = [
            "i", "n",                  # payroll: income
            "x", "n",                  # money from Sam: exclude
            "s", dining, "n",          # noodle bar: self / dining
            "x", "n",                  # card payment: exclude
            "p", groceries, "n",       # grocer: split / groceries
            "r", "entertainment", "n", "n",  # gadget store: return, personal
        ]
        split, personal, _ = self.run_review([txns[v] for v in order], answers)
        self.assertEqual(split, [{"date": "2026-01-31", "amount": "52.10", "vendor": "FAKE GROCER 123",
                                  "category": "groceries"}])
        self.assertEqual([(r["vendor"], r["amount"], r["category"]) for r in personal], [
            ("FAKE EMPLOYER PAYROLL", "3250.00", INCOME),
            ("FAKE NOODLE BAR", "18.40", "dining"),
            ("FAKE GADGET STORE", "-20.00", "entertainment"),  # a return reduces its category
        ])

    def test_shared_return_reduces_the_shared_side(self):
        t = by_vendor(st.parse_text(CARD, "c.pdf"))["FAKE GADGET STORE"]
        split, personal, _ = self.run_review([t], ["r", "household", "y", "n"])
        self.assertEqual([(r["amount"], r["category"]) for r in split], [("-20.00", "household")])
        self.assertEqual(personal, [])

    def test_unclear_direction_is_asked_and_remembered(self):
        t = by_vendor(st.parse_text(NO_SECTIONS, "x-2026.pdf"))["FAKE MYSTERY CO"]
        _, personal, state = self.run_review([t], ["o", "s", "health", "y"])
        self.assertEqual([(r["amount"], r["category"]) for r in personal], [("30.00", "health")])
        self.assertEqual(state["vendor_rules"]["dir:fake mystery co"], "out")
        self.assertEqual(state["vendor_rules"]["fake mystery co"], {"self": "health"})
        # Next statement: same vendor, no questions at all.
        again = dict(t, _key_index=("new", 99))
        _, personal, _ = self.run_review([again], [], state=state)
        self.assertEqual(len(personal), 2)

    def test_remembered_rules_apply_without_questions(self):
        txns = by_vendor(st.parse_text(BANK, "b.pdf"))
        state = {"done": [], "vendor_rules": {
            "in:fake employer payroll": "income",
            "in:zelle from sam": "exclude",
            "fake card autopay": "exclude",
        }}
        _, personal, state = self.run_review(
            [txns["FAKE EMPLOYER PAYROLL"], txns["ZELLE FROM SAM"], txns["FAKE CARD AUTOPAY"]], [], state=state)
        self.assertEqual([r["category"] for r in personal], [INCOME])
        self.assertEqual(len(state["done"]), 3)

    def test_old_self_rule_asks_for_a_category_once(self):
        t = by_vendor(st.parse_text(BANK, "b.pdf"))["FAKE NOODLE BAR"]
        state = {"done": [], "vendor_rules": {"fake noodle bar": "self"}}
        _, personal, state = self.run_review([t], ["dining", "y"], state=state)
        self.assertEqual(personal[0]["category"], "dining")
        self.assertEqual(state["vendor_rules"]["fake noodle bar"], {"self": "dining"})

    def test_skip_leaves_it_for_next_time(self):
        t = by_vendor(st.parse_text(BANK, "b.pdf"))["FAKE NOODLE BAR"]
        _, personal, state = self.run_review([t], ["k"])
        self.assertEqual(personal, [])
        self.assertEqual(state["done"], [])


class SummaryTests(unittest.TestCase):
    def summarize(self, out, **kw):
        args = Namespace(csv=str(FIXTURES / "sample_split_transactions.csv"),
                         personal=str(FIXTURES / "sample_personal_transactions.csv"),
                         person=None, no_personal=False, output=str(out), name=None)
        for k, v in kw.items():
            setattr(args, k, v)
        with mock.patch("builtins.print"):
            split_ledger.cmd_summarize(args, None)
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
