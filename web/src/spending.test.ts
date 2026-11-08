import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, compare, coverage, monthsEnding, nonPayerPart, sharedItemsFor, summarize, UNCATEGORIZED } from "./spending.ts";
import { owedCents } from "../shared/owed.ts";
import type { Entry, SpendingData } from "./types.ts";

const A = "alex";
const B = "sam";
let n = 0;
function entry(p: Partial<Entry>): Entry {
  n++;
  return {
    id: `e${n}`, household_id: "h", kind: "expense", entry_date: "2026-01-10", name: `Entry ${n}`,
    amount_cents: 10000, payer_id: A, payer_share_pct: 50, owed_cents: 5000, created_by: A,
    created_at: "2026-01-10T00:00:00Z", voided_at: null, voided_by: null, replaced_by: null,
    recurring_id: null, occurrence_date: null, category: null, ...p,
  };
}

const imported = entry({ id: "imp", payer_id: B, amount_cents: 100000, name: "Expenses 01/05/26-02/04/26" });
const entries: Entry[] = [
  entry({ category: "groceries" }), // Alex paid $100 groceries, 50/50
  imported, // Sam paid $1,000: Jan household $800, Feb groceries $200
  entry({ category: "dining", voided_at: "2026-01-11T00:00:00Z" }), // voided: ignored
  entry({ kind: "settlement", payer_share_pct: null }), // a payment: not spending
  entry({ kind: "opening", payer_share_pct: null }), // starting balance: not spending
  entry({ amount_cents: 3000, payer_share_pct: 100 }), // Alex's, no category, Alex pays it all
];
const data: SpendingData = {
  batches: [
    { id: "b1", person_id: A, name: "Alex Jan", start_date: "2026-01-05", end_date: "2026-01-20", entry_id: null, created_by: A, created_at: "" },
    { id: "b2", person_id: A, name: "Alex Jan 2", start_date: "2026-01-15", end_date: "2026-02-03", entry_id: null, created_by: A, created_at: "" },
    { id: "b3", person_id: B, name: "Sam Feb", start_date: "2026-02-01", end_date: "2026-02-28", entry_id: null, created_by: A, created_at: "" },
  ],
  totals: [
    { batch_id: "b1", month: "2026-01", category: "income", cents: 300000 },
    { batch_id: "b1", month: "2026-01", category: "dining", cents: 5000 },
    { batch_id: "b2", month: "2026-01", category: "entertainment", cents: -2000 }, // returns only
    { batch_id: "b3", month: "2026-02", category: "income", cents: 200000 },
    { batch_id: "b3", month: "2026-02", category: "transport", cents: 4000 },
  ],
  breakdown: [
    { entry_id: "imp", month: "2026-01", category: "household", cents: 80000 },
    { entry_id: "imp", month: "2026-02", category: "groceries", cents: 20000 },
  ],
};
const index = buildIndex(entries, data, [A, B]);
const sum = (view: Parameters<typeof summarize>[1], month: string) => summarize(index, view, month, A, B);

test("household view: everything, shared at full amount", () => {
  const jan = sum("household", "2026-01");
  assert.deepEqual(jan.categories, {
    groceries: 10000, household: 80000, [UNCATEGORIZED]: 3000, dining: 5000, entertainment: -2000,
  });
  assert.equal(jan.income, 300000);
  assert.equal(jan.spent, 96000);
  assert.equal(jan.net, 204000);
});

test("each person: their own uploads plus their share of shared expenses", () => {
  const alex = sum("me", "2026-01");
  assert.deepEqual(alex.categories, {
    groceries: 5000, household: 40000, [UNCATEGORIZED]: 3000, dining: 5000, entertainment: -2000,
  });
  assert.equal(alex.income, 300000);
  const sam = sum("partner", "2026-01");
  assert.deepEqual(sam.categories, { groceries: 5000, household: 40000 });
  assert.equal(sam.income, 0, "no statement uploaded for Sam in January");
  assert.equal(sum("partner", "2026-02").income, 200000);
});

test("you + partner = household, every month and category", () => {
  for (const month of index.months) {
    const [me, them, both] = [sum("me", month), sum("partner", month), sum("household", month)];
    const cats = new Set([...Object.keys(me.categories), ...Object.keys(them.categories), ...Object.keys(both.categories)]);
    for (const c of cats) {
      assert.equal((me.categories[c] ?? 0) + (them.categories[c] ?? 0), both.categories[c] ?? 0, `${month} ${c}`);
    }
    assert.equal((me.income ?? 0) + (them.income ?? 0), both.income);
  }
});

test("shared view: shared expenses only, no income", () => {
  const jan = sum("shared", "2026-01");
  assert.deepEqual(jan.categories, { groceries: 10000, household: 80000, [UNCATEGORIZED]: 3000 });
  assert.equal(jan.income, null);
  assert.equal(jan.net, null);
});

test("payments, starting balances and voided entries never count as spending", () => {
  const total = index.months.reduce((n, m) => n + sum("shared", m).spent, 0);
  assert.equal(total, 10000 + 100000 + 3000);
});

test("odd cents: the non-payer's part matches what the ledger says they owe", () => {
  for (const [cents, payerPct] of [[101, 50], [5, 50], [1001, 33.33], [999, 70]]) {
    assert.equal(nonPayerPart(cents, 100 - payerPct), owedCents("expense", cents, payerPct), `${cents} @ ${payerPct}`);
  }
  assert.equal(nonPayerPart(-101, 50), -51, "returns round the same way, mirrored");
});

test("coverage: overlapping uploads count once", () => {
  assert.deepEqual(coverage(data.batches, A, "2026-01"), { covered: 27, days: 31, ranges: [[5, 31]] });
  assert.deepEqual(coverage(data.batches, A, "2026-02"), { covered: 3, days: 28, ranges: [[1, 3]] });
  assert.deepEqual(coverage(data.batches, B, "2026-01"), { covered: 0, days: 31, ranges: [] });
});

test("comparisons skip months with nothing in them", () => {
  const extra = buildIndex(
    [entry({ entry_date: "2025-10-03", category: "groceries", amount_cents: 20000 }),
     entry({ entry_date: "2025-12-03", category: "groceries", amount_cents: 40000 }),
     ...entries],
    data, [A, B]);
  const c = compare(extra, "shared", "2026-01", A, B, (s) => s.categories.groceries ?? 0);
  assert.equal(c.previous, 40000, "December");
  assert.equal(c.average, 30000, "October and December; November had nothing");
  assert.equal(c.months, 2);
});

test("month helpers", () => {
  assert.deepEqual(monthsEnding("2026-02", 3), ["2025-12", "2026-01", "2026-02"]);
});

test("category detail lists the shared expenses with the part that counts", () => {
  const items = sharedItemsFor(index, "me", "2026-01", "household", A, B);
  assert.equal(items.length, 1);
  assert.equal(items[0].cents, 80000);
  assert.equal(items[0].counted, 40000);
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

import { rangeMonths, rangeReport, reportCsv, isPartial } from "./spending.ts";

test("ranges", () => {
  assert.deepEqual(rangeMonths("2026-03", "ytd"), ["2026-01", "2026-02", "2026-03"]);
  assert.equal(rangeMonths("2026-03", "12m")[0], "2025-04");
  assert.equal(rangeMonths("2026-03", "6m").length, 6);
});

test("a month is partial when someone's uploads cover only part of it", () => {
  assert.equal(isPartial(data.batches, [A], "2026-01"), true, "Jan 5-31 of 31 days");
  assert.equal(isPartial(data.batches, [B], "2026-02"), false, "Sam's February is complete");
  assert.equal(isPartial(data.batches, [B], "2026-01"), false, "nothing uploaded isn't 'partial'");
  assert.equal(isPartial(data.batches, [], "2026-01"), false, "the shared view has no coverage");
});

test("range report: totals, shares and averages over full months only", () => {
  const r = rangeReport(index, data.batches, "household", ["2026-01", "2026-02"], A, B);
  const byCat = Object.fromEntries(r.categories.map((c) => [c.category, c]));
  assert.equal(byCat.household.total, 80000);
  assert.equal(byCat.groceries.total, 10000 + 20000);
  assert.deepEqual(byCat.groceries.series, [10000, 20000]);
  assert.equal(r.spent, 96000 + 24000);
  assert.equal(r.income, 500000);
  assert.equal(r.net, 500000 - 120000);
  assert.deepEqual(r.partial, [true, true], "Alex's uploads cover only part of both months");
  assert.equal(byCat.groceries.average, null, "no full months to average");
  assert.ok(Math.abs(r.categories.reduce((n, c) => n + c.share, 0) - 1) < 1e-9, "shares add up to 100%");
  assert.equal(r.categories[0].category, "household", "largest first");

  const shared = rangeReport(index, data.batches, "shared", ["2026-01", "2026-02"], A, B);
  assert.equal(shared.income, null);
  assert.equal(shared.categories.find((c) => c.category === "groceries")!.average, 15000, "shared months are always full");
});

test("CSV: one row per month, totals only", () => {
  const r = rangeReport(index, data.batches, "me", ["2026-01", "2026-02"], A, B);
  const csv = reportCsv(r, (c) => (c === UNCATEGORIZED ? "No category" : c));
  const [head, jan, feb] = csv.trim().split("\n");
  assert.equal(head, "month,income,spent,net,household,groceries,dining,No category,entertainment,partial");
  assert.equal(jan, "2026-01,3000.00,510.00,2490.00,400.00,50.00,50.00,30.00,-20.00,yes");
  assert.equal(feb, "2026-02,0.00,100.00,-100.00,0.00,100.00,0.00,0.00,0.00,yes");
  assert.doesNotMatch(csv, /Entry \d|Expenses 01/, "no entry names");
});
