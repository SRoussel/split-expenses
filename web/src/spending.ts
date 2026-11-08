// Spending and cash flow by month and category. Pure functions over data the app
// already has (ledger entries + statement totals), so they're easy to test.
//
// Four views of the same numbers:
//   me / partner  that person's own statement totals + their share of shared expenses
//   shared        shared expenses at their full amount
//   household     everything: both people's own totals + shared expenses in full
// For any month and category, me + partner = household. (Shares of a shared expense
// always add up to its full amount.)

import { INCOME_CATEGORY } from "../shared/categories";
import type { Entry, SpendingBatch, SpendingData } from "./types";

export type View = "me" | "partner" | "shared" | "household";
export type Cats = Record<string, number>;

/** Shared expenses added by hand without a category. */
export const UNCATEGORIZED = "uncategorized";

export interface SharedItem {
  entryId: string;
  name: string;
  date: string;
  month: string;
  category: string;
  cents: number;
  /** Each person's part of `cents`. */
  shares: Record<string, number>;
}

export interface SpendingIndex {
  /** Every month with any data, oldest first. */
  months: string[];
  /** person -> month -> category -> cents (income included, as INCOME_CATEGORY). */
  personal: Map<string, Map<string, Cats>>;
  /** month -> category -> cents: shared expenses at full amount. */
  sharedFull: Map<string, Cats>;
  /** person -> month -> category -> cents: each person's part of shared expenses. */
  sharedShare: Map<string, Map<string, Cats>>;
  sharedItems: SharedItem[];
}

function addTo(map: Map<string, Cats>, month: string, category: string, cents: number) {
  const cats = map.get(month) ?? {};
  cats[category] = (cats[category] ?? 0) + cents;
  map.set(month, cats);
}

function nested(map: Map<string, Map<string, Cats>>, key: string) {
  let inner = map.get(key);
  if (!inner) map.set(key, (inner = new Map()));
  return inner;
}

/**
 * The non-payer's part of an amount: their percentage, rounded half away from
 * zero, so it matches what the ledger says they owe. The payer has the rest.
 */
export function nonPayerPart(cents: number, nonPayerPct: number): number {
  const bp = Math.round(nonPayerPct * 100);
  return Math.sign(cents) * Math.floor((Math.abs(cents) * bp + 5000) / 10000);
}

export function buildIndex(entries: Entry[], data: SpendingData, memberIds: string[]): SpendingIndex {
  const personal = new Map<string, Map<string, Cats>>();
  const sharedFull = new Map<string, Cats>();
  const sharedShare = new Map<string, Map<string, Cats>>();
  const sharedItems: SharedItem[] = [];
  const months = new Set<string>();

  const personOf = new Map(data.batches.map((b) => [b.id, b.person_id]));
  for (const t of data.totals) {
    const person = personOf.get(t.batch_id);
    if (!person) continue;
    addTo(nested(personal, person), t.month, t.category, t.cents);
    months.add(t.month);
  }

  const breakdown = new Map<string, { month: string; category: string; cents: number }[]>();
  for (const b of data.breakdown) {
    const rows = breakdown.get(b.entry_id) ?? [];
    rows.push(b);
    breakdown.set(b.entry_id, rows);
  }

  for (const e of entries) {
    // Payments between you and starting balances are debts, not spending.
    if (e.kind !== "expense" || e.voided_at) continue;
    const rows = breakdown.get(e.id) ?? [
      { month: e.entry_date.slice(0, 7), category: e.category ?? UNCATEGORIZED, cents: e.amount_cents },
    ];
    const payerPct = e.payer_share_pct ?? 50;
    for (const r of rows) {
      const other = nonPayerPart(r.cents, 100 - payerPct);
      const shares: Record<string, number> = {};
      for (const id of memberIds) shares[id] = id === e.payer_id ? r.cents - other : other;
      addTo(sharedFull, r.month, r.category, r.cents);
      for (const [id, part] of Object.entries(shares)) addTo(nested(sharedShare, id), r.month, r.category, part);
      sharedItems.push({ entryId: e.id, name: e.name, date: e.entry_date, month: r.month, category: r.category, cents: r.cents, shares });
      months.add(r.month);
    }
  }

  return { months: [...months].sort(), personal, sharedFull, sharedShare, sharedItems };
}

export interface MonthSummary {
  /** Spending per category (income left out). */
  categories: Cats;
  spent: number;
  /** null for the shared view, which has no income. */
  income: number | null;
  net: number | null;
}

function merge(into: Cats, from: Cats | undefined) {
  if (!from) return;
  for (const [c, v] of Object.entries(from)) into[c] = (into[c] ?? 0) + v;
}

export function summarize(index: SpendingIndex, view: View, month: string, me: string, partner: string | null): MonthSummary {
  const all: Cats = {};
  const people = view === "me" ? [me] : view === "partner" ? (partner ? [partner] : []) : view === "household" ? [me, partner].filter(Boolean) as string[] : [];
  for (const p of people) merge(all, index.personal.get(p)?.get(month));
  if (view === "shared" || view === "household") merge(all, index.sharedFull.get(month));
  else for (const p of people) merge(all, index.sharedShare.get(p)?.get(month));

  const income = view === "shared" ? null : all[INCOME_CATEGORY] ?? 0;
  delete all[INCOME_CATEGORY];
  for (const [c, v] of Object.entries(all)) if (v === 0) delete all[c];
  const spent = Object.values(all).reduce((a, b) => a + b, 0);
  return { categories: all, spent, income, net: income === null ? null : income - spent };
}

/** "2026-03" -> "2026-02" */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The `count` calendar months ending with `month`, oldest first (empty ones included). */
export function monthsEnding(month: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonth(month, i - count + 1));
}

const hasData = (s: MonthSummary) => s.spent !== 0 || (s.income ?? 0) !== 0;

/**
 * How a month compares: the previous month and the average of up to 6 earlier
 * months that have any data for this view (months with nothing uploaded don't
 * drag the average down). `pick` chooses the number: a category or the total.
 */
export function compare(
  index: SpendingIndex,
  view: View,
  month: string,
  me: string,
  partner: string | null,
  pick: (s: MonthSummary) => number,
): { previous: number | null; average: number | null; months: number } {
  const prev = summarize(index, view, shiftMonth(month, -1), me, partner);
  const earlier = index.months
    .filter((m) => m < month)
    .map((m) => summarize(index, view, m, me, partner))
    .filter(hasData)
    .slice(-6);
  return {
    previous: hasData(prev) ? pick(prev) : null,
    average: earlier.length ? Math.round(earlier.reduce((n, s) => n + pick(s), 0) / earlier.length) : null,
    months: earlier.length,
  };
}

export interface Coverage {
  covered: number;
  days: number;
  /** Covered stretches as [first day, last day] of the month, 1-based. */
  ranges: [number, number][];
}

/** Which days of a month a person's statement uploads cover. */
export function coverage(batches: SpendingBatch[], personId: string, month: string): Coverage {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const first = `${month}-01`;
  const last = `${month}-${String(days).padStart(2, "0")}`;
  const spans = batches
    .filter((b) => b.person_id === personId && b.start_date <= last && b.end_date >= first)
    .map((b) => [
      b.start_date < first ? 1 : Number(b.start_date.slice(8)),
      b.end_date > last ? days : Number(b.end_date.slice(8)),
    ] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const ranges: [number, number][] = [];
  for (const [s, e] of spans) {
    const prev = ranges[ranges.length - 1];
    if (prev && s <= prev[1] + 1) prev[1] = Math.max(prev[1], e);
    else ranges.push([s, e]);
  }
  return { covered: ranges.reduce((n, [s, e]) => n + e - s + 1, 0), days, ranges };
}

/** Shared expenses in a month and category, with the part that counts for the view. */
export function sharedItemsFor(index: SpendingIndex, view: View, month: string, category: string, me: string, partner: string | null) {
  return index.sharedItems
    .filter((i) => i.month === month && i.category === category)
    .map((i) => ({
      ...i,
      counted: view === "me" ? i.shares[me] ?? 0 : view === "partner" && partner ? i.shares[partner] ?? 0 : i.cents,
    }));
}

// ---------------------------------------------------------------------------
// Reports: ranges, totals over several months, CSV export
// ---------------------------------------------------------------------------

export type Range = "6m" | "12m" | "ytd";

/** The months of a range ending with `end` (YYYY-MM), oldest first. */
export function rangeMonths(end: string, range: Range): string[] {
  if (range === "ytd") return monthsEnding(end, Number(end.slice(5, 7)));
  return monthsEnding(end, range === "6m" ? 6 : 12);
}

/** People whose uploads count for a view. */
export function peopleFor(view: View, me: string, partner: string | null): string[] {
  if (view === "me") return [me];
  if (view === "partner") return partner ? [partner] : [];
  if (view === "household") return partner ? [me, partner] : [me];
  return [];
}

/** A month counts as partial when anyone in the view has uploads covering only some of it. */
export function isPartial(batches: SpendingBatch[], people: string[], month: string): boolean {
  return people.some((p) => {
    const c = coverage(batches, p, month);
    return c.covered > 0 && c.covered < c.days;
  });
}

export interface CategoryReport {
  category: string;
  /** Per month, in the range's order. */
  series: number[];
  total: number;
  /** Average per month over full months that have any data (null if there are none). */
  average: number | null;
  /** Share of all spending in the range, 0-1. */
  share: number;
}

export interface RangeReport {
  months: string[];
  summaries: MonthSummary[];
  partial: boolean[];
  categories: CategoryReport[];
  income: number | null;
  spent: number;
  net: number | null;
}

export function rangeReport(
  index: SpendingIndex,
  batches: SpendingBatch[],
  view: View,
  months: string[],
  me: string,
  partner: string | null,
): RangeReport {
  const people = peopleFor(view, me, partner);
  const summaries = months.map((m) => summarize(index, view, m, me, partner));
  const partial = months.map((m) => isPartial(batches, people, m));
  // Months that count for averages: full, and with something in them.
  const full = summaries.map((s, i) => !partial[i] && (s.spent !== 0 || (s.income ?? 0) !== 0));
  const fullCount = full.filter(Boolean).length;

  const names = new Set(summaries.flatMap((s) => Object.keys(s.categories)));
  const spent = summaries.reduce((n, s) => n + s.spent, 0);
  const categories = [...names]
    .map((category) => {
      const series = summaries.map((s) => s.categories[category] ?? 0);
      const total = series.reduce((a, b) => a + b, 0);
      const fullTotal = series.reduce((n, v, i) => n + (full[i] ? v : 0), 0);
      return {
        category,
        series,
        total,
        average: fullCount ? Math.round(fullTotal / fullCount) : null,
        share: spent > 0 ? total / spent : 0,
      };
    })
    .filter((c) => c.total !== 0 || c.series.some((v) => v !== 0))
    .sort((a, b) => b.total - a.total);

  const income = view === "shared" ? null : summaries.reduce((n, s) => n + (s.income ?? 0), 0);
  return { months, summaries, partial, categories, income, spent, net: income === null ? null : income - spent };
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const dollars = (cents: number) => (cents / 100).toFixed(2);

/**
 * One row per month: income, spent, net, then one column per category, in
 * dollars. Totals only, the same numbers the Spending tab shows.
 */
export function reportCsv(report: RangeReport, categoryName: (c: string) => string): string {
  const cats = report.categories.map((c) => c.category);
  const cashflow = report.income !== null;
  const head = ["month", ...(cashflow ? ["income", "spent", "net"] : ["spent"]), ...cats.map(categoryName), "partial"];
  const rows = report.months.map((m, i) => {
    const s = report.summaries[i];
    return [
      m,
      ...(cashflow ? [dollars(s.income ?? 0), dollars(s.spent), dollars(s.net ?? 0)] : [dollars(s.spent)]),
      ...cats.map((c) => dollars(s.categories[c] ?? 0)),
      report.partial[i] ? "yes" : "",
    ];
  });
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

/** Somewhere money in a category can be moved out of: one upload, or one imported shared entry. */
export interface MoveSource {
  kind: "upload" | "entry";
  id: string;
  /** The upload's or entry's name. */
  name: string;
  /** Whose upload, or null for a shared entry (a move there changes it for both of you). */
  person: string | null;
  cents: number;
}

/**
 * Where the money in `category` for `month` came from, for the people in this view:
 * their uploads, and imported shared entries. Hand-added entries aren't listed:
 * change their category by editing them instead.
 */
export function moveSources(
  entries: Entry[],
  data: SpendingData,
  view: View,
  month: string,
  category: string,
  me: string,
  partner: string | null,
): MoveSource[] {
  const people = peopleFor(view, me, partner);
  const sources: MoveSource[] = [];
  for (const b of data.batches) {
    if (!people.includes(b.person_id)) continue;
    const cents = data.totals
      .filter((t) => t.batch_id === b.id && t.month === month && t.category === category)
      .reduce((s, t) => s + t.cents, 0);
    if (cents > 0) sources.push({ kind: "upload", id: b.id, name: b.name, person: b.person_id, cents });
  }
  const active = new Map(entries.filter((e) => e.kind === "expense" && !e.voided_at).map((e) => [e.id, e]));
  for (const d of data.breakdown) {
    const e = active.get(d.entry_id);
    if (e && d.month === month && d.category === category && d.cents > 0) {
      sources.push({ kind: "entry", id: e.id, name: e.name, person: null, cents: d.cents });
    }
  }
  return sources;
}
