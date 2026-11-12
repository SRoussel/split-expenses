// Where savings could go: years of saving until retirement, then years of spending from it,
// run a couple of thousand times with the market up some years and down others. Everything is
// in today's dollars, so returns are after inflation. Amounts are in cents.

export interface Plan {
  age: number;
  retireAge: number;
  /** How long the money has to last. */
  endAge: number;
  /** What you have now to invest and spend from: cash, investments and retirement, less debts other than a mortgage. */
  start: number;
  /** The share in stocks (0 to 1); the rest is cash and bonds. */
  stockShare: number;
  /** Added each month until retirement. */
  saveMonthly: number;
  /** Spent each month from retirement on. */
  spendMonthly: number;
  /** Social Security, a pension or the like, each month from `otherIncomeAge`. */
  otherIncomeMonthly: number;
  otherIncomeAge: number;
  /** A year's return after inflation, and how much it swings from year to year (both as 0.05 for 5%). */
  stockReturn: number;
  stockSwing: number;
  cashReturn: number;
}

export interface Projection {
  ages: number[];
  /** Per age: the balance at the start of that year in 1 in 10, half, and 9 in 10 of the outcomes. */
  low: number[];
  mid: number[];
  high: number[];
  /** The share of outcomes where the money lasts through `endAge`. */
  lasts: number;
}

/** A small seeded random number generator, so the same plan always draws the same picture. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // A normally distributed draw (Box-Muller).
  return () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
}

/** One year's money in or out at a given age, in cents. */
function flow(p: Plan, age: number): number {
  if (age < p.retireAge) return p.saveMonthly * 12;
  const other = age >= p.otherIncomeAge ? p.otherIncomeMonthly : 0;
  return (other - p.spendMonthly) * 12;
}

/** Every run's balance at the start of each year: runs × years, row by row. */
function runAll(p: Plan, runs: number, seed: number) {
  const years = Math.max(1, p.endAge - p.age + 1);
  const out = new Float64Array(runs * years);
  const draw = random(seed);
  let lasted = 0;
  for (let r = 0; r < runs; r++) {
    let bal = p.start;
    let broke = false;
    for (let y = 0; y < years; y++) {
      out[r * years + y] = bal;
      const stocks = p.stockReturn + p.stockSwing * draw();
      const ret = Math.max(-0.9, p.stockShare * stocks + (1 - p.stockShare) * p.cashReturn);
      bal = bal * (1 + ret) + flow(p, p.age + y);
      if (bal <= 0) {
        // Ran out in retirement. (Before it, a negative start just means debt is still being paid off.)
        if (p.age + y >= p.retireAge) {
          broke = true;
          bal = 0;
        }
      }
    }
    if (!broke) lasted++;
  }
  return { out, years, lasted };
}

const pick = (sorted: Float64Array, q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

export function project(p: Plan, runs = 2000, seed = 1): Projection {
  const { out, years, lasted } = runAll(p, runs, seed);
  const ages: number[] = [];
  const low: number[] = [];
  const mid: number[] = [];
  const high: number[] = [];
  const column = new Float64Array(runs);
  for (let y = 0; y < years; y++) {
    for (let r = 0; r < runs; r++) column[r] = out[r * years + y];
    column.sort();
    ages.push(p.age + y);
    low.push(pick(column, 0.1));
    mid.push(pick(column, 0.5));
    high.push(pick(column, 0.9));
  }
  return { ages, low, mid, high, lasts: lasted / runs };
}

/**
 * The most you could spend each month in retirement and still have money left at `endAge`
 * in `odds` of the outcomes. Same random draws each try, so more spending never does better.
 */
export function sustainableSpend(p: Plan, odds = 0.9, runs = 1000, seed = 1): number {
  const lasts = (spend: number) => runAll({ ...p, spendMonthly: spend }, runs, seed).lasted / runs >= odds;
  if (!lasts(0)) return 0;
  let lo = 0;
  let hi = Math.max(100_000, Math.abs(p.start) / 12, p.saveMonthly * 4 + p.otherIncomeMonthly * 2);
  while (lasts(hi) && hi < 1e12) hi *= 2;
  for (let i = 0; i < 30 && hi - lo > 1000; i++) {
    const m = (lo + hi) / 2;
    if (lasts(m)) lo = m;
    else hi = m;
  }
  return Math.floor(lo / 1000) * 1000; // to the $10
}
