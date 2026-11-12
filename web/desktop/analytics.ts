// The numbers behind the desktop page. Everything is worked out here, in the browser,
// from the full list of transactions that split-insights sends; nothing is precomputed.

export type Kind = "shared" | "personal";

export interface Txn {
  id: string;
  date: string; // YYYY-MM-DD
  cents: number; // positive = spent (or income received); negative = a return
  vendor: string; // as the bank wrote it
  auto: string; // the cleaned-up name, before any rename
  merchant: string; // what to call it: your rename, or the cleaned-up name
  original?: { category: string; kind: Kind }; // how the statement had it, when you've refiled it here
  category: string;
  kind: Kind;
  person: string;
  source: string;
  added?: boolean; // typed in on this page, not from a statement
  share?: number; // a shared one at its own split: the share of whoever paid (whoever's statement it is), in percent
  series?: string; // typed in with "Repeat every month": the others added with it share this
}

export interface Data {
  transactions: Txn[];
  sources: { dir: string; person: string; rows: number; kept: number; skipped: number; updated: string }[];
  /** Summaries already made for the phone app: archived by `finish`, or exported from this page. Newest first. */
  sent: { person: string; name: string; start: string; end: string; from: string }[];
  categories: string[];
  income: string;
  me: string;
  /** Monthly budgets for the household, in cents, by category. */
  budgets?: Record<string, number>;
}

export interface Filters {
  from: string; // YYYY-MM, inclusive
  to: string;
  person: string | null;
  kind: Kind | null;
  category: string | null;
  merchant: string | null;
  month: string | null;
  query: string;
}

export type Facet = "month" | "category" | "merchant";

export const monthOf = (date: string) => date.slice(0, 7);

/** Every month from `from` to `to`, inclusive. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const i = y * 12 + (m - 1) + by;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

export type Preset = "12m" | "ytd" | "last-year" | "all";

/** The months a preset covers, ending at the latest month with data. */
export function presetRange(preset: Preset, first: string, last: string): { from: string; to: string } {
  const year = Number(last.slice(0, 4));
  switch (preset) {
    case "12m":
      return { from: shiftMonth(last, -11), to: last };
    case "ytd":
      return { from: `${year}-01`, to: last };
    case "last-year":
      return { from: `${year - 1}-01`, to: `${year - 1}-12` };
    case "all":
      return { from: first, to: last };
  }
}

function matchesQuery(t: Txn, q: string): boolean {
  if (!q) return true;
  const amount = Number(q.replace(/[$,]/g, ""));
  if (q.trim() !== "" && Number.isFinite(amount) && /\d/.test(q)) {
    return Math.abs(t.cents) === Math.round(amount * 100) || t.date.includes(q.trim());
  }
  const needle = q.toLowerCase();
  return (
    t.merchant.toLowerCase().includes(needle) || t.vendor.toLowerCase().includes(needle) || t.category.includes(needle)
  );
}

/**
 * The transactions the filters allow. `except` leaves one facet out, so a view of that
 * facet still shows its other values (the month chart shows every month even with one
 * month selected, and highlights it).
 */
export function applyFilters(txns: Txn[], f: Filters, except?: Facet): Txn[] {
  return txns.filter((t) => {
    const month = monthOf(t.date);
    if (month < f.from || month > f.to) return false;
    if (f.person && t.person !== f.person) return false;
    if (f.kind && t.kind !== f.kind) return false;
    if (except !== "month" && f.month && month !== f.month) return false;
    if (except !== "category" && f.category && t.category !== f.category) return false;
    if (except !== "merchant" && f.merchant && t.merchant !== f.merchant) return false;
    return matchesQuery(t, f.query);
  });
}

export const isSpending = (t: Txn, income: string) => t.category !== income;

export interface MonthRow {
  month: string;
  shared: number;
  personal: number;
}

/** Spending per month, split into shared and personal. Returns pull a month down. */
export function byMonth(txns: Txn[], months: string[], income: string): MonthRow[] {
  const rows = new Map(months.map((m) => [m, { month: m, shared: 0, personal: 0 }]));
  for (const t of txns) {
    if (!isSpending(t, income)) continue;
    const row = rows.get(monthOf(t.date));
    if (row) row[t.kind] += t.cents;
  }
  return [...rows.values()];
}

export interface CategoryRow {
  category: string;
  total: number;
  count: number;
  share: number; // of all spending in view, 0..1
  perMonth: number[]; // aligned with the months passed in
}

export function byCategory(txns: Txn[], months: string[], income: string): CategoryRow[] {
  const index = new Map(months.map((m, i) => [m, i]));
  const rows = new Map<string, CategoryRow>();
  let all = 0;
  for (const t of txns) {
    if (!isSpending(t, income)) continue;
    let row = rows.get(t.category);
    if (!row) {
      row = { category: t.category, total: 0, count: 0, share: 0, perMonth: months.map(() => 0) };
      rows.set(t.category, row);
    }
    row.total += t.cents;
    row.count++;
    const i = index.get(monthOf(t.date));
    if (i !== undefined) row.perMonth[i] += t.cents;
    all += t.cents;
  }
  const out = [...rows.values()].sort((a, b) => b.total - a.total);
  for (const r of out) r.share = all > 0 ? r.total / all : 0;
  return out;
}

export interface MerchantRow {
  merchant: string;
  total: number;
  count: number;
  category: string; // the one it's filed under most often
  last: string;
}

export function byMerchant(txns: Txn[], income: string): MerchantRow[] {
  const rows = new Map<string, MerchantRow & { cats: Map<string, number> }>();
  for (const t of txns) {
    if (!isSpending(t, income)) continue;
    let row = rows.get(t.merchant);
    if (!row) {
      row = { merchant: t.merchant, total: 0, count: 0, category: t.category, last: t.date, cats: new Map() };
      rows.set(t.merchant, row);
    }
    row.total += t.cents;
    row.count++;
    if (t.date > row.last) row.last = t.date;
    row.cats.set(t.category, (row.cats.get(t.category) ?? 0) + 1);
  }
  return [...rows.values()]
    .map(({ cats, ...row }) => ({ ...row, category: [...cats].sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.total - a.total);
}

export interface Totals {
  spent: number;
  shared: number;
  personal: number;
  income: number;
  count: number;
}

export function totals(txns: Txn[], income: string): Totals {
  const out = { spent: 0, shared: 0, personal: 0, income: 0, count: 0 };
  for (const t of txns) {
    if (t.category === income) {
      out.income += t.cents;
      continue;
    }
    out.spent += t.cents;
    out[t.kind] += t.cents;
    out.count++;
  }
  return out;
}

/** The same filters over the period just before, for "vs previous" figures. One month picked: the month before. */
export function previousPeriod(f: Filters): Filters {
  if (f.month) {
    const prev = shiftMonth(f.month, -1);
    return { ...f, from: prev, to: prev, month: null };
  }
  const span = monthRange(f.from, f.to).length;
  return { ...f, from: shiftMonth(f.from, -span), to: shiftMonth(f.from, -1), month: null };
}

/** Relative change, or null when there's nothing to compare against. */
export function change(now: number, before: number): number | null {
  return before > 0 ? (now - before) / before : null;
}

/** "Owl and Turtle" and "OWL & TURTLE" look the same to this. */
const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");

/** Other merchants whose names start the same way: likely the same place spelled differently. */
export function similarNames(name: string, all: Iterable<string>): string[] {
  const a = squash(name);
  const out: string[] = [];
  for (const other of all) {
    if (other === name) continue;
    const b = squash(other);
    const shorter = Math.min(a.length, b.length);
    if (shorter < 4) continue;
    let common = 0;
    while (common < shorter && a[common] === b[common]) common++;
    if (common >= Math.min(8, shorter)) out.push(other);
  }
  return out.sort().slice(0, 6);
}

// ---------------------------------------------------------------------------
// What changed: one month against the months before it
// ---------------------------------------------------------------------------

export interface Mover {
  key: string; // a category or merchant
  now: number;
  usual: number; // average over the months compared with
  diff: number;
}

export interface Changes {
  month: string;
  compared: string[]; // the months "usual" averages over (only ones with data)
  now: number;
  usual: number;
  categories: Mover[];
  merchants: Mover[];
  /** First time ever at this merchant. */
  fresh: { merchant: string; category: string; total: number; count: number }[];
  /** At this merchant most months, but not this one. */
  missing: { merchant: string; usual: number; last: string }[];
}

/** `month` against the average of up to `lookback` months before it, from the transactions given. */
export function whatChanged(txns: Txn[], month: string, income: string, lookback = 6): Changes {
  const spending = txns.filter((t) => isSpending(t, income));
  const first = spending.length ? spending.map((t) => monthOf(t.date)).sort()[0] : month;
  const compared = monthRange(shiftMonth(month, -lookback), shiftMonth(month, -1)).filter((m) => m >= first);
  const span = Math.max(1, compared.length);
  const inCompared = new Set(compared);

  const tally = (key: (t: Txn) => string) => {
    const now = new Map<string, number>();
    const before = new Map<string, number>();
    for (const t of spending) {
      const m = monthOf(t.date);
      if (m === month) now.set(key(t), (now.get(key(t)) ?? 0) + t.cents);
      else if (inCompared.has(m)) before.set(key(t), (before.get(key(t)) ?? 0) + t.cents);
    }
    const keys = new Set([...now.keys(), ...before.keys()]);
    return [...keys]
      .map((k) => {
        const n = now.get(k) ?? 0;
        const usual = compared.length ? Math.round((before.get(k) ?? 0) / span) : 0;
        return { key: k, now: n, usual, diff: n - usual };
      })
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.key.localeCompare(b.key));
  };

  const seenBefore = new Set(spending.filter((t) => monthOf(t.date) < month).map((t) => t.merchant));
  const fresh = byMerchant(
    spending.filter((t) => monthOf(t.date) === month && !seenBefore.has(t.merchant)),
    income,
  ).map(({ merchant, category, total, count }) => ({ merchant, category, total, count }));

  // "Most months": in at least two thirds of the months compared with (and at least 3 of them).
  const monthsAt = new Map<string, Set<string>>();
  const lastAt = new Map<string, string>();
  for (const t of spending) {
    const m = monthOf(t.date);
    if (!inCompared.has(m)) continue;
    if (!monthsAt.has(t.merchant)) monthsAt.set(t.merchant, new Set());
    monthsAt.get(t.merchant)!.add(m);
    if (t.date > (lastAt.get(t.merchant) ?? "")) lastAt.set(t.merchant, t.date);
  }
  const hereNow = new Set(spending.filter((t) => monthOf(t.date) === month).map((t) => t.merchant));
  const merchants = tally((t) => t.merchant);
  const usualOf = new Map(merchants.map((m) => [m.key, m.usual]));
  const missing = [...monthsAt]
    .filter(([m, months]) => !hereNow.has(m) && months.size >= Math.max(3, Math.ceil((compared.length * 2) / 3)))
    .map(([m]) => ({ merchant: m, usual: usualOf.get(m) ?? 0, last: lastAt.get(m)! }))
    .sort((a, b) => b.usual - a.usual);

  const categories = tally((t) => t.category);
  return {
    month,
    compared,
    now: categories.reduce((n, c) => n + c.now, 0),
    usual: categories.reduce((n, c) => n + c.usual, 0),
    categories,
    merchants,
    fresh,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Recurring charges: the same merchant, at a steady pace, for a steady amount
// ---------------------------------------------------------------------------

export type Cadence = "weekly" | "monthly" | "yearly";
const CADENCE_DAYS: Record<Cadence, number> = { weekly: 7, monthly: 30.44, yearly: 365.25 };
// How far a gap may stray from the cadence. Tight for yearly: two visits about a year apart
// for about the same amount happen by chance at shops you go to all the time.
const LEEWAY: Record<Cadence, number> = { weekly: 0.3, monthly: 0.3, yearly: 0.1 };

export interface Recurring {
  merchant: string;
  plan: number | null; // when a merchant has several plans: this one's amount
  varies: boolean; // a bill whose amount changes month to month (utilities, housing): amount is the recent average
  category: string;
  kind: Kind;
  cadence: Cadence;
  amount: number; // the latest charge
  perYear: number;
  count: number;
  first: string;
  last: string;
  next: string; // when the next one would come
  active: boolean; // a charge has come within about one and a half cycles
  change: { from: number; since: string } | null; // the price moved, and when
  charges: { date: string; cents: number }[];
}

const DAY = 86_400_000;
const toDay = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY;
const fromDay = (n: number) => new Date(Math.round(n) * DAY).toISOString().slice(0, 10);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= Math.max(Math.abs(b) * tolerance, 100);

/**
 * Charges that repeat. A merchant counts when its charges come at a steady pace (weekly,
 * monthly or yearly: most gaps within 30% of it) and for a steady amount (most within 20%
 * of the usual, or a dollar). Price changes show up as the latest run of equal charges
 * differing from the run before it. `today` is the latest date in the data.
 */
export function findRecurring(txns: Txn[], income: string, today: string): Recurring[] {
  const byMerchant = new Map<string, Txn[]>();
  for (const t of txns) {
    if (!isSpending(t, income) || t.cents <= 0) continue;
    if (!byMerchant.has(t.merchant)) byMerchant.set(t.merchant, []);
    byMerchant.get(t.merchant)!.push(t);
  }
  const out: Recurring[] = [];
  for (const [merchant, rows] of byMerchant) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const whole = detect(merchant, rows, today);
    if (whole) {
      out.push(whole);
      continue;
    }
    // Several plans at one merchant (Apple, Google): look at each repeating amount on its own.
    const byAmount = new Map<number, Txn[]>();
    for (const t of rows) {
      if (!byAmount.has(t.cents)) byAmount.set(t.cents, []);
      byAmount.get(t.cents)!.push(t);
    }
    for (const [cents, same] of byAmount) {
      const r = same.length >= 3 ? detect(merchant, same, today) : null;
      if (r) out.push({ ...r, plan: cents });
    }
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || b.perYear - a.perYear);
}

const BILLS = new Set(["utilities", "housing"]);

function detect(merchant: string, rows: Txn[], today: string): Recurring | null {
  if (rows.length < 2) return null;
  const days = rows.map((t) => toDay(t.date));
  const gaps = days.slice(1).map((d, i) => d - days[i]);
  const gap = median(gaps);
  const cadence = (["weekly", "monthly", "yearly"] as Cadence[]).find(
    (c) => Math.abs(gap - CADENCE_DAYS[c]) <= CADENCE_DAYS[c] * LEEWAY[c],
  );
  if (!cadence || rows.length < (cadence === "yearly" ? 2 : 3)) return null;
  const step = CADENCE_DAYS[cadence];
  const steady = gaps.filter((g) => Math.abs(g - step) <= step * LEEWAY[cadence]).length;
  if (steady < Math.ceil(gaps.length * 0.75)) return null;
  const most = <T>(xs: T[]) =>
    [...new Set(xs)].sort((a, b) => xs.filter((x) => x === b).length - xs.filter((x) => x === a).length)[0];
  const category = most(rows.map((t) => t.category));
  const usual = median(rows.map((t) => t.cents));
  const alike = rows.filter((t) => near(t.cents, usual, 0.2)).length;
  // Bills like electricity come every month for a different amount; still recurring.
  const varies = alike < Math.ceil(rows.length * 0.7);
  if (varies && !(cadence === "monthly" && rows.length >= 4 && BILLS.has(category))) return null;

  // The latest run of charges at (about) one amount, and the run before it. A price change
  // needs the old price charged at least twice, so a one-off extra charge doesn't count.
  const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, b * 0.01);
  const last = rows[rows.length - 1];
  let i = rows.length - 1;
  while (i > 0 && same(rows[i - 1].cents, last.cents)) i--;
  let change: Recurring["change"] = null;
  if (i > 0) {
    const before = rows[i - 1].cents;
    let j = i - 1;
    while (j > 0 && same(rows[j - 1].cents, before)) j--;
    if (i - j >= 2 && Math.abs(before - last.cents) >= Math.max(50, before * 0.02)) {
      change = { from: before, since: rows[i].date };
    }
  }

  const recent = rows.slice(-3);
  const amount = varies ? Math.round(recent.reduce((n, t) => n + t.cents, 0) / recent.length) : last.cents;
  return {
    merchant,
    plan: null,
    varies,
    category,
    kind: most(rows.map((t) => t.kind)),
    cadence,
    amount,
    perYear: Math.round((amount * 365.25) / step),
    count: rows.length,
    first: rows[0].date,
    last: last.date,
    next: fromDay(toDay(last.date) + step),
    active: toDay(today) - toDay(last.date) <= step * 1.5 + 5,
    change: varies ? null : change,
    charges: rows.map((t) => ({ date: t.date, cents: t.cents })),
  };
}

// ---------------------------------------------------------------------------
// Year in review
// ---------------------------------------------------------------------------

export interface YearReview {
  year: string;
  months: string[]; // the year's months the files cover
  totals: Totals;
  /** The same months a year earlier, when the files cover all of them. */
  previous: Totals | null;
  byMonth: MonthRow[];
  categories: (CategoryRow & { before: number | null })[];
  merchants: MerchantRow[];
  mostVisited: MerchantRow | null;
  biggest: Txn | null; // not counting rent and bills
  busiest: MonthRow | null;
  quietest: MonthRow | null;
  /** Places visited for the first time ever this year. */
  fresh: MerchantRow[];
  recurring: { count: number; perYear: number };
}

export function yearInReview(txns: Txn[], year: string, income: string): YearReview {
  const withData = new Set(txns.map((t) => monthOf(t.date)));
  const months = monthRange(`${year}-01`, `${year}-12`).filter((m) => withData.has(m));
  const inYear = txns.filter((t) => t.date.startsWith(year));
  const spending = inYear.filter((t) => isSpending(t, income));

  const earlier = months.map((m) => shiftMonth(m, -12));
  const covered = earlier.length > 0 && earlier.every((m) => withData.has(m));
  const earlierSet = new Set(earlier);
  const before = covered ? txns.filter((t) => earlierSet.has(monthOf(t.date))) : [];
  const beforeByCategory = new Map(byCategory(before, earlier, income).map((c) => [c.category, c.total]));

  const rows = byMonth(inYear, months, income);
  const ranked = [...rows].sort((a, b) => b.shared + b.personal - (a.shared + a.personal));
  const merchants = byMerchant(inYear, income);
  const seenBefore = new Set(txns.filter((t) => t.date < `${year}-01-01`).map((t) => t.merchant));
  const lastDay = inYear.reduce((d, t) => (t.date > d ? t.date : d), `${year}-01-01`);
  const recurring = findRecurring(
    txns.filter((t) => t.date <= lastDay),
    income,
    lastDay,
  ).filter((r) => r.active);

  return {
    year,
    months,
    totals: totals(inYear, income),
    previous: covered ? totals(before, income) : null,
    byMonth: rows,
    categories: byCategory(inYear, months, income).map((c) => ({
      ...c,
      before: covered ? (beforeByCategory.get(c.category) ?? 0) : null,
    })),
    merchants,
    mostVisited: [...merchants].sort((a, b) => b.count - a.count || b.total - a.total)[0] ?? null,
    // Rent and bills would win every time and say nothing, so they're left out here.
    biggest: spending
      .filter((t) => !BILLS.has(t.category))
      .reduce<Txn | null>((big, t) => (!big || t.cents > big.cents ? t : big), null),
    busiest: ranked[0] ?? null,
    quietest: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    fresh: merchants.filter((m) => !seenBefore.has(m.merchant)),
    recurring: { count: recurring.length, perYear: recurring.reduce((n, r) => n + r.perYear, 0) },
  };
}

// ---------------------------------------------------------------------------
// Net worth: accounts and their balances over time
// ---------------------------------------------------------------------------

export type Group = "cash" | "invested" | "retirement" | "property" | "debt";
export const ASSET_GROUPS: Group[] = ["cash", "invested", "retirement", "property"];

export interface Account {
  id: string;
  name: string;
  owner: string; // a person, or "joint"
  type: string;
  match: string | null; // last four digits, to pick up statement balances
  closed: boolean;
}
export interface Balance {
  account: string;
  date: string;
  cents: number;
}
export type FoundKind = "bank" | "card" | "investment";
export interface FoundBalance {
  ref: string;
  kind: FoundKind;
  date: string;
  cents: number;
  person: string;
  file: string;
}
export interface Worth {
  accounts: Account[];
  balances: Balance[]; // typed in
  found: FoundBalance[]; // read from statements and downloads
  problems: { file: string; person: string; reason: string }[]; // downloads that couldn't be matched to an account
  types: Record<string, { group: Group; debt: boolean }>;
  people: string[];
  me: string;
  /** The numbers typed into the projection, as typed. */
  projection?: Record<string, string>;
}
export interface Point extends Balance {
  from: "typed" | "statement";
}

/** Every known balance of an account, oldest first: statements matched by the last four digits, and typed ones (which win on the same day). */
export function pointsFor(acct: Account, worth: Worth): Point[] {
  const byDate = new Map<string, Point>();
  if (acct.match) {
    for (const f of worth.found) {
      if (f.ref !== acct.match) continue;
      if (acct.owner !== "joint" && f.person !== acct.owner) continue;
      byDate.set(f.date, { account: acct.id, date: f.date, cents: f.cents, from: "statement" });
    }
  }
  for (const b of worth.balances) if (b.account === acct.id) byDate.set(b.date, { ...b, from: "typed" });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** The balance an account had at the end of a month: the latest one known by then, or null before the first. */
export function balanceAt(points: Point[], month: string): number | null {
  const end = monthEnd(month);
  let found: number | null = null;
  for (const p of points) {
    if (p.date > end) break;
    found = p.cents;
  }
  return found;
}

export interface WorthRow {
  month: string;
  groups: Record<Group, number>; // debt is the amount owed, positive
  mortgage: number; // the part of debt that's a mortgage, so the home can be left out as a whole
  net: number;
}

export function worthByMonth(worth: Worth, months: string[], owner: string | null = null): WorthRow[] {
  const accounts = worth.accounts.filter((a) => !owner || a.owner === owner);
  const points = new Map(accounts.map((a) => [a.id, pointsFor(a, worth)]));
  return months.map((month) => {
    const groups: Record<Group, number> = { cash: 0, invested: 0, retirement: 0, property: 0, debt: 0 };
    let mortgage = 0;
    for (const a of accounts) {
      const value = balanceAt(points.get(a.id)!, month);
      const group = worth.types[a.type]?.group;
      if (value === null || !group) continue;
      groups[group] += value;
      if (a.type === "mortgage") mortgage += value;
    }
    const assets = ASSET_GROUPS.reduce((n, g) => n + groups[g], 0);
    return { month, groups, mortgage, net: assets - groups.debt };
  });
}

/** The same rows without the home: property and mortgages left out together. */
export function withoutHome(rows: WorthRow[]): WorthRow[] {
  return rows.map((r) => ({
    ...r,
    net: r.net - r.groups.property + r.mortgage,
    groups: { ...r.groups, property: 0, debt: r.groups.debt - r.mortgage },
    mortgage: 0,
  }));
}

/** The months from the first balance anyone has to the latest. */
export function worthMonths(worth: Worth): string[] {
  const dates = [...worth.found.map((f) => f.date), ...worth.balances.map((b) => b.date)].sort();
  if (!dates.length) return [];
  return monthRange(monthOf(dates[0]), monthOf(dates[dates.length - 1]));
}

/** Statement accounts not linked to any account yet, one entry per account number and person. */
export function unlinked(worth: Worth) {
  const linked = new Set(worth.accounts.filter((a) => a.match).map((a) => `${a.match}|${a.owner}`));
  const jointLinked = new Set(worth.accounts.filter((a) => a.match && a.owner === "joint").map((a) => a.match));
  const groups = new Map<
    string,
    { ref: string; kind: FoundKind; person: string; count: number; latest: FoundBalance }
  >();
  for (const f of worth.found) {
    if (linked.has(`${f.ref}|${f.person}`) || jointLinked.has(f.ref)) continue;
    const key = `${f.ref}|${f.person}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { ref: f.ref, kind: f.kind, person: f.person, count: 1, latest: f });
    else {
      g.count++;
      if (f.date > g.latest.date) g.latest = f;
    }
  }
  return [...groups.values()];
}

/** Income, spending and the share of income kept, over the given months (household-wide: both of you). */
export function savingsRate(txns: Txn[], months: string[], income: string) {
  const inRange = new Set(months);
  let earned = 0;
  let spent = 0;
  for (const t of txns) {
    if (!inRange.has(monthOf(t.date))) continue;
    if (t.category === income) earned += t.cents;
    else spent += t.cents;
  }
  return { earned, spent, kept: earned - spent, rate: earned > 0 ? (earned - spent) / earned : null };
}

export interface BudgetRow {
  category: string;
  /** The monthly budget in cents, or null when there isn't one. */
  budget: number | null;
  /** Spent in the month, in cents; returns lower it. */
  spent: number;
  /** A month on average over the year up to and including this month, counting only months with transactions. */
  average: number;
  /** Of those months, how many went over the budget. */
  overMonths: number;
  monthsCounted: number;
}

/**
 * Each category's spending in `month` against its budget, for the household: shared and
 * personal, both of you. Budgeted categories come first, biggest budget first.
 */
export function budgetRows(txns: Txn[], month: string, income: string, budgets: Record<string, number>): BudgetRow[] {
  const year = new Set(monthRange(shiftMonth(month, -11), month));
  const byMonth = new Map<string, Map<string, number>>(); // category -> month -> cents
  const withData = new Set<string>();
  for (const t of txns) {
    const m = monthOf(t.date);
    if (!year.has(m)) continue;
    withData.add(m);
    if (t.category === income) continue;
    const row = byMonth.get(t.category) ?? new Map<string, number>();
    row.set(m, (row.get(m) ?? 0) + t.cents);
    byMonth.set(t.category, row);
  }
  const counted = [...withData];
  const cats = new Set([...Object.keys(budgets), ...byMonth.keys()]);
  const rows = [...cats].map((category) => {
    const months = byMonth.get(category) ?? new Map<string, number>();
    const budget = budgets[category] ?? null;
    const total = counted.reduce((n, m) => n + (months.get(m) ?? 0), 0);
    return {
      category,
      budget,
      spent: months.get(month) ?? 0,
      average: counted.length ? Math.round(total / counted.length) : 0,
      overMonths: budget === null ? 0 : counted.filter((m) => (months.get(m) ?? 0) > budget).length,
      monthsCounted: counted.length,
    };
  });
  return rows
    .filter((r) => r.budget !== null || r.spent !== 0 || r.average > 0)
    .sort(
      (a, b) =>
        (a.budget === null ? 1 : 0) - (b.budget === null ? 1 : 0) ||
        (b.budget ?? b.spent) - (a.budget ?? a.spent) ||
        a.category.localeCompare(b.category),
    );
}

/** A starting budget from an average: rounded up to the next $10. */
export const suggestBudget = (average: number) => Math.ceil(Math.max(0, average) / 1000) * 1000;

/** Net worth at the end of the latest month, and the month before, for the phone app's Home. */
export interface NetWorthNote {
  month: string;
  cents: number;
  previous_month: string | null;
  previous_cents: number | null;
}

/**
 * The household's net worth (everyone's accounts, the home included, as Net worth's
 * headline shows it) at the end of the latest month with balances, and the month before.
 * Null without any accounts or balances.
 */
export function latestNetWorth(worth: Worth): NetWorthNote | null {
  if (!worth.accounts.length) return null;
  const months = worthMonths(worth);
  if (!months.length) return null;
  const rows = worthByMonth(worth, months);
  const last = rows[rows.length - 1];
  const before = rows.length > 1 ? rows[rows.length - 2] : null;
  return {
    month: last.month,
    cents: last.net,
    previous_month: before?.month ?? null,
    previous_cents: before?.net ?? null,
  };
}
