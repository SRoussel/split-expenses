// Pure ledger logic: money parsing, balance math, CSV import/export.
// No browser or server code in here so it can be tested with plain Node.

import type { Entry, NewEntry } from "./types";

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

/**
 * What the app accepts from a statement. Made on your computer by
 * `uv run split-ledger summarize split_transactions.csv`; individual
 * transactions and merchants never reach the app.
 */
export interface ImportSummary {
  name: string; // "Expenses mm/dd/yy-mm/dd/yy"
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  count: number;
  totalCents: number;
  byCategory: Record<string, number> | null; // null when made with --no-categories
}

/** Biggest summary file the app will read (they're well under 1 KB). */
export const MAX_SUMMARY_BYTES = 16 * 1024;

const SUMMARY_KEYS = new Set(["format", "version", "name", "start", "end", "count", "total_cents", "categories"]);
const MAX_CENTS = 100_000_000_00;

const isDay = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const isCents = (v: unknown, min: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= MAX_CENTS;

const SUMMARIZE_HINT =
  "Run `uv run split-ledger summarize split_transactions.csv` on your computer and choose the split_summary.json it makes.";

/**
 * Read a split_summary.json, strictly. Anything unexpected is refused, in
 * particular the detailed split_transactions.csv and any extra fields, so the
 * only things the app can learn from a statement are the ones listed in
 * ImportSummary.
 */
export function parseSummary(text: string): ImportSummary {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    if (/^\s*"?date"?\s*,/i.test(text) || /\bamount\b.*\bvendor\b/i.test(text.slice(0, 200))) {
      throw new Error(
        "That's the detailed transactions file. To keep your purchases private, the app only takes the summary. " +
          SUMMARIZE_HINT,
      );
    }
    throw new Error(`That isn't a statement summary. ${SUMMARIZE_HINT}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`That isn't a statement summary. ${SUMMARIZE_HINT}`);
  const d = data as Record<string, unknown>;
  if (d.format !== "split-summary") throw new Error(`That isn't a statement summary. ${SUMMARIZE_HINT}`);
  if (d.version !== 1) throw new Error("This summary was made by a newer version of split-ledger. Update the app.");

  const extra = Object.keys(d).filter((k) => !SUMMARY_KEYS.has(k));
  if (extra.length) throw new Error(`The summary has unexpected fields (${extra.join(", ")}), so it wasn't imported.`);

  const name = typeof d.name === "string" ? d.name.trim() : "";
  if (!name || name.length > 200) throw new Error("The summary's name is missing or too long.");
  if (!isDay(d.start) || !isDay(d.end) || d.start > d.end) throw new Error("The summary's dates aren't valid.");
  if (!Number.isInteger(d.count) || (d.count as number) < 1 || (d.count as number) > 100_000) {
    throw new Error("The summary's transaction count isn't valid.");
  }
  if (!isCents(d.total_cents, 1)) throw new Error("The summary's total isn't valid.");

  let byCategory: Record<string, number> | null = null;
  if (d.categories !== undefined) {
    const c = d.categories;
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("The summary's categories aren't valid.");
    const entries = Object.entries(c as Record<string, unknown>);
    if (entries.length > 50) throw new Error("The summary has too many categories.");
    let sum = 0;
    byCategory = {};
    for (const [k, v] of entries) {
      if (!k.trim() || k.length > 50 || !isCents(v, 0)) throw new Error("The summary's categories aren't valid.");
      byCategory[k] = v as number;
      sum += v as number;
    }
    if (sum !== d.total_cents) throw new Error("The summary's categories don't add up to its total, so it wasn't imported.");
  }

  return { name, start: d.start, end: d.end, count: d.count as number, totalCents: d.total_cents as number, byCategory };
}

/**
 * The entry an import sends to the server: the summary's name and total, plus
 * who paid and the split. The categories and counts are only shown on screen.
 */
export function summaryToEntry(
  summary: ImportSummary,
  payerId: string,
  payerSharePct: number,
  entryDate: string,
): NewEntry {
  return {
    kind: "expense",
    entry_date: entryDate,
    name: summary.name,
    amount_cents: summary.totalCents,
    payer_id: payerId,
    payer_share_pct: payerSharePct,
  };
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
