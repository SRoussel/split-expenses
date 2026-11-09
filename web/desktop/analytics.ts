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
}

export interface Data {
  transactions: Txn[];
  sources: { dir: string; person: string; rows: number; kept: number; skipped: number; updated: string }[];
  /** Summaries already made for the phone app: archived by `finish`, or exported from this page. Newest first. */
  sent: { person: string; name: string; start: string; end: string; from: string }[];
  categories: string[];
  income: string;
  me: string;
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
