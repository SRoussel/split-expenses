// Run with:  npm test   (needs Node 22.6 or newer)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activeFilterCount,
  balanceFor,
  filterTotals,
  isFiltering,
  matchesFilter,
  NO_FILTER,
  type EntryFilter,
  describeBalance,
  exportLedgerCsv,
  fmt,
  owedCents,
  parseDollars,
  parseSummary,
  summaryToImport,
  totalsByCategory,
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
    category: null,
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

// The same files the Python tests use (they check `split-ledger summarize` produces exactly
// expected_summary_v2.json from the sample CSVs), so both ends of the import agree.
const fixture = (name: string) => readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url), "utf8");

test("parseSummary reads what `split-ledger summarize` writes (v2)", () => {
  const s = parseSummary(fixture("expected_summary_v2.json"));
  assert.equal(s.name, "Expenses 01/15/26-02/03/26");
  assert.equal(s.shared?.totalCents, 134955);
  assert.deepEqual(s.shared?.months["2026-02"], { groceries: 2025 }, "the shared return reduced groceries");
  assert.equal(s.personal?.months["2026-01"].income, 325042);
  assert.deepEqual(totalsByCategory(s.personal!.months), {
    dining: 1840, entertainment: 4499, fees: 3500, income: 650042, transport: 5230,
  });
});

test("parseSummary still reads version 1 files (shared totals only)", () => {
  const s = parseSummary(fixture("expected_summary_v1.json"));
  assert.equal(s.personal, null);
  assert.equal(s.shared?.totalCents, 136205);
  assert.deepEqual(s.shared?.months, { "2026-01": { dining: 4510, groceries: 11695, household: 120000 } });
});

test("parseSummary refuses the detailed CSVs and anything unexpected", () => {
  assert.throws(() => parseSummary(fixture("sample_split_transactions.csv")), /detailed transactions file/);
  assert.throws(() => parseSummary(fixture("sample_personal_transactions.csv")), /detailed transactions file/);
  const good = () => JSON.parse(fixture("expected_summary_v2.json"));
  type D = Record<string, any>;
  const bad: [string, (d: D) => void, RegExp][] = [
    ["extra field (e.g. transactions)", (d) => (d.transactions = [{ vendor: "X" }]), /unexpected fields \(transactions\)/],
    ["extra field inside personal", (d) => (d.personal.vendors = ["X"]), /unexpected fields in its personal part/],
    ["wrong format", (d) => (d.format = "x"), /isn't a statement summary/],
    ["newer version", (d) => (d.version = 3), /newer version/],
    ["shared doesn't add up", (d) => (d.shared.months["2026-01"].dining += 1), /don't add up/],
    ["income in the shared part", (d) => (d.shared.months["2026-01"].income = 1), /unknown shared category/],
    ["unknown personal category", (d) => (d.personal.months["2026-01"].shopping = 1), /unknown personal category/],
    ["negative income", (d) => (d.personal.months["2026-01"].income = -1), /negative income/],
    ["dollars, not cents", (d) => (d.personal.months["2026-01"].dining = 18.4), /isn't valid/],
    ["month outside the dates", (d) => (d.personal.months["2026-05"] = { dining: 1 }), /outside its dates/],
    ["impossible date", (d) => (d.start = "2026-02-31"), /dates aren't valid/],
    ["empty", (d) => { delete d.shared; delete d.personal; }, /empty/],
  ];
  for (const [label, mutate, message] of bad) {
    const d = good();
    mutate(d);
    assert.throws(() => parseSummary(JSON.stringify(d)), message, label);
  }
});

test("an import sends only names, the period and month/category totals", () => {
  const s = parseSummary(fixture("expected_summary_v2.json"));
  const body = summaryToImport(s, {
    name: s.name,
    shared: { payerId: "sam-id", payerSharePct: 50 },
    personId: "sam-id",
  });
  assert.deepEqual(Object.keys(body).sort(), ["end", "name", "personal", "shared", "start"]);
  assert.deepEqual(Object.keys(body.shared!).sort(), ["months", "payer_id", "payer_share_pct", "total_cents"]);
  assert.deepEqual(Object.keys(body.personal!).sort(), ["months", "person_id"]);
  assert.doesNotMatch(JSON.stringify(body), /FAKE|"count"|vendor/, "no merchants, no counts");
  // Leaving parts out.
  const sharedOnly = summaryToImport(s, { name: "x", shared: { payerId: "a", payerSharePct: 50 }, personId: null });
  assert.equal(sharedOnly.personal, undefined);
  const personalOnly = summaryToImport(s, { name: "x", shared: null, personId: "a" });
  assert.equal(personalOnly.shared, undefined);
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

test("search and filters", () => {
  const groceries = entry({ kind: "expense", payer_id: ME, amount_cents: 8420, owed_cents: 4210, name: "Costco run", category: "groceries", entry_date: "2026-03-14" });
  const rent = entry({ kind: "expense", payer_id: PARTNER, amount_cents: 200000, owed_cents: 100000, name: "Rent", entry_date: "2026-04-01" });
  const paid = entry({ kind: "settlement", payer_id: ME, amount_cents: 5000, owed_cents: 5000, name: "Settlement", entry_date: "2026-04-02" });
  const all = [groceries, rent, paid];
  const find = (f: Partial<EntryFilter>) => all.filter((e) => matchesFilter(e, { ...NO_FILTER, ...f }, ME)).map((e) => e.name);

  assert.deepEqual(find({}), ["Costco run", "Rent", "Settlement"]);
  assert.deepEqual(find({ text: "  COSTCO " }), ["Costco run"], "case and spaces don't matter");
  assert.deepEqual(find({ text: "grocer" }), ["Costco run"], "the category counts as text");
  assert.deepEqual(find({ text: "84.20" }), ["Costco run"], "an exact amount");
  assert.deepEqual(find({ text: "$2,000" }), ["Rent"]);
  assert.deepEqual(find({ kind: "settlement" }), ["Settlement"]);
  assert.deepEqual(find({ payer: "partner" }), ["Rent"]);
  assert.deepEqual(find({ payer: "me", kind: "expense" }), ["Costco run"]);
  assert.deepEqual(find({ category: "groceries" }), ["Costco run"]);
  assert.deepEqual(find({ category: "none" }), ["Rent"], "no category: expenses only");
  assert.deepEqual(find({ from: "2026-04-01" }), ["Rent", "Settlement"]);
  assert.deepEqual(find({ from: "2026-03-01", to: "2026-04-01" }), ["Costco run", "Rent"], "both ends inclusive");

  assert.equal(activeFilterCount(NO_FILTER), 0);
  assert.equal(activeFilterCount({ ...NO_FILTER, text: "x", payer: "me", from: "2026-01-01", to: "2026-02-01" }), 2);
  assert.equal(isFiltering({ ...NO_FILTER, text: " " }), false);

  const voided = entry({ kind: "expense", payer_id: ME, amount_cents: 999, owed_cents: 500, voided_at: "2026-04-03T00:00:00Z" });
  assert.deepEqual(filterTotals([...all, voided], ME), { count: 4, spent: 208420, mine: 4210 + 100000 },
    "expenses only, not voided; my share is what I paid for myself plus what I owe");
});
