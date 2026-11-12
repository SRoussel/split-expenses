import assert from "node:assert/strict";
import { test } from "node:test";
import { project, sustainableSpend, type Plan } from "./projection";

const plan: Plan = {
  age: 40,
  retireAge: 65,
  endAge: 95,
  start: 100_000_00,
  stockShare: 0.8,
  saveMonthly: 1_500_00,
  spendMonthly: 4_000_00,
  otherIncomeMonthly: 2_000_00,
  otherIncomeAge: 67,
  stockReturn: 0.05,
  stockSwing: 0.17,
  cashReturn: 0.005,
};

test("with no swings, a projection is plain compounding", () => {
  const p = project({ ...plan, stockSwing: 0, stockShare: 1, retireAge: 95, endAge: 42 }, 10);
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
  for (let i = 0; i < a.ages.length; i++) assert.ok(a.low[i] <= a.mid[i] && a.mid[i] <= a.high[i]);
  assert.ok(a.high[25] > a.low[25] * 2, "markets swing, so outcomes spread out");
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
