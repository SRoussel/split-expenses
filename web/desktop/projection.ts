import { REAL_RETURNS } from "./history";

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
  /** The share in stocks now (0 to 1); the rest is cash and bonds. */
  stockShare: number;
  /** The share in stocks from retirement on. It moves there a little each year until then. */
  stockLater: number;
  /** Income tax on what's taken out in retirement (0.12 for 12%), on the part that comes from pre-tax accounts. */
  taxRate: number;
  /** The share of savings in pre-tax accounts (a 401k or traditional IRA), whose withdrawals are taxed. */
  pretaxShare: number;
  /** Added each month until retirement. */
  saveMonthly: number;
  /** Spent each month from retirement on. */
  spendMonthly: number;
  /** Social Security, a pension or the like, each month from `otherIncomeAge`. */
  otherIncomeMonthly: number;
  otherIncomeAge: number;
  /**
   * "history" replays real years since 1928, in runs of a few years at a time so long bad
   * stretches (the 1930s, the 1970s, 2000 to 2009) come through. "smooth" draws each year from
   * a bell curve with the return and swing below.
   */
  market: "history" | "smooth";
  /** With history: how much less than history to expect from stocks each year (0.02 for 2%). */
  historyCut: number;
  /** With smooth: a year's return after inflation, and how much it swings from year to year. */
  stockReturn: number;
  stockSwing: number;
  cashReturn: number;
}

/**
 * On average, how many years in a row are replayed from history before jumping to another point
 * in it. The length of each stretch is random (a "stationary bootstrap"), so some long slumps
 * stay whole and no stretch length is special.
 */
const STRETCH = 8;

export interface Projection {
  ages: number[];
  /** Per age, the balance at the start of that year at the 10th, 25th, 50th, 75th and 90th percentiles. */
  low: number[];
  lowMid: number[];
  mid: number[];
  highMid: number[];
  high: number[];
  /** A few single futures, year by year, from low to high by where they end: real paths zigzag. */
  examples: number[][];
  /** The share of outcomes where the money lasts through `endAge`. */
  lasts: number;
  /** In the worst 1 in 10 outcomes, the age the money runs out; null when it lasts even then. */
  worstRunsOut: number | null;
}

/** A small seeded random number generator (0 to 1), so the same plan always draws the same picture. */
function uniform(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A normally distributed draw (Box-Muller). */
function random(seed: number) {
  const next = uniform(seed);
  return () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
}

/** Stocks' yearly return after inflation over the whole history, compounded. */
export function historyAverage(): number {
  const growth = REAL_RETURNS.reduce((g, [, s]) => g * (1 + s), 1);
  return growth ** (1 / REAL_RETURNS.length) - 1;
}

/** One year's money in or out at a given age, in cents. Withdrawals include the tax on them. */
export function flow(p: Plan, age: number): number {
  if (age < p.retireAge) return p.saveMonthly * 12;
  const other = age >= p.otherIncomeAge ? p.otherIncomeMonthly : 0;
  const need = (p.spendMonthly - other) * 12;
  if (need <= 0) return -need;
  // To spend `need` after tax, take out more from the part that's taxed.
  return -need / (1 - Math.min(0.9, p.taxRate * p.pretaxShare));
}

/** The share in stocks at a given age: from today's mix, a step each year, to the retirement mix. */
export function stocksAt(p: Plan, age: number): number {
  if (age >= p.retireAge || p.retireAge <= p.age) return p.stockLater;
  return p.stockShare + ((p.stockLater - p.stockShare) * (age - p.age)) / (p.retireAge - p.age);
}

/** Every run's balance at the start of each year: runs × years, row by row. */
function runAll(p: Plan, runs: number, seed: number) {
  const years = Math.max(1, p.endAge - p.age + 1);
  const out = new Float64Array(runs * years);
  const runsOut = new Float64Array(runs).fill(Infinity);
  const draw = random(seed);
  const pickYear = uniform(seed + 7);
  const flows = Array.from({ length: years }, (_, y) => flow(p, p.age + y));
  const mix = Array.from({ length: years }, (_, y) => stocksAt(p, p.age + y));
  let lasted = 0;
  for (let r = 0; r < runs; r++) {
    let bal = p.start;
    let at = 0;
    for (let y = 0; y < years; y++) {
      out[r * years + y] = bal;
      let stocks: number;
      let cash: number;
      if (p.market === "history") {
        // A new stretch: the first year, then on average every STRETCH years. Otherwise the next year.
        if (y === 0 || pickYear() < 1 / STRETCH) at = Math.floor(pickYear() * REAL_RETURNS.length);
        else at = (at + 1) % REAL_RETURNS.length;
        const [, s, bills, bonds] = REAL_RETURNS[at];
        stocks = s - p.historyCut;
        cash = (bills + bonds) / 2; // cash and bonds: half T-bills, half 10-year Treasuries
      } else {
        stocks = p.stockReturn + p.stockSwing * draw();
        cash = p.cashReturn;
      }
      const ret = Math.max(-0.9, mix[y] * stocks + (1 - mix[y]) * cash);
      bal = bal * (1 + ret) + flows[y];
      // Ran out in retirement. (Before it, a negative start just means debt is still being paid off.)
      if (bal <= 0 && p.age + y >= p.retireAge) {
        if (runsOut[r] === Infinity) runsOut[r] = p.age + y;
        bal = 0;
      }
    }
    if (runsOut[r] === Infinity) lasted++;
  }
  return { out, years, lasted, runsOut };
}

const pick = (sorted: Float64Array, q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/** How many futures each projection runs. */
export const RUNS = 2000;

export function project(p: Plan, runs = RUNS, seed = 1): Projection {
  const { out, years, lasted, runsOut } = runAll(p, runs, seed);
  const worst = pick(runsOut.sort(), 0.1);
  const ages: number[] = [];
  const bands: number[][] = [[], [], [], [], []];
  const qs = [0.1, 0.25, 0.5, 0.75, 0.9];
  const column = new Float64Array(runs);
  for (let y = 0; y < years; y++) {
    for (let r = 0; r < runs; r++) column[r] = out[r * years + y];
    column.sort();
    ages.push(p.age + y);
    qs.forEach((q, i) => bands[i].push(pick(column, q)));
  }
  // Example futures: the runs that end at roughly the 15th, 40th, 65th and 90th percentiles.
  const byEnd = Array.from({ length: runs }, (_, r) => r).sort(
    (a, b) => out[a * years + years - 1] - out[b * years + years - 1],
  );
  const examples = [0.15, 0.4, 0.65, 0.9].map((q) => {
    const r = byEnd[Math.min(runs - 1, Math.floor(q * runs))];
    return Array.from(out.subarray(r * years, (r + 1) * years));
  });
  const [low, lowMid, mid, highMid, high] = bands;
  return {
    ages,
    low,
    lowMid,
    mid,
    highMid,
    high,
    examples,
    lasts: lasted / runs,
    worstRunsOut: Number.isFinite(worst) ? worst : null,
  };
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

/** A share of futures in words: "about 9 in 10", "about 49 in 50". Exact percentages would overstate it. */
export function odds(share: number): string {
  if (share >= 0.995) return "more than 99 in 100";
  if (share >= 0.985) return "about 49 in 50";
  if (share >= 0.945) return "about 19 in 20";
  if (share < 0.005) return "almost none of the";
  if (share < 0.05) return "fewer than 1 in 20";
  return `about ${Math.round(share * 10)} in 10`;
}
