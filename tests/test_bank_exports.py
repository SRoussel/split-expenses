"""Tests for reading bank downloads (CSV, OFX/QFX) next to PDFs. All files are made up."""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from split_expenses import split_statements as st
from split_expenses.bank_exports import parse_csv, parse_ofx

# A checking account download with a balance summary above the transactions.
CHECKING = """Description,,Summary Amt.
Beginning balance as of 01/01/2026,,"1,000.00"
Total credits,,"3,250.00"
Total debits,,"-518.40"
Ending balance as of 01/31/2026,,"3,731.60"

Date,Description,Amount,Running Bal.
01/01/2026,Beginning balance as of 01/01/2026,,"1,000.00"
01/15/2026,"FAKE EMPLOYER DES:PAYROLL ID:123456 INDN:SOMEONE CO ID:9999999","3,250.00","4,250.00"
01/16/2026,FAKE NOODLE BAR,-18.40,"4,231.60"
01/20/2026,Online Banking transfer to SAV 1234 Confirmation# 1234567890,-500.00,"3,731.60"
"""

# A card that shows purchases as negative, with both a transaction and a posting date.
CARD_NEGATIVE = """Transaction Date,Post Date,Description,Category,Type,Amount,Memo
01/03/2026,01/04/2026,FAKE GROCER 123,Groceries,Sale,-84.20,
01/05/2026,01/06/2026,FAKE GROCER 123,Groceries,Sale,-84.20,
01/09/2026,01/10/2026,FAKE GADGET STORE,Shopping,Return,20.00,
01/12/2026,01/13/2026,FAKE CAFE,Food & Drink,Sale,-4.50,
"""

# A card that shows purchases as positive.
CARD_POSITIVE = """Date,Description,Amount
01/03/26,FAKE AIRLINE,412.30
01/07/26,FAKE BOOKSHOP,18.99
01/20/26,AUTOPAY PAYMENT - THANK YOU,-431.29
"""

# Separate debit and credit columns.
DEBIT_CREDIT = """Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
2026-01-03,2026-01-04,1111,FAKE HARDWARE,Merchandise,45.10,
2026-01-08,2026-01-09,1111,FAKE HARDWARE,Merchandise,,12.00
"""

OFX_SGML = """OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>000000000<ACCTID>11112222<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260101<DTEND>20260131
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260116120000[-5:EST]<TRNAMT>-18.40<FITID>2026011601<NAME>FAKE NOODLE BAR</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260115<TRNAMT>3250.00<FITID>2026011501<NAME>FAKE EMPLOYER<MEMO>PAYROLL</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260121<TRNAMT>-9.99<FITID>2026012101<NAME>B &amp; B BOOKS</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
"""

OFX_XML = """<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CCACCTFROM><ACCTID>9999</ACCTID></CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260204</DTPOSTED><DTUSER>20260203</DTUSER><TRNAMT>-52.30</TRNAMT><FITID>abc1</FITID><NAME>FAKE GAS STATION</NAME></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260210</DTPOSTED><TRNAMT>52.30</TRNAMT><FITID>abc2</FITID><NAME>PAYMENT THANK YOU</NAME></STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>
"""


def rows(txns):
    return [(t["date"], t["direction"], t["amount"], t["vendor"]) for t in txns]


class ExportsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def file(self, name, text):
        path = self.dir / name
        path.write_text(text)
        return path

    def test_checking_csv_with_a_summary_above(self):
        txns, note = parse_csv(self.file("checking.csv", CHECKING))
        self.assertEqual(
            rows(txns),
            [
                ("2026-01-15", "in", "3250.00", "FAKE EMPLOYER DES:PAYROLL ID:123456 INDN:SOMEONE CO ID:9999999"),
                ("2026-01-16", "out", "18.40", "FAKE NOODLE BAR"),
                ("2026-01-20", "out", "500.00", "Online Banking transfer to SAV 1234 Confirmation#"),
            ],
            "the opening balance row has no amount and is left out; long reference numbers are trimmed, as in PDFs",
        )
        self.assertIn("below zero", note)

    def test_cards_either_sign_is_worked_out(self):
        neg, note = parse_csv(self.file("a.csv", CARD_NEGATIVE))
        self.assertEqual(
            [(t["direction"], t["amount"]) for t in neg],
            [("out", "84.20"), ("out", "84.20"), ("in", "20.00"), ("out", "4.50")],
        )
        self.assertEqual(neg[0]["date"], "2026-01-03", "the transaction date, not the posting date")
        self.assertIn("below zero", note)

        pos, note = parse_csv(self.file("b.csv", CARD_POSITIVE))
        self.assertEqual(
            [(t["direction"], t["amount"]) for t in pos], [("out", "412.30"), ("out", "18.99"), ("in", "431.29")]
        )
        self.assertIn("above zero", note)
        self.assertEqual(pos[0]["date"], "2026-01-03")

    def test_sign_can_be_set(self):
        txns, note = parse_csv(self.file("b.csv", CARD_POSITIVE), sign="negative-out")
        self.assertEqual([t["direction"] for t in txns], ["in", "in", "out"])
        self.assertNotIn("auto", note)

    def test_debit_and_credit_columns(self):
        txns, note = parse_csv(self.file("c.csv", DEBIT_CREDIT))
        self.assertEqual(
            rows(txns),
            [("2026-01-03", "out", "45.10", "FAKE HARDWARE"), ("2026-01-08", "in", "12.00", "FAKE HARDWARE")],
        )
        self.assertEqual(note, "debit and credit columns")

    def test_not_a_bank_csv(self):
        with self.assertRaises(ValueError):
            parse_csv(self.file("x.csv", "name,age\nsam,40\n"))

    def test_ofx_old_and_new_style(self):
        txns = parse_ofx(self.file("a.ofx", OFX_SGML))
        self.assertEqual(
            rows(txns),
            [
                ("2026-01-16", "out", "18.40", "FAKE NOODLE BAR"),
                ("2026-01-15", "in", "3250.00", "FAKE EMPLOYER"),
                ("2026-01-21", "out", "9.99", "B & B BOOKS"),
            ],
        )
        self.assertEqual(txns[0]["_key"], "ofx|11112222|2026011601")
        xml = parse_ofx(self.file("b.qfx", OFX_XML))
        self.assertEqual(
            rows(xml),
            [("2026-02-03", "out", "52.30", "FAKE GAS STATION"), ("2026-02-10", "in", "52.30", "PAYMENT THANK YOU")],
        )
        with self.assertRaises(ValueError):
            parse_ofx(self.file("c.ofx", "hello"))

    def test_ids_dont_depend_on_the_file_name(self):
        """Downloading an overlapping range again shouldn't ask about the same transactions."""
        a, _ = parse_csv(self.file("january.csv", CARD_NEGATIVE))
        b, _ = parse_csv(self.file("january-again.csv", CARD_NEGATIVE))
        self.assertEqual([st.txn_key("january.csv", t) for t in a], [st.txn_key("january-again.csv", t) for t in b])
        self.assertEqual(len({st.txn_key("x", t) for t in a}), 4, "two identical grocery runs are still two")
        o1 = parse_ofx(self.file("one.ofx", OFX_SGML))
        o2 = parse_ofx(self.file("two.ofx", OFX_SGML))
        self.assertEqual([st.txn_key("one.ofx", t) for t in o1], [st.txn_key("two.ofx", t) for t in o2])

    def test_pdfs_and_downloads_together(self):
        """A folder with a PDF and downloads: every file is read, the PDF the way it always was."""
        (self.dir / "statement.pdf").write_bytes(b"%PDF-1.4 stand-in")
        self.file("card.csv", CARD_NEGATIVE)
        self.file("bank.ofx", OFX_SGML)
        self.file("notes.txt", "not a statement")
        pdf_txns = st.parse_text("01/16 FAKE NOODLE BAR -18.40\n", "statement.pdf")
        seen = {}

        def fake_review(txns_by_file, *_):
            seen.update(txns_by_file)

        with (
            mock.patch.object(st, "parse_pdf", return_value=pdf_txns) as parse_pdf,
            mock.patch.object(st, "review", side_effect=fake_review),
            mock.patch("sys.argv", ["split-statements", str(self.dir), "--state", str(self.dir / "state.json")]),
            mock.patch("builtins.print"),
        ):
            st.main()
        parse_pdf.assert_called_once()
        self.assertEqual(sorted(seen), ["bank.ofx", "card.csv", "statement.pdf"])
        self.assertEqual(seen["statement.pdf"], pdf_txns)
        self.assertEqual(len(seen["card.csv"]), 4)
        self.assertEqual(len(seen["bank.ofx"]), 3)
        # PDF ids are made the way they always were.
        self.assertNotIn("_key", pdf_txns[0])


if __name__ == "__main__":
    unittest.main()
