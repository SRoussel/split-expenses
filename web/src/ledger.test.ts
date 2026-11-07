// Run with:  npm test   (needs Node 22.6 or newer)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  balanceFor,
  describeBalance,
  exportLedgerCsv,
  fmt,
  owedCents,
  parseDollars,
  parseSummary,
  summaryToEntry,
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
    replaced_by: null,
    recurring_id: null,
    occurrence_date: null,
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

// The same files the Python tests use (CI checks `split-ledger summarize` produces exactly
// expected_summary.json from the sample CSV), so both ends of the import agree.
const fixture = (name: string) => readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url), "utf8");

test("parseSummary reads what `split-ledger summarize` writes", () => {
  const s = parseSummary(fixture("expected_summary.json"));
  assert.deepEqual(s, {
    name: "Expenses 01/15/26-02/03/26",
    start: "2026-01-15",
    end: "2026-02-03",
    count: 4,
    totalCents: 136205,
    byCategory: { dining: 4510, groceries: 11695, household: 120000 },
  });
  // --no-categories
  const bare = JSON.parse(fixture("expected_summary.json"));
  delete bare.categories;
  assert.equal(parseSummary(JSON.stringify(bare)).byCategory, null);
});

test("parseSummary refuses the detailed CSV and anything unexpected", () => {
  assert.throws(() => parseSummary(fixture("sample_split_transactions.csv")), /detailed transactions file/);
  const good = () => JSON.parse(fixture("expected_summary.json"));
  const bad: [string, (d: Record<string, unknown>) => void, RegExp][] = [
    ["extra field (e.g. transactions)", (d) => (d.transactions = [{ vendor: "X", amount: 1 }]), /unexpected fields \(transactions\)/],
    ["wrong format", (d) => (d.format = "something-else"), /isn't a statement summary/],
    ["newer version", (d) => (d.version = 2), /newer version/],
    ["categories don't add up", (d) => ((d.categories as Record<string, number>).dining += 1), /don't add up/],
    ["total in dollars, not cents", (d) => (d.total_cents = 1362.05), /total isn't valid/],
    ["impossible date", (d) => (d.start = "2026-02-31"), /dates aren't valid/],
    ["start after end", (d) => (d.start = "2026-03-01"), /dates aren't valid/],
    ["empty name", (d) => (d.name = "  "), /name is missing/],
    ["zero transactions", (d) => (d.count = 0), /count isn't valid/],
    ["negative category", (d) => ((d.categories as Record<string, number>).dining = -1), /categories aren't valid/],
  ];
  for (const [label, mutate, message] of bad) {
    const d = good();
    mutate(d);
    assert.throws(() => parseSummary(JSON.stringify(d)), message, label);
  }
  assert.throws(() => parseSummary("[1, 2]"), /isn't a statement summary/);
  assert.throws(() => parseSummary("hello"), /isn't a statement summary/);
});

test("an import sends only the name, total, payer, split and date", () => {
  const s = parseSummary(fixture("expected_summary.json"));
  const entry = summaryToEntry(s, "payer-id", 50, "2026-11-07");
  assert.deepEqual(Object.keys(entry).sort(), ["amount_cents", "entry_date", "kind", "name", "payer_id", "payer_share_pct"]);
  assert.deepEqual(entry, {
    kind: "expense",
    entry_date: "2026-11-07",
    name: "Expenses 01/15/26-02/03/26",
    amount_cents: 136205,
    payer_id: "payer-id",
    payer_share_pct: 50,
  });
  // Nothing from the categories or the count tags along.
  assert.doesNotMatch(JSON.stringify(entry), /groceries|dining|household|"count"/);
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

// ---------------------------------------------------------------------------
// Recurring expense dates (shared/recurring.ts)
// ---------------------------------------------------------------------------

import { describeSchedule, dueOccurrences, firstIndexOnOrAfter, occurrenceDate } from "../shared/recurring";

test("monthly on the 31st clamps to short months without drifting", () => {
  assert.equal(occurrenceDate("2027-01-31", "monthly", 0), "2027-01-31");
  assert.equal(occurrenceDate("2027-01-31", "monthly", 1), "2027-02-28");
  assert.equal(occurrenceDate("2027-01-31", "monthly", 2), "2027-03-31"); // back to the 31st
  assert.equal(occurrenceDate("2027-01-31", "monthly", 3), "2027-04-30");
  assert.equal(occurrenceDate("2028-01-31", "monthly", 1), "2028-02-29"); // leap year
  assert.equal(occurrenceDate("2026-11-15", "monthly", 2), "2027-01-15"); // across the year
  assert.equal(occurrenceDate("2026-11-15", "monthly", 14), "2028-01-15");
});

test("weekly and yearly", () => {
  assert.equal(occurrenceDate("2026-12-29", "weekly", 1), "2027-01-05");
  assert.equal(occurrenceDate("2026-11-07", "weekly", 52), "2027-11-06");
  assert.equal(occurrenceDate("2028-02-29", "yearly", 1), "2029-02-28");
  assert.equal(occurrenceDate("2028-02-29", "yearly", 4), "2032-02-29");
});

test("due occurrences catch up in order and stop at today", () => {
  assert.deepEqual(dueOccurrences("2027-01-31", "monthly", 0, "2027-04-15"), [
    { index: 0, date: "2027-01-31" },
    { index: 1, date: "2027-02-28" },
    { index: 2, date: "2027-03-31" },
  ]);
  assert.deepEqual(dueOccurrences("2027-01-31", "monthly", 3, "2027-04-15"), []);
  assert.equal(dueOccurrences("2027-01-01", "monthly", 0, "2027-01-01").length, 1, "due on the day itself");
  assert.equal(dueOccurrences("2000-01-01", "weekly", 0, "2027-01-01").length, 60, "capped");
});

test("resuming skips the paused period", () => {
  assert.equal(firstIndexOnOrAfter("2027-01-01", "monthly", 0, "2027-04-02"), 4); // May 1
  assert.equal(firstIndexOnOrAfter("2027-01-01", "monthly", 0, "2027-04-01"), 3); // Apr 1 itself
});

test("schedule descriptions", () => {
  assert.equal(describeSchedule("2026-11-01", "monthly"), "Monthly on the 1st");
  assert.equal(describeSchedule("2026-11-22", "monthly"), "Monthly on the 22nd");
  assert.equal(describeSchedule("2026-11-30", "monthly"), "Monthly on the 30th (or the last day)");
  assert.equal(describeSchedule("2026-11-09", "weekly"), "Weekly on Mondays");
  assert.equal(describeSchedule("2026-03-05", "yearly"), "Yearly on Mar 5");
});
