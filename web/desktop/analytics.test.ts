import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFilters,
  byCategory,
  byMerchant,
  byMonth,
  change,
  monthRange,
  presetRange,
  previousPeriod,
  shiftMonth,
  similarNames,
  totals,
  type Filters,
  type Txn,
} from "./analytics.ts";

let n = 0;
const txn = (
  date: string,
  cents: number,
  merchant: string,
  category: string,
  kind: Txn["kind"] = "personal",
  person = "me",
): Txn => ({
  id: String(n++),
  date,
  cents,
  vendor: merchant.toUpperCase() + " SPRINGFIELD ME 1234 1111",
  auto: merchant,
  merchant,
  category,
  kind,
  person,
  source: ".",
});

const TXNS = [
  txn("2026-01-05", 8000, "Freshway", "groceries", "shared"),
  txn("2026-01-09", 1250, "Cafe Bluebell", "dining"),
  txn("2026-01-15", 300000, "Acme Corp", "income"),
  txn("2026-02-02", 6000, "Freshway", "groceries", "shared"),
  txn("2026-02-03", -1000, "Freshway", "groceries", "shared"), // a return
  txn("2026-02-20", 4000, "Cafe Bluebell", "dining", "personal", "jordan"),
  txn("2026-03-01", 2500, "Costco", "groceries", "shared"),
];

const all: Filters = {
  from: "2026-01",
  to: "2026-03",
  person: null,
  kind: null,
  category: null,
  merchant: null,
  month: null,
  query: "",
};

test("months: ranges across a year end, and shifting", () => {
  assert.deepEqual(monthRange("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(monthRange("2026-03", "2026-03"), ["2026-03"]);
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-01", -13), "2024-12");
  assert.equal(shiftMonth("2025-12", 1), "2026-01");
});

test("presets end at the latest month with data", () => {
  assert.deepEqual(presetRange("12m", "2024-05", "2026-03"), { from: "2025-04", to: "2026-03" });
  assert.deepEqual(presetRange("ytd", "2024-05", "2026-03"), { from: "2026-01", to: "2026-03" });
  assert.deepEqual(presetRange("last-year", "2024-05", "2026-03"), { from: "2025-01", to: "2025-12" });
  assert.deepEqual(presetRange("all", "2024-05", "2026-03"), { from: "2024-05", to: "2026-03" });
});

test("totals: income is kept apart, and returns reduce spending", () => {
  const t = totals(applyFilters(TXNS, all), "income");
  assert.deepEqual(t, { spent: 20750, shared: 15500, personal: 5250, income: 300000, count: 6 });
});

test("filters: person, kind, period and search", () => {
  assert.equal(applyFilters(TXNS, { ...all, person: "jordan" }).length, 1);
  assert.equal(applyFilters(TXNS, { ...all, kind: "shared" }).length, 4);
  assert.equal(applyFilters(TXNS, { ...all, from: "2026-02", to: "2026-02" }).length, 3);
  assert.equal(applyFilters(TXNS, { ...all, query: "bluebell" }).length, 2);
  assert.equal(applyFilters(TXNS, { ...all, query: "SPRINGFIELD" }).length, TXNS.length, "matches the raw vendor too");
  assert.equal(applyFilters(TXNS, { ...all, query: "$40" }).length, 1, "an amount");
  assert.equal(applyFilters(TXNS, { ...all, query: "groc" }).length, 4, "a category");
});

test("a facet left out of its own filter still shows its other values", () => {
  const f = { ...all, month: "2026-02", category: "dining" };
  assert.equal(applyFilters(TXNS, f).length, 1);
  assert.equal(applyFilters(TXNS, f, "month").length, 2, "the chart sees every month of dining");
  assert.equal(applyFilters(TXNS, f, "category").length, 3, "the category table sees all of February");
});

test("byMonth: shared and personal per month, empty months included, income left out", () => {
  const rows = byMonth(TXNS, monthRange("2025-12", "2026-03"), "income");
  assert.deepEqual(rows, [
    { month: "2025-12", shared: 0, personal: 0 },
    { month: "2026-01", shared: 8000, personal: 1250 },
    { month: "2026-02", shared: 5000, personal: 4000 },
    { month: "2026-03", shared: 2500, personal: 0 },
  ]);
});

test("byCategory: biggest first, with shares and a per-month series", () => {
  const rows = byCategory(TXNS, monthRange("2026-01", "2026-03"), "income");
  assert.deepEqual(
    rows.map((r) => [r.category, r.total, r.count, r.perMonth]),
    [
      ["groceries", 15500, 4, [8000, 5000, 2500]],
      ["dining", 5250, 2, [1250, 4000, 0]],
    ],
  );
  assert.ok(Math.abs(rows[0].share + rows[1].share - 1) < 1e-9);
});

test("byMerchant: totals, visits, most-used category and last visit", () => {
  const rows = byMerchant(TXNS, "income");
  assert.deepEqual(rows[0], {
    merchant: "Freshway",
    total: 13000,
    count: 3,
    category: "groceries",
    last: "2026-02-03",
  });
  assert.equal(
    rows.find((r) => r.merchant === "Acme Corp"),
    undefined,
    "income isn't a merchant you spend at",
  );
});

test("previous period: same length just before, or the month before one picked month", () => {
  const p = previousPeriod(all);
  assert.deepEqual([p.from, p.to], ["2025-10", "2025-12"]);
  const m = previousPeriod({ ...all, month: "2026-03" });
  assert.deepEqual([m.from, m.to, m.month], ["2026-02", "2026-02", null]);
  assert.equal(change(150, 100), 0.5);
  assert.equal(change(100, 0), null);
});

test("similar names: same start once case, spaces and & are ignored", () => {
  const all = [
    "Owl & Turtle Bookshop",
    "Owl and Turtle Bookshop a",
    "OWL & TURTLE BOOKSHOP CAF",
    "Owlet Toys",
    "Ox",
    "Freshway",
  ];
  assert.deepEqual(similarNames("Owl & Turtle Bookshop", all), [
    "OWL & TURTLE BOOKSHOP CAF",
    "Owl and Turtle Bookshop a",
  ]);
  assert.deepEqual(similarNames("Ox", all), [], "too short to guess");
  assert.deepEqual(similarNames("Freshway", all), []);
});
