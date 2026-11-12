import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetLines, lastSettled, netWorthLine } from "./home.ts";
import { setRedacted } from "./redact.ts";
import type { Entry } from "./types.ts";

const A = "alex";
let n = 0;
function entry(p: Partial<Entry>): Entry {
  n++;
  return {
    id: `e${n}`,
    household_id: "h",
    kind: "expense",
    entry_date: "2026-01-10",
    name: `Entry ${n}`,
    amount_cents: 10000,
    payer_id: A,
    payer_share_pct: 50,
    owed_cents: 5000,
    created_by: A,
    created_at: "2026-01-10T00:00:00Z",
    voided_at: null,
    voided_by: null,
    replaced_by: null,
    recurring_id: null,
    occurrence_date: null,
    category: null,
    ...p,
  };
}

test("last settled: the latest payment that isn't voided, in days", () => {
  const entries = [
    entry({ kind: "settlement", entry_date: "2026-03-01" }),
    entry({ kind: "settlement", entry_date: "2026-03-20", voided_at: "2026-03-21T00:00:00Z" }),
    entry({ kind: "expense", entry_date: "2026-03-25" }),
    entry({ kind: "settlement", entry_date: "2026-02-10" }),
  ];
  assert.deepEqual(lastSettled(entries, "2026-03-31"), { date: "2026-03-01", daysAgo: 30 });
  assert.deepEqual(lastSettled(entries, "2026-03-01"), { date: "2026-03-01", daysAgo: 0 });
  assert.equal(lastSettled([entry({})], "2026-03-31"), null);
});

test("budget lines: over budget first, then by size, the rest added up, income left out", () => {
  const { lines, other } = budgetLines({ groceries: 42000, dining: 9000, gift: 2500, income: 500000 }, [
    { category: "dining", cents: 20000 },
    { category: "groceries", cents: 80000 },
    { category: "travel", cents: 30000 },
    { category: "gift", cents: 2000 },
  ]);
  assert.deepEqual(lines, [
    { category: "gift", budget: 2000, spent: 2500 },
    { category: "groceries", budget: 80000, spent: 42000 },
    { category: "travel", budget: 30000, spent: 0 },
    { category: "dining", budget: 20000, spent: 9000 },
  ]);
  assert.equal(other, 0);
});

test("net worth in a sentence: the change from the month before, and negative totals keep their sign", () => {
  const nw = { month: "2026-10", cents: 25240000, previous_month: "2026-09", previous_cents: 24830000 };
  assert.equal(netWorthLine(nw), "Net worth $252,400.00 at the end of October, up $4,100.00 from September.");
  assert.equal(
    netWorthLine({ ...nw, previous_cents: 25300000 }),
    "Net worth $252,400.00 at the end of October, down $600.00 from September.",
  );
  assert.equal(
    netWorthLine({ ...nw, previous_cents: nw.cents }),
    "Net worth $252,400.00 at the end of October, the same as September.",
  );
  assert.equal(
    netWorthLine({ month: "2026-01", cents: -120050, previous_month: null, previous_cents: null }),
    "Net worth −$1,200.50 at the end of January.",
  );
  setRedacted(true);
  assert.doesNotMatch(netWorthLine(nw), /\d{2},\d{3}/, "Redact amounts hides it");
  setRedacted(false);
});
