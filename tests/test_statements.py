"""Tests for split-statements: reading statements, the review, and re-runs.

    uv run python -m unittest discover -s tests -v

No real statements are used: the parser is fed sample statement text, and the
review is driven with scripted answers.
"""

import csv
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from split_expenses import split_statements as st
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
        old_lines = [
            t for t in txns if t["direction"] == "out" and "INTEREST" not in t["vendor"] and "TOTAL" not in t["vendor"]
        ]
        self.assertIn("FAKE GROCER 123", [t["vendor"] for t in old_lines], "a line after Total Wine keeps its old id")
        for i, t in enumerate(old_lines):
            old = f"{source}|{i}|{t['date']}|{t['amount']}|{t['vendor']}"
            self.assertEqual(st.txn_key(source, t), hashlib.sha1(old.encode()).hexdigest(), t["vendor"])
        keys = [st.txn_key(source, t) for t in txns]
        self.assertEqual(len(keys), len(set(keys)), "every line has its own id")


REPEATS = """FAKE CARD  February 2026
Purchases
02/01 STARBUCKS #1234 4.50
02/03 FAKE NOODLE BAR 18.40
02/05 STARBUCKS #5678 5.25
02/09 FAKE GROCER 123 52.10
02/12 STARBUCKS #1234 4.50
"""


def key(category):
    """The single key for a category."""
    return st.CATEGORY_KEYS[SPENDING.index(category)]


class ReviewTests(unittest.TestCase):
    """Drive the review with scripted keypresses (one per line when input isn't a terminal)."""

    def run_review(self, txns, answers, state=None):
        tmp = Path(self.tmp.name)
        paths = {"split": tmp / "split.csv", "personal": tmp / "personal.csv"}
        state_path = tmp / "state.json"
        if state is not None:
            state_path.write_text(json.dumps(state))
        script = iter(answers)

        def fake_input(*_):
            try:
                return next(script)
            except StopIteration:
                raise AssertionError("the review asked more questions than the test expected") from None

        with mock.patch("builtins.input", side_effect=fake_input), mock.patch("builtins.print"):
            st.review([("statement.pdf", txns)], paths, state_path)
        self.assertIsNone(next(script, None), "the review asked fewer questions than the test expected")

        def read(p):  # rows without the id column; raw_rows() has them
            if not p.exists():
                return []
            with open(p, newline="") as f:
                return [{k: v for k, v in r.items() if k != "id"} for r in csv.DictReader(f)]

        saved = json.loads(state_path.read_text()) if state_path.exists() else {"done": [], "vendor_rules": {}}
        return read(paths["split"]), read(paths["personal"]), saved

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_every_kind_of_answer_lands_in_the_right_place(self):
        txns = by_vendor(st.parse_text(BANK, "b.pdf")) | by_vendor(st.parse_text(CARD, "c.pdf"))
        order = [
            "FAKE EMPLOYER PAYROLL",
            "ZELLE FROM SAM",
            "FAKE NOODLE BAR",
            "FAKE CARD AUTOPAY",
            "FAKE GROCER 123",
            "FAKE GADGET STORE",
        ]
        answers = [
            "i",  # payroll: income
            "x",  # money from Sam: exclude
            "s",
            key("dining"),  # noodle bar: self / dining
            "x",  # card payment: exclude
            "p",
            key("groceries"),  # grocer: split / groceries
            "r",
            key("entertainment"),
            "n",  # gadget store: a return, not shared
        ]
        split, personal, state = self.run_review([txns[v] for v in order], answers)
        self.assertEqual(
            split, [{"date": "2026-01-31", "amount": "52.10", "vendor": "FAKE GROCER 123", "category": "groceries"}]
        )
        self.assertEqual(
            [(r["vendor"], r["amount"], r["category"]) for r in personal],
            [
                ("FAKE EMPLOYER PAYROLL", "3250.00", INCOME),
                ("FAKE NOODLE BAR", "18.40", "dining"),
                ("FAKE GADGET STORE", "-20.00", "entertainment"),  # a return reduces its category
            ],
        )
        rules = state["vendor_rules"]
        self.assertEqual(rules["fake noodle bar"], {"self": "dining"}, "remembered without being asked")
        self.assertEqual(rules["in:zelle from sam"], "exclude")
        self.assertEqual(len(state["done"]), 6)

    def test_one_answer_per_merchant(self):
        txns = st.parse_text(REPEATS, "c.pdf")
        # Three Starbucks visits, one noodle bar, one grocer: three questions, not five.
        split, personal, state = self.run_review(txns, ["s", key("dining"), "s", key("dining"), "p", key("groceries")])
        self.assertEqual(
            [r["vendor"] for r in personal],
            ["STARBUCKS #1234", "STARBUCKS #5678", "STARBUCKS #1234", "FAKE NOODLE BAR"],
        )
        self.assertEqual(len(split), 1)
        self.assertEqual(len(state["done"]), 5)

    def test_enter_accepts_the_suggestion(self):
        t = by_vendor(st.parse_text(BANK, "b.pdf"))["FAKE NOODLE BAR"]  # "noodle" suggests dining
        _, personal, state = self.run_review([t], [""])
        self.assertEqual(personal[0]["category"], "dining")
        self.assertEqual(state["vendor_rules"]["fake noodle bar"], {"self": "dining"})

    def test_shift_means_this_time_only(self):
        t = by_vendor(st.parse_text(BANK, "b.pdf"))["FAKE NOODLE BAR"]
        _, personal, state = self.run_review([t], ["S", key("dining")])
        self.assertEqual(personal[0]["category"], "dining")
        self.assertNotIn("fake noodle bar", state["vendor_rules"])

    def test_each_separately(self):
        starbucks = [t for t in st.parse_text(REPEATS, "c.pdf") if t["vendor"].startswith("STARBUCKS")]
        split, personal, state = self.run_review(starbucks, ["e", "s", key("dining"), "p", key("dining"), "x"])
        self.assertEqual(len(personal), 1)
        self.assertEqual(len(split), 1)
        self.assertEqual(len(state["done"]), 3)
        self.assertNotIn("starbucks", state["vendor_rules"], "answers given one by one aren't remembered")

    def starbucks(self):
        return [t for t in st.parse_text(REPEATS, "c.pdf") if t["vendor"].startswith("STARBUCKS")]

    def test_change_single_lines_of_a_merchant(self):
        # Lines 2 and 3 are something else; the rest is dining, and only dining is remembered.
        split, personal, state = self.run_review(
            self.starbucks(), ["c", "2,3", "p", key("household"), "s", key("dining")]
        )
        self.assertEqual([(r["date"], r["category"]) for r in personal], [("2026-02-01", "dining")])
        self.assertEqual(
            [(r["date"], r["category"]) for r in split], [("2026-02-05", "household"), ("2026-02-12", "household")]
        )
        self.assertEqual(state["vendor_rules"]["starbucks"], {"self": "dining"})
        self.assertEqual(len(state["done"]), 3)

    def test_remembered_merchant_with_several_lines_is_shown_first(self):
        state = {"done": [], "vendor_rules": {"starbucks": {"self": "dining"}}}
        _, personal, _ = self.run_review(self.starbucks(), [""], state=state)  # Enter accepts all
        self.assertEqual([r["category"] for r in personal], ["dining"] * 3)

    def test_change_a_line_of_a_remembered_merchant(self):
        state = {"done": [], "vendor_rules": {"starbucks": {"self": "dining"}}}
        _, personal, state = self.run_review(self.starbucks(), ["c", "3", "x", ""], state=state)
        self.assertEqual([r["date"] for r in personal], ["2026-02-01", "2026-02-05"])
        self.assertEqual(state["vendor_rules"]["starbucks"], {"self": "dining"})
        self.assertEqual(len(state["done"]), 3, "the excluded line counts as reviewed")

    def test_bad_line_numbers_and_esc_change_nothing(self):
        _, personal, _ = self.run_review(
            self.starbucks(), ["c", "7", "c", "two", "c", "", "c", "1", st.ESC, "s", key("dining")]
        )
        self.assertEqual([r["category"] for r in personal], ["dining"] * 3)

    def test_unusually_big_lines_are_marked(self):
        items = [
            ("k", "s", {"date": "2026-01-0" + str(d), "amount": a})
            for d, a in [(1, "142.10"), (2, "988.00"), (3, "96.40"), (4, "175.80")]
        ]
        lines = st.item_lines(items, {})
        self.assertEqual([("bigger than usual" in line) for line in lines], [False, True, False, False])

    def test_esc_goes_back_from_the_category(self):
        t = by_vendor(st.parse_text(BANK, "b.pdf"))["FAKE GROCER 123"]
        split, personal, _ = self.run_review([t], ["s", st.ESC, "p", key("groceries")])
        self.assertEqual((len(split), len(personal)), (1, 0))

    def test_undo_takes_back_the_last_answer(self):
        txns = by_vendor(st.parse_text(BANK, "b.pdf"))
        split, personal, state = self.run_review(
            [txns["FAKE NOODLE BAR"], txns["FAKE GROCER 123"]],
            [
                "s",
                key("dining"),  # noodle bar: self / dining ...
                "u",  # ... at the grocer: undo that
                "p",
                key("dining"),  # noodle bar again: split / dining
                "p",
                key("groceries"),
            ],
        )  # grocer
        self.assertEqual(personal, [], "the undone answer's line is gone")
        self.assertEqual([r["vendor"] for r in split], ["FAKE NOODLE BAR", "FAKE GROCER 123"])
        self.assertEqual(state["vendor_rules"]["fake noodle bar"], {"split": "dining"})
        self.assertEqual(len(state["done"]), 2)

    def test_undo_reaches_past_remembered_answers(self):
        txns = by_vendor(st.parse_text(BANK, "b.pdf"))
        state = {"done": [], "vendor_rules": {"fake card autopay": "exclude"}}
        _, personal, state = self.run_review(
            [txns["FAKE NOODLE BAR"], txns["FAKE CARD AUTOPAY"], txns["FAKE GROCER 123"]],
            [
                "s",
                key("dining"),  # noodle bar (autopay then applies by itself)
                "u",  # at the grocer: undo goes back past the autopay to the noodle bar
                "s",
                key("health"),  # noodle bar, answered again
                "s",
                key("groceries"),
            ],
            state=state,
        )
        self.assertEqual([r["category"] for r in personal], ["health", "groceries"])
        self.assertEqual(len(state["done"]), 3)
        self.assertEqual(state["vendor_rules"]["fake card autopay"], "exclude")

    def test_nothing_to_undo(self):
        t = by_vendor(st.parse_text(BANK, "b.pdf"))["FAKE GROCER 123"]
        split, _, _ = self.run_review([t], ["u", "p", key("groceries")])
        self.assertEqual(len(split), 1)

    def test_shared_return_reduces_the_shared_side(self):
        t = by_vendor(st.parse_text(CARD, "c.pdf"))["FAKE GADGET STORE"]
        split, personal, _ = self.run_review([t], ["r", key("household"), "y"])
        self.assertEqual([(r["amount"], r["category"]) for r in split], [("-20.00", "household")])
        self.assertEqual(personal, [])

    def test_unclear_direction_is_asked_and_remembered(self):
        t = by_vendor(st.parse_text(NO_SECTIONS, "x-2026.pdf"))["FAKE MYSTERY CO"]
        _, personal, state = self.run_review([t], ["o", "s", key("health")])
        self.assertEqual([(r["amount"], r["category"]) for r in personal], [("30.00", "health")])
        self.assertEqual(state["vendor_rules"]["dir:fake mystery co"], "out")
        self.assertEqual(state["vendor_rules"]["fake mystery co"], {"self": "health"})
        # Next statement: same vendor, no questions at all.
        again = dict(t, _key_index=("new", 99), date="2026-02-03")  # same merchant, a later statement
        _, personal, _ = self.run_review([again], [], state=state)
        self.assertEqual(len(personal), 2)

    def test_remembered_rules_apply_without_questions(self):
        txns = by_vendor(st.parse_text(BANK, "b.pdf"))
        state = {
            "done": [],
            "vendor_rules": {
                "in:fake employer payroll": "income",
                "in:zelle from sam": "exclude",
                "fake card autopay": "exclude",
            },
        }
        _, personal, state = self.run_review(
            [txns["FAKE EMPLOYER PAYROLL"], txns["ZELLE FROM SAM"], txns["FAKE CARD AUTOPAY"]], [], state=state
        )
        self.assertEqual([r["category"] for r in personal], [INCOME])
        self.assertEqual(len(state["done"]), 3)

    def test_old_self_rule_asks_for_a_category_once(self):
        t = by_vendor(st.parse_text(BANK, "b.pdf"))["FAKE NOODLE BAR"]
        state = {"done": [], "vendor_rules": {"fake noodle bar": "self"}}
        _, personal, state = self.run_review([t], [key("dining")], state=state)
        self.assertEqual(personal[0]["category"], "dining")
        self.assertEqual(state["vendor_rules"]["fake noodle bar"], {"self": "dining"})

    def test_skip_leaves_it_for_next_time(self):
        t = by_vendor(st.parse_text(BANK, "b.pdf"))["FAKE NOODLE BAR"]
        _, personal, state = self.run_review([t], ["k"])
        self.assertEqual(personal, [])
        self.assertEqual(state["done"], [])


class RerunSafetyTests(unittest.TestCase):
    """Running again, answering again, or ids changing must never duplicate rows."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.paths = {"split": d / "split.csv", "personal": d / "personal.csv"}
        self.state_path = d / "state.json"
        self.txns = by_vendor(st.parse_text(BANK, "b.pdf"))

    def tearDown(self):
        self.tmp.cleanup()

    def review(self, source, txns, answers):
        script = iter(answers)
        with mock.patch("builtins.input", side_effect=lambda *_: next(script)), mock.patch("builtins.print"):
            st.review([(source, txns)], self.paths, self.state_path)
        self.assertIsNone(next(script, None), "fewer questions than expected")

    def rows(self, which):
        return st.read_rows(self.paths[which])

    def state(self):
        return json.loads(self.state_path.read_text())

    def forget_reviewed(self):  # what --reset does
        s = self.state()
        s["done"] = []
        st.save_state(self.state_path, s)

    def test_reviewing_again_replaces_instead_of_duplicating(self):
        noodle = self.txns["FAKE NOODLE BAR"]
        self.review("b.pdf", [noodle], ["s", key("dining")])
        self.forget_reviewed()
        self.review("b.pdf", [noodle], [])  # remembered, applied again
        self.assertEqual(len(self.rows("personal")), 1)
        self.assertTrue(self.rows("personal")[0]["id"], "rows carry the transaction id")

    def test_a_different_answer_moves_the_row(self):
        noodle = self.txns["FAKE NOODLE BAR"]
        self.review("b.pdf", [noodle], ["S", key("dining")])  # this time only: no rule
        self.forget_reviewed()
        self.review("b.pdf", [noodle], ["P", key("groceries")])
        self.assertEqual(self.rows("personal"), [])
        self.assertEqual([r["category"] for r in self.rows("split")], ["groceries"])
        self.forget_reviewed()
        self.review("b.pdf", [noodle], ["X"])
        self.assertEqual(self.rows("split"), [], "excluding it the second time removes the row")

    def test_an_id_change_is_caught_not_duplicated(self):
        noodle = self.txns["FAKE NOODLE BAR"]
        self.review("b.pdf", [noodle], ["s", key("dining")])
        # Same statement under another file name: a new id, same date, amount and merchant.
        self.review("renamed.pdf", [noodle], ["s"])  # the rule applies, the guard asks: skip
        self.assertEqual(len(self.rows("personal")), 1)
        self.assertEqual(len(self.state()["done"]), 2, "the copy is marked reviewed, so it isn't asked again")
        self.review("renamed-again.pdf", [noodle], ["a"])  # add anyway: a genuine second purchase
        self.assertEqual(len(self.rows("personal")), 2)

    def test_files_from_older_versions_still_work(self):
        noodle = self.txns["FAKE NOODLE BAR"]
        self.paths["personal"].write_text(
            "date,amount,vendor,category\r\n" + f"{noodle['date']},{noodle['amount']},{noodle['vendor']},dining\r\n"
        )
        self.review("b.pdf", [noodle], ["s", key("dining"), "s"])  # the old row has no id: the guard asks
        rows = self.rows("personal")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], "", "the old row is kept as it was")
        self.review("b.pdf", [self.txns["FAKE GROCER 123"]], ["p", key("groceries")])
        header = self.paths["split"].read_text().splitlines()[0]
        self.assertEqual(header, "date,amount,vendor,category,id")

    def test_undo_puts_a_replaced_row_back(self):
        noodle, grocer = self.txns["FAKE NOODLE BAR"], self.txns["FAKE GROCER 123"]
        self.review("b.pdf", [noodle], ["S", key("dining")])
        self.forget_reviewed()
        # Answer differently, then undo it at the next question, then answer as before.
        self.review("b.pdf", [noodle, grocer], ["P", key("travel"), "u", "S", key("dining"), "p", key("groceries")])
        self.assertEqual([r["category"] for r in self.rows("personal")], ["dining"])
        self.assertEqual([r["category"] for r in self.rows("split")], ["groceries"])

    def test_an_unreadable_state_file_stops_instead_of_starting_over(self):
        self.state_path.write_text("{ not json")
        with self.assertRaises(SystemExit) as stop:
            self.review("b.pdf", [self.txns["FAKE NOODLE BAR"]], [])
        self.assertIn("can't be read", str(stop.exception))
        self.assertEqual(self.state_path.read_text(), "{ not json", "left untouched")

    def test_writes_leave_no_temp_files(self):
        self.review("b.pdf", [self.txns["FAKE NOODLE BAR"]], ["s", key("dining")])
        self.assertEqual([p.name for p in Path(self.tmp.name).glob("*.tmp")], [])

    def test_reset_keeps_remembered_merchants(self):
        st.save_state(self.state_path, {"done": ["x", "y"], "vendor_rules": {"fake noodle bar": {"self": "dining"}}})
        empty = Path(self.tmp.name) / "no-pdfs"
        empty.mkdir()
        argv = ["split-statements", str(empty), "--state", str(self.state_path), "--reset"]
        with mock.patch("sys.argv", argv), mock.patch("builtins.print"), self.assertRaises(SystemExit):
            st.main()  # stops at "no PDFs", after the reset
        self.assertEqual(self.state(), {"done": [], "vendor_rules": {"fake noodle bar": {"self": "dining"}}})


class SuggestionTests(unittest.TestCase):
    def test_your_own_answer_for_a_similar_name_comes_first(self):
        rules = {"noodle bar": {"split": "dining"}}
        self.assertEqual(st.suggest("noodle bar downtown", "out", rules)[0], {"split": "dining"})
        self.assertEqual(
            st.suggest("starbucks 22nd st", "out", {"starbucks": {"self": "dining"}})[0], {"self": "dining"}
        )

    def test_meaningless_words_dont_count_as_similar(self):
        self.assertIsNone(st.suggest("sq the corner", "out", {"sq the plaza": {"self": "gift"}}))

    def test_keywords(self):
        self.assertEqual(st.suggest("trader joe s", "out", {})[0], {"self": "groceries"})
        self.assertEqual(st.suggest("uber eats", "out", {})[0], {"self": "dining"})
        self.assertEqual(st.suggest("uber trip", "out", {})[0], {"self": "transport"})
        self.assertEqual(st.suggest("acme payroll", "in", {})[0], "income")
        self.assertEqual(st.suggest("zelle to sam", "out", {})[0], "exclude")
        self.assertIsNone(st.suggest("mystery place", "out", {}))

    def test_self_or_split_follows_your_habits(self):
        rules = {"a": {"split": "groceries"}, "b": {"split": "groceries"}, "c": {"self": "groceries"}}
        self.assertEqual(st.suggest("safeway", "out", rules)[0], {"split": "groceries"})

    def test_money_in_and_out_dont_mix(self):
        self.assertIsNone(st.suggest("noodle bar", "in", {"noodle bar": {"self": "dining"}}))


if __name__ == "__main__":
    unittest.main()
