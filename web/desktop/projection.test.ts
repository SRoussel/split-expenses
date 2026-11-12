import assert from "node:assert/strict";
import { test } from "node:test";
import { REAL_RETURNS } from "./history";
import { flow, historyAverage, odds, project, stocksAt, sustainableSpend, type Plan } from "./projection";

const plan: Plan = {
  age: 40,
  retireAge: 65,
  endAge: 95,
  start: 100_000_00,
  stockShare: 0.8,
  stockLater: 0.8,
  taxRate: 0,
  pretaxShare: 0.6,
  saveMonthly: 1_500_00,
  spendMonthly: 4_000_00,
  otherIncomeMonthly: 2_000_00,
  otherIncomeAge: 67,
  market: "smooth",
  historyCut: 0,
  stockReturn: 0.05,
  stockSwing: 0.17,
  cashReturn: 0.005,
};

test("with no swings, a projection is plain compounding", () => {
  const p = project({ ...plan, stockSwing: 0, stockShare: 1, stockLater: 1, retireAge: 95, endAge: 42 }, 10);
  assert.deepEqual(p.ages, [40, 41, 42]);
  const y1 = 100_000_00 * 1.05 + 18_000_00;
  assert.equal(Math.round(p.mid[1]), Math.round(y1));
  assert.equal(Math.round(p.mid[2]), Math.round(y1 * 1.05 + 18_000_00));
  assert.equal(p.lasts, 1);
});

test("the band is ordered and the same plan draws the same picture", () => {
  const a = project(plan);
  const b = project(plan);
  assert.deepEqual(a.mid, b.mid);
  for (let i = 0; i < a.ages.length; i++) {
    const order = [a.low[i], a.lowMid[i], a.mid[i], a.highMid[i], a.high[i]];
    assert.deepEqual(
      order,
      [...order].sort((x, y) => x - y),
    );
  }
  assert.ok(a.high[25] > a.low[25] * 2, "markets swing, so outcomes spread out");
  assert.equal(a.examples.length, 4);
  assert.ok(a.examples.every((e) => e.length === a.ages.length && e[0] === plan.start));
  const ends = a.examples.map((e) => e[e.length - 1]);
  assert.deepEqual(
    ends,
    [...ends].sort((x, y) => x - y),
  );
});

test("spending more makes the money last less often", () => {
  const frugal = project({ ...plan, spendMonthly: 3_000_00 }).lasts;
  const lavish = project({ ...plan, spendMonthly: 9_000_00 }).lasts;
  assert.ok(frugal > lavish);
  assert.ok(frugal > 0.5 && lavish < 0.5);
});

test("sustainable spending lasts in 9 of 10 outcomes, and a bit more doesn't", () => {
  const spend = sustainableSpend(plan);
  assert.ok(spend > 2_000_00 && spend < 20_000_00, `got ${spend}`);
  assert.ok(project({ ...plan, spendMonthly: spend }, 1000).lasts >= 0.9);
  assert.ok(project({ ...plan, spendMonthly: spend + 500_00 }, 1000).lasts < 0.9);
});

test("nothing saved and nothing to spend from can't fund retirement spending", () => {
  assert.equal(sustainableSpend({ ...plan, start: 0, saveMonthly: 0, otherIncomeMonthly: 0 }), 0);
});

test("the stock share moves a step a year from now to retirement", () => {
  const p = { ...plan, stockShare: 0.9, stockLater: 0.5 };
  assert.equal(stocksAt(p, 40), 0.9);
  assert.ok(Math.abs(stocksAt(p, 52.5) - 0.7) < 1e-9);
  assert.equal(stocksAt(p, 65), 0.5);
  assert.equal(stocksAt(p, 80), 0.5);
});

test("taxes make withdrawals bigger, so the money lasts less often", () => {
  // $4,000 a month less $2,000 Social Security is $24,000 a year; 20% tax on 60% pre-tax money is 12%.
  assert.equal(Math.round(flow({ ...plan, taxRate: 0.2 }, 70)), Math.round(-24_000_00 / 0.88));
  assert.equal(flow({ ...plan, taxRate: 0.2 }, 50), 18_000_00, "saving isn't taxed here");
  const taxed = project({ ...plan, spendMonthly: 6_000_00, taxRate: 0.2 }).lasts;
  const untaxed = project({ ...plan, spendMonthly: 6_000_00 }).lasts;
  assert.ok(taxed < untaxed);
});

test("the worst 1 in 10 says when the money runs out, or null when it lasts", () => {
  const tight = project({ ...plan, spendMonthly: 9_000_00 });
  assert.ok(tight.worstRunsOut !== null && tight.worstRunsOut >= 65 && tight.worstRunsOut < 95);
  assert.equal(project({ ...plan, spendMonthly: 2_000_00 }).worstRunsOut, null);
});

test("the history table runs year by year, and its average is about what's published", () => {
  REAL_RETURNS.forEach(([year], i) => assert.equal(year, REAL_RETURNS[0][0] + i));
  const avg = historyAverage();
  assert.ok(avg > 0.06 && avg < 0.075, `got ${avg}`);
});

test("replaying history: a cut lowers the middle outcome, and the picture repeats", () => {
  const history: Plan = { ...plan, market: "history" };
  const a = project(history);
  assert.deepEqual(a.mid, project(history).mid);
  assert.ok(project({ ...history, historyCut: 0.02 }).mid[25] < a.mid[25]);
  for (let i = 0; i < a.ages.length; i++) assert.ok(a.low[i] <= a.mid[i] && a.mid[i] <= a.high[i]);
});

test("with only cash and bonds, history keeps pace with inflation, roughly", () => {
  const p = project({ ...plan, market: "history", stockShare: 0, stockLater: 0, saveMonthly: 0, retireAge: 95 });
  // Half bills, half bonds averaged about 1% a year after inflation: 55 years shouldn't triple or halve it.
  assert.ok(p.mid[p.mid.length - 1] > plan.start * 0.6 && p.mid[p.mid.length - 1] < plan.start * 3);
});

test("history stretches run in order for a while, then jump", () => {
  // With no saving and all stocks, each year's growth reveals which historical year was used.
  const p: Plan = {
    ...plan,
    market: "history",
    stockShare: 1,
    stockLater: 1,
    saveMonthly: 0,
    retireAge: 200,
    endAge: 139,
  };
  const r = project(p, 1);
  const path = r.examples[0];
  const years = path.slice(1).map((b, i) => {
    const growth = b / path[i] - 1;
    return REAL_RETURNS.findIndex(([, s]) => Math.abs(s - growth) < 1e-9);
  });
  assert.ok(
    years.every((i) => i >= 0),
    "every year comes from the table",
  );
  const jumps = years.slice(1).filter((y, i) => y !== (years[i] + 1) % REAL_RETURNS.length).length;
  // 99 steps with a 1 in 8 chance of a jump each: expect about 12, never none or most.
  assert.ok(jumps >= 4 && jumps <= 25, `got ${jumps} jumps`);
});

test("odds read as words, not overly exact percentages", () => {
  assert.equal(odds(1), "more than 99 in 100");
  assert.equal(odds(0.98), "about 19 in 20");
  assert.equal(odds(0.99), "about 49 in 50");
  assert.equal(odds(0.93), "about 9 in 10");
  assert.equal(odds(0.5), "about 5 in 10");
  assert.equal(odds(0.02), "fewer than 1 in 20");
});
