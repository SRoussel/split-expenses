"""Tests for the net worth data: balances read from statements, and your accounts."""

import json
import tempfile
import unittest
from pathlib import Path

from split_expenses.balances import balance_from_ofx, balance_from_text, change_accounts, read_accounts

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
