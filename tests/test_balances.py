"""Tests for the net worth data: balances read from statements, and your accounts."""

import json
import tempfile
import unittest
from pathlib import Path

from split_expenses.balances import (
    balance_from_ofx,
    balance_from_text,
    balances_from_csv,
    change_accounts,
    read_accounts,
    statement_balances,
)

# Made-up statement text, shaped like the real ones.
BANK = """FAKE BANK
SOMEONE ! Account # 1111 2222 3344 ! December 9, 2025 to January 9, 2026
for December 9, 2025 to January 9, 2026 Account number: 1111 2222 3344
Beginning balance on December 9, 2025 $2,000.00
Ending balance on January 9, 2026 $2,345.67
"""
CARD = """SOMEONE ! Account # 5555 6666 7777 8899 ! December 12 - January 11, 2026
Account Summary/Payment Information New Balance Total $1,234.50
Previous Balance $900.00
"""
OFX_BANK = "<OFX><BANKACCTFROM><ACCTID>000123456789</BANKACCTFROM><LEDGERBAL><BALAMT>5012.34<DTASOF>20260131120000</LEDGERBAL></OFX>"
OFX_CARD = (
    "<OFX><CCACCTFROM><ACCTID>4111222233334444</CCACCTFROM><LEDGERBAL><BALAMT>-321.00<DTASOF>20260215</LEDGERBAL></OFX>"
)


class StatementBalanceTest(unittest.TestCase):
    def test_bank_statement(self):
        self.assertEqual(
            balance_from_text(BANK), {"ref": "3344", "kind": "bank", "date": "2026-01-09", "cents": 234567}
        )

    def test_card_statement_uses_the_period_end(self):
        self.assertEqual(
            balance_from_text(CARD), {"ref": "8899", "kind": "card", "date": "2026-01-11", "cents": 123450}
        )

    def test_nothing_to_find(self):
        self.assertIsNone(balance_from_text("just some text"))
        self.assertIsNone(balance_from_text("Ending balance on January 9, 2026 $5.00"), "no account number, no match")

    def test_ofx(self):
        self.assertEqual(
            balance_from_ofx(OFX_BANK), {"ref": "6789", "kind": "bank", "date": "2026-01-31", "cents": 501234}
        )
        self.assertEqual(
            balance_from_ofx(OFX_CARD),
            {"ref": "4444", "kind": "card", "date": "2026-02-15", "cents": 32100},
            "owed, positive",
        )
        self.assertIsNone(balance_from_ofx("<OFX></OFX>"))


# A checking download with a summary on top and a running balance, oldest first.
CHECKING_CSV = """Description,,Summary Amt.
Beginning balance as of 01/01/2026,,"1,000.00"

Date,Description,Amount,Running Bal.
01/01/2026,Beginning balance as of 01/01/2026,,"1,000.00"
01/15/2026,FAKE PAYROLL,"3,000.00","4,000.00"
01/31/2026,FAKE RENT,"-1,500.00","2,500.00"
01/31/2026,FAKE CAFE,-4.50,"2,495.50"
02/10/2026,FAKE GROCER,-95.50,"2,400.00"
"""
# The same, newest first, as some banks do.
NEWEST_FIRST = """Date,Description,Amount,Balance
02/10/2026,FAKE GROCER,-95.50,"2,400.00"
01/31/2026,FAKE CAFE,-4.50,"2,495.50"
01/31/2026,FAKE RENT,"-1,500.00","2,500.00"
"""
# A brokerage's holdings, with an account column, a fund called "Total ...", and a total row.
HOLDINGS = """Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value
X11117788,Brokerage,VTSAX,Vanguard Total Stock Market Index,100,$120.00,"$12,000.00"
X11117788,Brokerage,SPAXX**,Money Market,,,"$500.50"
Z22225566,Roth IRA,FXAIX,Fidelity 500 Index,10,$200.00,"$2,000.00"
,,,Account Total,,,"$14,500.50"

"Date downloaded Nov-08-2026 3:15 p.m ET"
"""
# Holdings for one account with no account column: the digits come from the file name.
ONE_ACCOUNT = """Symbol,Description,Shares,Price,Market Value
VTI,Total Stock Market ETF,10,250.00,"2,500.00"
BND,Total Bond Market ETF,20,75.00,"1,500.00"
Total,,,,"4,000.00"
"""


class CsvBalanceTest(unittest.TestCase):
    def test_running_balance_one_per_month(self):
        self.assertEqual(
            balances_from_csv(CHECKING_CSV, "checking-3344.csv", "2026-02-11"),
            [
                {"ref": "3344", "kind": "bank", "date": "2026-01-31", "cents": 249550},
                {"ref": "3344", "kind": "bank", "date": "2026-02-10", "cents": 240000},
            ],
        )
        self.assertEqual(
            balances_from_csv(NEWEST_FIRST, "chk_3344.csv", "2026-02-11")[0],
            {"ref": "3344", "kind": "bank", "date": "2026-01-31", "cents": 249550},
            "newest-first files give the day's last balance too",
        )

    def test_running_balance_needs_the_account(self):
        self.assertIn("last four digits", balances_from_csv(CHECKING_CSV, "stmt.csv", "2026-02-11"))
        self.assertIn(
            "last four digits",
            balances_from_csv(CHECKING_CSV, "checking-2026.csv", "2026-02-11"),
            "a year isn't an account",
        )

    def test_holdings_add_up_per_account(self):
        self.assertEqual(
            sorted(balances_from_csv(HOLDINGS, "Portfolio_Positions.csv", "2026-11-09"), key=lambda b: b["ref"]),
            [
                {"ref": "5566", "kind": "investment", "date": "2026-11-08", "cents": 200000},
                {"ref": "7788", "kind": "investment", "date": "2026-11-08", "cents": 1250050},
            ],
            "a fund named Total isn't the total row; the date comes from 'Date downloaded'",
        )

    def test_holdings_total_row_and_file_name(self):
        self.assertEqual(
            balances_from_csv(ONE_ACCOUNT, "ira-9012.csv", "2026-11-09"),
            [{"ref": "9012", "kind": "investment", "date": "2026-11-09", "cents": 400000}],
            "the Total row is used, not added on top; no date in the file means the day it was saved",
        )
        self.assertIn("last four digits", balances_from_csv(ONE_ACCOUNT, "positions.csv", "2026-11-09"))

    def test_folders_and_problems(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "statements").mkdir()
            (root / "balances" / "jordan").mkdir(parents=True)
            (root / "statements" / "checking-3344.csv").write_text(CHECKING_CSV)
            (root / "statements" / "card.csv").write_text("Date,Description,Amount\n01/02/2026,X,-5.00\n")
            (root / "balances" / "jordan" / "ira-9012.csv").write_text(ONE_ACCOUNT)
            (root / "balances" / "positions.csv").write_text(ONE_ACCOUNT)
            cache = root / "desktop-data" / "statement-balances.json"
            found, problems = statement_balances(root, "me", cache)
            self.assertEqual(
                sorted((f["ref"], f["person"]) for f in found), [("3344", "me"), ("3344", "me"), ("9012", "jordan")]
            )
            self.assertEqual(
                [p["file"] for p in problems], ["balances/positions.csv"], "a transactions-only CSV isn't a problem"
            )
            self.assertEqual(
                statement_balances(root, "me", cache), (found, problems), "the cache gives the same answer"
            )


class AccountsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "desktop-data" / "accounts.json"
        self.people = ["jordan", "me"]

    def tearDown(self):
        self.tmp.cleanup()

    def change(self, **body):
        return change_accounts(self.path, self.people, body)

    def test_add_edit_balances_and_delete(self):
        data = self.change(op="add", name="  Retirement   401k ", type="retirement", owner="me")
        acct = data["accounts"][0]
        self.assertEqual(
            (acct["name"], acct["type"], acct["owner"], acct["closed"]), ("Retirement 401k", "retirement", "me", False)
        )
        self.change(op="edit", id=acct["id"], match="1234", closed=True)
        self.assertEqual(read_accounts(self.path)["accounts"][0]["match"], "1234")

        self.change(op="balances", date="2026-01-31", values={acct["id"]: 1_000_000})
        self.change(op="balances", date="2026-01-31", values={acct["id"]: 1_100_000})  # replaces, not adds
        self.change(op="balances", date="2026-02-28", values={acct["id"]: 1_200_000})
        self.assertEqual([b["cents"] for b in read_accounts(self.path)["balances"]], [1_100_000, 1_200_000])
        self.change(op="balances", date="2026-02-28", values={acct["id"]: None})  # cleared
        self.assertEqual(len(read_accounts(self.path)["balances"]), 1)

        self.change(op="delete", id=acct["id"])
        self.assertEqual(read_accounts(self.path), {"accounts": [], "balances": []})

    def test_refusals_change_nothing(self):
        self.change(op="add", name="Checking", type="checking", owner="joint")
        before = self.path.read_text()
        acct_id = read_accounts(self.path)["accounts"][0]["id"]
        for body in (
            {"op": "add", "name": "", "type": "checking", "owner": "me"},
            {"op": "add", "name": "X", "type": "crypto", "owner": "me"},
            {"op": "add", "name": "X", "type": "checking", "owner": "stranger"},
            {"op": "edit", "id": "nope", "name": "X"},
            {"op": "edit", "id": acct_id, "match": "12"},
            {"op": "balances", "date": "Jan 31", "values": {acct_id: 1}},
            {"op": "balances", "date": "2026-01-31", "values": {"nope": 1}},
            {"op": "balances", "date": "2026-01-31", "values": {acct_id: 1.5}},
            {"op": "wipe"},
        ):
            with self.assertRaises(ValueError, msg=str(body)):
                change_accounts(self.path, self.people, body)
        self.assertEqual(self.path.read_text(), before)

    def test_a_damaged_file_reads_as_empty(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text("{oops")
        self.assertEqual(read_accounts(self.path), {"accounts": [], "balances": []})
        self.path.write_text(
            json.dumps(
                {"accounts": [{"id": "a", "type": "bogus"}], "balances": [{"account": "a", "date": "x", "cents": 1}]}
            )
        )
        self.assertEqual(read_accounts(self.path), {"accounts": [], "balances": []})


if __name__ == "__main__":
    unittest.main()
