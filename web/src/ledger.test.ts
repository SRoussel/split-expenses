// Run with:  npm test   (needs Node 22.6 or newer)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  balanceFor,
  describeBalance,
  exportLedgerCsv,
  fmt,
  owedCents,
  parseCsv,
  parseDollars,
  summarizeImport,
} from "./ledger.ts";
import type { Entry } from "./types.ts";

const ME = "me-id";
const PARTNER = "partner-id";

let n = 0;
function entry(p: Partial<Entry> & Pick<Entry, "kind" | "payer_id" | "amount_cents" | "owed_cents">): Entry {
  n++;
  return {
    id: String(n),
    household_id: "h",
    entry_date: "2026-01-01",
    name: "x",
    payer_share_pct: null,
    created_by: p.payer_id,
    created_at: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`,
    voided_at: null,
    voided_by: null,
    ...p,
  };
}

test("parseDollars", () => {
  assert.equal(parseDollars("84.20"), 8420);
  assert.equal(parseDollars("$1,200"), 120000);
  assert.equal(parseDollars("5"), 500);
  assert.equal(parseDollars("5.5"), 550);
  assert.equal(parseDollars(".99"), 99);
  assert.equal(parseDollars("0"), null);
  assert.equal(parseDollars("-4"), null);
  assert.equal(parseDollars("abc"), null);
  assert.equal(parseDollars("1.234"), null);
  assert.equal(parseDollars(""), null);
});

test("owedCents: the non-payer owes their share rounded half up; the payer keeps the remainder", () => {
  assert.equal(owedCents("expense", 8420, 50), 4210);
  assert.equal(owedCents("expense", 6000, 70), 1800); // payer covers 70%, other owes 30%
  assert.equal(owedCents("expense", 101, 50), 51); // $1.01 split: other owes 51c, payer pays 50c
  assert.equal(owedCents("expense", 5, 50), 3); // $0.05 split: other owes 3c, payer pays 2c
  assert.equal(owedCents("expense", 5, 100), 0);
  assert.equal(owedCents("expense", 1001, 33.33), 667); // 1001 * 66.67% = 667.3
  assert.equal(owedCents("settlement", 10000), 10000);
  assert.equal(owedCents("opening", 50000), 50000);
  assert.throws(() => owedCents("expense", 100, 33.333));
  assert.throws(() => owedCents("expense", 100, 101));
});

test("the same expense gives the same amount no matter who is looking", () => {
  // Partner pays $1.01, I take 50%: I owe 51c. Matches split_ledger.py (my_part rounded half up).
  assert.equal(owedCents("expense", 101, 100 - 50), 51);
});


test("balance: the CLI walkthrough gives the same numbers", () => {
  // init --i-owe 500  ->  partner is owed 500
  // add 84.20 me       ->  partner owes me 42.10
  // add 120 partner    ->  I owe partner 60.00
  // add 60 me --my-share 70 -> payer (me) covers 70%, partner owes 18.00
  const entries = [
    entry({ kind: "opening", payer_id: PARTNER, amount_cents: 50000, owed_cents: 50000 }),
    entry({ kind: "expense", payer_id: ME, amount_cents: 8420, payer_share_pct: 50, owed_cents: 4210 }),
    entry({ kind: "expense", payer_id: PARTNER, amount_cents: 12000, payer_share_pct: 50, owed_cents: 6000 }),
    entry({ kind: "expense", payer_id: ME, amount_cents: 6000, payer_share_pct: 70, owed_cents: 1800 }),
  ];
  assert.equal(balanceFor(entries, ME), -50000 + 4210 - 6000 + 1800); // -49,990 (I owe 499.90)
  assert.equal(balanceFor(entries, PARTNER), 49990);

  // settle 100 paid by me -> moves toward zero
  entries.push(entry({ kind: "settlement", payer_id: ME, amount_cents: 10000, owed_cents: 10000 }));
  assert.equal(balanceFor(entries, ME), -39990);
});

test("voided entries don't count", () => {
  const e = entry({ kind: "expense", payer_id: ME, amount_cents: 1000, payer_share_pct: 50, owed_cents: 500 });
  assert.equal(balanceFor([e], ME), 500);
  assert.equal(balanceFor([{ ...e, voided_at: "2026-01-02T00:00:00Z" }], ME), 0);
});

test("describeBalance", () => {
  assert.equal(describeBalance(14210, "Sam"), "Sam owes you $142.10");
  assert.equal(describeBalance(-50000, "Sam"), "You owe Sam $500.00");
  assert.equal(describeBalance(0, "Sam"), "All settled up");
  assert.equal(fmt(-1234), "$12.34");
});

test("parseCsv handles quotes, commas and CRLF", () => {
  const rows = parseCsv('a,b\r\n1,"x, ""y"""\r\n\r\n2,z\n');
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", 'x, "y"'],
    ["2", "z"],
  ]);
});

test("summarizeImport totals the statement script's CSV", () => {
  const csv = [
    "date,amount,vendor,category",
    "2026-01-15,52.10,WHOLE FOODS,groceries",
    "2026-02-03,120.55,CON EDISON,utilities",
    '2026-01-28,18.40,"CHIPOTLE, INC",dining',
    "bad,5.00,X,dining",
  ].join("\n");
  const s = summarizeImport(csv);
  assert.equal(s.count, 3);
  assert.equal(s.skipped, 1);
  assert.equal(s.totalCents, 19105);
  assert.equal(s.name, "Expenses 01/15/26-02/03/26");
  assert.deepEqual(s.byCategory, { groceries: 5210, utilities: 12055, dining: 1840 });
  assert.throws(() => summarizeImport("date,vendor\n2026-01-01,x"), /date' and 'amount/);
  assert.throws(() => summarizeImport("date,amount\nnope,1"), /No valid/);
});

test("export uses the CLI ledger.csv format", () => {
  const entries = [
    entry({ kind: "opening", payer_id: PARTNER, amount_cents: 50000, owed_cents: 50000, name: "Starting balance" }),
    entry({ kind: "expense", payer_id: ME, amount_cents: 6000, payer_share_pct: 70, owed_cents: 1800, name: "dinner" }),
    entry({ kind: "expense", payer_id: PARTNER, amount_cents: 12000, payer_share_pct: 30, owed_cents: 8400, name: "power, bill" }),
    entry({ kind: "settlement", payer_id: ME, amount_cents: 10000, owed_cents: 10000, name: "Venmo" }),
    entry({ kind: "expense", payer_id: ME, amount_cents: 999, payer_share_pct: 50, owed_cents: 500, name: "voided", voided_at: "2026-01-03T00:00:00Z" }),
  ];
  const lines = exportLedgerCsv(entries, ME).trim().split("\n");
  assert.deepEqual(lines, [
    "date,type,payer,amount,my_share,name",
    "2026-01-01,opening_me_owes,,500.00,,Starting balance",
    "2026-01-01,expense,me,60.00,70,dinner",
    '2026-01-01,expense,partner,120.00,70,"power, bill"',
    "2026-01-01,settlement,me,100.00,,Venmo",
  ]);
  // From the partner's side the roles flip.
  const theirs = exportLedgerCsv(entries, PARTNER).trim().split("\n");
  assert.equal(theirs[1], "2026-01-01,opening_partner_owes,,500.00,,Starting balance");
  assert.equal(theirs[2], "2026-01-01,expense,partner,60.00,30,dinner");
});
