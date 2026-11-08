// Pure ledger logic: money parsing, balance math, CSV import/export.
// No browser or server code in here so it can be tested with plain Node.

import { INCOME_CATEGORY, isPersonalCategory, isSpendingCategory } from "../shared/categories";
import type { Entry } from "./types";

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Format cents as dollars. Always positive; callers decide on the sign. */
export function fmt(cents: number): string {
  return usd.format(Math.abs(cents) / 100);
}

/** "84.20", "$1,200", "5" -> cents. Returns null for anything invalid or <= 0. */
export function parseDollars(input: string): number | null {
  const s = input.replace(/[$,\s]/g, "");
  const m = /^(\d+)?(?:\.(\d{1,2}))?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  const cents = Number(m[1] ?? "0") * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

/** Local date as YYYY-MM-DD (not UTC, so evenings don't land on tomorrow). */
export function todayLocal(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

export { owedCents } from "../shared/owed";
import { pctToBasisPoints } from "../shared/owed";

export const SHARE_ERROR = "Your share must be a number from 0 to 100, with at most two decimals.";

/**
 * Turn the "Your share (%)" text into the payer's share, or null if it isn't valid.
 * If you paid, the payer's share is yours; if your partner paid, it's 100 minus yours.
 */
export function payerSharePct(myShareText: string, payer: "me" | "partner"): number | null {
  if (myShareText.trim() === "") return null;
  const bp = pctToBasisPoints(Number(myShareText));
  if (bp === null) return null;
  return (payer === "me" ? bp : 10_000 - bp) / 100;
}

/** Effect of one entry on `userId`'s balance (positive = the other person owes them). */
export function effectFor(entry: Pick<Entry, "payer_id" | "owed_cents">, userId: string): number {
  return entry.payer_id === userId ? entry.owed_cents : -entry.owed_cents;
}

/** Balance for `userId`: positive = partner owes you, negative = you owe partner. */
export function balanceFor(entries: Entry[], userId: string): number {
  let total = 0;
  for (const e of entries) {
    if (e.voided_at) continue;
    total += effectFor(e, userId);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Search and filters
// ---------------------------------------------------------------------------

export interface EntryFilter {
  /** Matches the name or category; a plain amount like "84.20" also matches that exact amount. */
  text: string;
  kind: "all" | "expense" | "settlement";
  /** Who paid, from the viewer's point of view. */
  payer: "all" | "me" | "partner";
  /** A category, "none" for expenses without one, or "" for any. */
  category: string;
  /** YYYY-MM-DD, inclusive; "" for open-ended. */
  from: string;
  to: string;
}

export const NO_FILTER: EntryFilter = { text: "", kind: "all", payer: "all", category: "", from: "", to: "" };

/** How many filters are set, not counting the search text. */
export function activeFilterCount(f: EntryFilter): number {
  return [f.kind !== "all", f.payer !== "all", f.category !== "", f.from !== "" || f.to !== ""].filter(Boolean).length;
}

export function isFiltering(f: EntryFilter): boolean {
  return f.text.trim() !== "" || activeFilterCount(f) > 0;
}

export function matchesFilter(e: Entry, f: EntryFilter, userId: string): boolean {
  if (f.kind !== "all" && e.kind !== f.kind) return false;
  if (f.payer !== "all" && (e.payer_id === userId) !== (f.payer === "me")) return false;
  if (f.category === "none" ? !(e.kind === "expense" && !e.category) : f.category && e.category !== f.category)
    return false;
  if (f.from && e.entry_date < f.from) return false;
  if (f.to && e.entry_date > f.to) return false;
  const q = f.text.trim().toLowerCase();
  if (!q) return true;
  if (e.name.toLowerCase().includes(q) || (e.category ?? "").includes(q)) return true;
  return parseDollars(q) === e.amount_cents;
}

/** Totals for a set of matching entries: active expenses only (payments and starting balances aren't spending). */
export function filterTotals(entries: Entry[], userId: string): { count: number; spent: number; mine: number } {
  let spent = 0;
  let mine = 0;
  for (const e of entries) {
    if (e.voided_at || e.kind !== "expense") continue;
    spent += e.amount_cents;
    // The payer's own part is what nobody owes them back.
    mine += e.payer_id === userId ? e.amount_cents - e.owed_cents : e.owed_cents;
  }
  return { count: entries.length, spent, mine };
}

export function describeBalance(balanceCents: number, partnerName: string): string {
  if (balanceCents > 0) return `${partnerName} owes you ${fmt(balanceCents)}`;
  if (balanceCents < 0) return `You owe ${partnerName} ${fmt(balanceCents)}`;
  return "All settled up";
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ---------------------------------------------------------------------------
// Statement import: the summary file from `uv run split-ledger summarize`
// ---------------------------------------------------------------------------

/** { "2026-01": { groceries: 8420, income: 325000 } }: totals per month and category, in cents. */
export type MonthTotals = Record<string, Record<string, number>>;

/**
 * What the app accepts from a statement. Made on your computer by
 * `uv run split-ledger summarize`; individual transactions, merchants and
 * purchase dates never reach the app.
 */
export interface ImportSummary {
  name: string; // "Expenses mm/dd/yy-mm/dd/yy"
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  shared: { count: number; totalCents: number; months: MonthTotals } | null;
  personal: { count: number; months: MonthTotals } | null;
}

/** Biggest summary file the app will read (they're a few KB at most). */
export const MAX_SUMMARY_BYTES = 32 * 1024;

const MAX_CENTS = 100_000_000_00;
const SUMMARIZE_HINT =
  "Run `uv run split-ledger summarize` on your computer and choose the split_summary.json it makes.";

const isDay = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string) {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`The summary has unexpected fields${where} (${extra.join(", ")}), so it wasn't imported.`);
}

function checkMonths(raw: unknown, start: string, end: string, allowed: (c: string) => boolean, label: string): MonthTotals {
  if (!isObject(raw)) throw new Error(`The summary's ${label} totals aren't valid.`);
  const months = Object.entries(raw);
  if (months.length === 0 || months.length > 13) throw new Error(`The summary's ${label} totals aren't valid.`);
  const out: MonthTotals = {};
  for (const [month, cats] of months) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < start.slice(0, 7) || month > end.slice(0, 7)) {
      throw new Error(`The summary's ${label} totals include ${month}, outside its dates.`);
    }
    if (!isObject(cats) || Object.keys(cats).length === 0 || Object.keys(cats).length > 13) {
      throw new Error(`The summary's ${label} totals for ${month} aren't valid.`);
    }
    out[month] = {};
    for (const [cat, cents] of Object.entries(cats)) {
      if (!allowed(cat)) throw new Error(`The summary has an unknown ${label} category: "${cat}".`);
      if (!Number.isInteger(cents) || Math.abs(cents as number) > MAX_CENTS) {
        throw new Error(`The summary's ${label} amount for ${cat} in ${month} isn't valid.`);
      }
      if (cat === INCOME_CATEGORY && (cents as number) < 0) throw new Error("The summary has negative income.");
      out[month][cat] = cents as number;
    }
  }
  return out;
}

const sumMonths = (m: MonthTotals) =>
  Object.values(m).reduce((n, cats) => n + Object.values(cats).reduce((a, b) => a + b, 0), 0);

/**
 * Read a split_summary.json, strictly. Anything unexpected is refused, in
 * particular the detailed transaction CSVs and any extra fields, so the only
 * things the app can learn from a statement are the ones in ImportSummary.
 * Version 1 files (shared totals only, from before cash flow) still work.
 */
export function parseSummary(text: string): ImportSummary {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    if (/^\s*"?date"?\s*,/i.test(text) || /\bamount\b.*\bvendor\b/i.test(text.slice(0, 200))) {
      throw new Error(
        "That's a detailed transactions file. To keep your purchases private, the app only takes the summary. " +
          SUMMARIZE_HINT,
      );
    }
    throw new Error(`That isn't a statement summary. ${SUMMARIZE_HINT}`);
  }
  if (!isObject(data) || data.format !== "split-summary") throw new Error(`That isn't a statement summary. ${SUMMARIZE_HINT}`);
  if (data.version !== 1 && data.version !== 2) {
    throw new Error("This summary was made by a newer version of split-ledger. Update the app.");
  }

  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name || name.length > 200) throw new Error("The summary's name is missing or too long.");
  if (!isDay(data.start) || !isDay(data.end) || data.start > data.end) throw new Error("The summary's dates aren't valid.");
  const { start, end } = data;
  const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100_000;

  if (data.version === 1) {
    // Shared totals only, by category for the whole period: file it under the first month.
    onlyKeys(data, ["format", "version", "name", "start", "end", "count", "total_cents", "categories"], "");
    if (!isCount(data.count)) throw new Error("The summary's transaction count isn't valid.");
    const total = data.total_cents;
    if (!Number.isInteger(total) || (total as number) < 1 || (total as number) > MAX_CENTS) {
      throw new Error("The summary's total isn't valid.");
    }
    const cats = isObject(data.categories)
      ? Object.fromEntries(Object.entries(data.categories).map(([c, v]) => [c === "uncategorized" ? "other" : c, v]))
      : { other: total };
    const months = checkMonths({ [start.slice(0, 7)]: cats }, start, end, isSpendingCategory, "shared");
    if (sumMonths(months) !== total) throw new Error("The summary's categories don't add up to its total, so it wasn't imported.");
    return { name, start, end, shared: { count: data.count as number, totalCents: total as number, months }, personal: null };
  }

  onlyKeys(data, ["format", "version", "name", "start", "end", "shared", "personal"], "");
  let shared: ImportSummary["shared"] = null;
  let personal: ImportSummary["personal"] = null;
  if (data.shared !== undefined) {
    if (!isObject(data.shared)) throw new Error("The summary's shared part isn't valid.");
    onlyKeys(data.shared, ["count", "total_cents", "months"], " in its shared part");
    if (!isCount(data.shared.count)) throw new Error("The summary's transaction count isn't valid.");
    const months = checkMonths(data.shared.months, start, end, isSpendingCategory, "shared");
    const total = data.shared.total_cents;
    if (!Number.isInteger(total) || total !== sumMonths(months) || (total as number) < 1) {
      throw new Error("The summary's categories don't add up to its total, so it wasn't imported.");
    }
    shared = { count: data.shared.count as number, totalCents: total as number, months };
  }
  if (data.personal !== undefined) {
    if (!isObject(data.personal)) throw new Error("The summary's personal part isn't valid.");
    onlyKeys(data.personal, ["count", "months"], " in its personal part");
    if (!isCount(data.personal.count)) throw new Error("The summary's transaction count isn't valid.");
    personal = { count: data.personal.count as number, months: checkMonths(data.personal.months, start, end, isPersonalCategory, "personal") };
  }
  if (!shared && !personal) throw new Error("The summary is empty.");
  return { name, start, end, shared, personal };
}

/** Totals per category across all months. */
export function totalsByCategory(months: MonthTotals): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cats of Object.values(months)) {
    for (const [c, v] of Object.entries(cats)) out[c] = (out[c] ?? 0) + v;
  }
  return out;
}

export interface StatementImport {
  name: string;
  start: string;
  end: string;
  shared?: { total_cents: number; months: MonthTotals; payer_id: string; payer_share_pct: number };
  personal?: { person_id: string; months: MonthTotals };
}

/**
 * The request an import sends: the name, the period, and month/category totals,
 * plus who paid, the split, and whose statement it is. Counts and anything else
 * stay on screen.
 */
export function summaryToImport(
  summary: ImportSummary,
  choices: { name: string; shared: { payerId: string; payerSharePct: number } | null; personId: string | null },
): StatementImport {
  const body: StatementImport = { name: choices.name, start: summary.start, end: summary.end };
  if (summary.shared && choices.shared) {
    body.shared = {
      total_cents: summary.shared.totalCents,
      months: summary.shared.months,
      payer_id: choices.shared.payerId,
      payer_share_pct: choices.shared.payerSharePct,
    };
  }
  if (summary.personal && choices.personId) {
    body.personal = { person_id: choices.personId, months: summary.personal.months };
  }
  return body;
}

/**
 * Export in the same format split_ledger.py uses (ledger.csv), from the point
 * of view of `userId`: date,type,payer,amount,my_share,name
 * Voided entries are left out.
 */
export function exportLedgerCsv(entries: Entry[], userId: string): string {
  const lines = ["date,type,payer,amount,my_share,name"];
  const sorted = [...entries]
    .filter((e) => !e.voided_at)
    .sort((a, b) => a.entry_date.localeCompare(b.entry_date) || a.created_at.localeCompare(b.created_at));

  for (const e of sorted) {
    const mine = e.payer_id === userId;
    let type: string = e.kind;
    let payer = mine ? "me" : "partner";
    let myShare = "";

    if (e.kind === "expense") {
      const payerShare = e.payer_share_pct ?? 50;
      myShare = String(mine ? payerShare : 100 - payerShare);
    } else if (e.kind === "opening") {
      // In the script's format, the opening row says who owes whom.
      // payer_id here is the person who is owed.
      type = mine ? "opening_partner_owes" : "opening_me_owes";
      payer = "";
    }

    lines.push(
      [
        e.entry_date,
        type,
        payer,
        (e.amount_cents / 100).toFixed(2),
        myShare,
        csvField(e.name),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
