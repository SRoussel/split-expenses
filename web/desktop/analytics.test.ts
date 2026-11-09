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
  whatChanged,
  yearInReview,
  findRecurring,
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

test("what changed: a month against the average of the months before", () => {
  const rows = [
    // Groceries: $100 a month for three months, then $160.
    txn("2026-01-10", 10000, "Freshway", "groceries"),
    txn("2026-02-10", 10000, "Freshway", "groceries"),
    txn("2026-03-10", 10000, "Freshway", "groceries"),
    txn("2026-04-10", 16000, "Freshway", "groceries"),
    // A gym every month until April.
    txn("2026-01-02", 5000, "Gym", "hobbies"),
    txn("2026-02-02", 5000, "Gym", "hobbies"),
    txn("2026-03-02", 5000, "Gym", "hobbies"),
    // Somewhere new in April.
    txn("2026-04-20", 2500, "New Place", "dining"),
    txn("2026-04-21", 1500, "New Place", "dining"),
    txn("2026-04-01", 999999, "Payroll", "income"),
  ];
  const c = whatChanged(rows, "2026-04", "income");
  assert.deepEqual(c.compared, ["2026-01", "2026-02", "2026-03"], "only months with data count");
  assert.equal(c.now, 20000);
  assert.equal(c.usual, 15000);
  assert.deepEqual(c.categories[0], { key: "groceries", now: 16000, usual: 10000, diff: 6000 });
  assert.deepEqual(
    c.categories.map((x) => x.key),
    ["groceries", "hobbies", "dining"],
  );
  assert.deepEqual(c.fresh, [{ merchant: "New Place", category: "dining", total: 4000, count: 2 }]);
  assert.deepEqual(c.missing, [{ merchant: "Gym", usual: 5000, last: "2026-03-02" }]);
  assert.equal(whatChanged(rows, "2026-01", "income").compared.length, 0, "nothing before the first month");
});

test("recurring: steady pace and amount, price changes, and ones that stopped", () => {
  const monthly = (merchant: string, amounts: number[], start = 1, category = "entertainment") =>
    amounts.map((c, i) => txn(`2026-${String(start + i).padStart(2, "0")}-05`, c, merchant, category));
  const rows = [
    ...monthly("Streamy", [1599, 1599, 1599, 1799, 1799, 1799]), // went up in April
    ...monthly("Old App", [499, 499, 499], 1), // stopped after March
    ...monthly("Gym", [5000, 5000, 5000, 5000, 5000, 5000], 1, "hobbies"),
    txn("2025-06-01", 9900, "Annual Thing", "other"),
    txn("2026-06-02", 9900, "Annual Thing", "other"),
    // Two plans at one store, and a one-off charge at the gym.
    // Two plans at one store: $2.99 on the 5th and $9.99 on the 20th, every month.
    ...[1, 2, 3, 4, 5, 6].flatMap((mo) => [
      txn(`2026-0${mo}-05`, 299, "App Store", "entertainment"),
      txn(`2026-0${mo}-20`, 999, "App Store", "entertainment"),
    ]),
    txn("2025-12-28", 1898, "Gym", "hobbies"),
    // Electricity: every month, never the same amount.
    ...monthly("Power Co", [8812, 6420, 5133, 7790, 11020, 9375], 1, "utilities"),
    // The same grocery bill twice, by chance, ten months apart.
    txn("2025-08-03", 7393, "Corner Shop", "groceries"),
    txn("2026-06-01", 7393, "Corner Shop", "groceries"),
    // Groceries: often, but not steady.
    ...["01-03", "01-09", "01-20", "02-02", "02-05", "02-25", "03-14"].map((d, i) =>
      txn(`2026-${d}`, 3000 + i * 2500, "Freshway", "groceries"),
    ),
  ];
  const found = findRecurring(rows, "income", "2026-06-20");
  const by = new Map(found.map((r) => [r.merchant, r]));
  assert.equal(by.has("Freshway"), false, "irregular shopping isn't a subscription");
  assert.equal(by.has("Corner Shop"), false, "two equal bills months apart aren't a yearly charge");
  assert.deepEqual(
    found.map((r) => r.merchant),
    ["Power Co", "Gym", "Streamy", "App Store", "Annual Thing", "App Store", "Old App"],
    "active first, biggest yearly cost first",
  );

  const s = by.get("Streamy")!;
  assert.equal(s.cadence, "monthly");
  assert.equal(s.amount, 1799);
  assert.deepEqual(s.change, { from: 1599, since: "2026-04-05" });
  assert.equal(s.perYear, Math.round((1799 * 365.25) / 30.44));
  assert.equal(s.next, "2026-07-05");
  assert.equal(s.active, true);

  assert.equal(by.get("Old App")!.active, false);
  assert.equal(by.get("Gym")!.change, null, "a single odd charge isn't a price change");
  assert.equal(by.get("Annual Thing")!.cadence, "yearly");
  const power = by.get("Power Co")!;
  assert.equal(power.varies, true);
  assert.equal(power.amount, Math.round((7790 + 11020 + 9375) / 3), "the average of the last three bills");
  assert.equal(by.get("Streamy")!.varies, false);
  assert.deepEqual(
    found.filter((r) => r.merchant === "App Store").map((r) => [r.plan, r.cadence, r.active]),
    [
      [999, "monthly", true],
      [299, "monthly", true],
    ],
    "each plan at a store with several is found on its own",
  );
});

test("year in review: totals, the year before when it's covered, records and new places", () => {
  const rows = [
    // 2025: two months of data (Nov, Dec).
    txn("2025-11-03", 4000, "Freshway", "groceries", "shared"),
    txn("2025-12-03", 6000, "Freshway", "groceries", "shared"),
    // 2026: Jan to Mar, and the same months aren't in the files for 2025.
    txn("2026-01-03", 5000, "Freshway", "groceries", "shared"),
    txn("2026-01-15", 300000, "Payroll", "income"),
    txn("2026-02-10", 120000, "Skyline Air", "travel"),
    txn("2026-02-11", 900, "Cafe", "dining"),
    txn("2026-02-12", 900, "Cafe", "dining"),
    txn("2026-03-03", 7000, "Freshway", "groceries", "shared"),
    txn("2026-03-12", 900, "Cafe", "dining"),
  ];
  const withRent = [...rows, txn("2026-03-01", 185000, "Landlord", "housing", "shared")];
  assert.equal(yearInReview(withRent, "2026", "income").biggest?.merchant, "Skyline Air", "rent isn't a purchase");
  const r = yearInReview(rows, "2026", "income");
  assert.deepEqual(r.months, ["2026-01", "2026-02", "2026-03"]);
  assert.deepEqual(r.totals, { spent: 134700, shared: 12000, personal: 122700, income: 300000, count: 6 });
  assert.equal(r.previous, null, "Jan to Mar 2025 aren't in the files");
  assert.equal(r.categories[0].before, null);
  assert.equal(r.biggest?.merchant, "Skyline Air");
  assert.equal(r.mostVisited?.merchant, "Cafe");
  assert.equal(r.busiest?.month, "2026-02");
  assert.equal(r.quietest?.month, "2026-01");
  assert.deepEqual(
    r.fresh.map((m) => m.merchant),
    ["Skyline Air", "Cafe"],
    "Freshway was already visited in 2025",
  );

  // With the year before covered, categories compare against it.
  const later = yearInReview(
    [
      ...rows,
      txn("2027-01-03", 9000, "Freshway", "groceries", "shared"),
      txn("2027-02-01", 100, "Cafe", "dining"),
      txn("2027-03-01", 100, "Cafe", "dining"),
    ],
    "2027",
    "income",
  );
  assert.deepEqual(later.previous, { spent: 134700, shared: 12000, personal: 122700, income: 300000, count: 6 });
  assert.deepEqual(
    later.categories.map((c) => [c.category, c.total, c.before]),
    [
      ["groceries", 9000, 12000],
      ["dining", 200, 2700],
    ],
  );
});
