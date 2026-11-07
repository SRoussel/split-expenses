// Pure ledger logic: money parsing, balance math, CSV import/export.
// No browser or server code in here so it can be tested with plain Node.

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

export function describeBalance(balanceCents: number, partnerName: string): string {
  if (balanceCents > 0) return `${partnerName} owes you ${fmt(balanceCents)}`;
  if (balanceCents < 0) return `You owe ${partnerName} ${fmt(balanceCents)}`;
  return "All settled up";
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Minimal CSV parser: handles quoted fields, escaped quotes and CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface ImportSummary {
  count: number;
  skipped: number;
  totalCents: number;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  name: string; // "Expenses mm/dd/yy-mm/dd/yy"
  byCategory: Record<string, number>;
}

function mmddyy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y.slice(2)}`;
}

/**
 * Total up a split_transactions.csv from split_statements.py.
 * Expects columns date (YYYY-MM-DD), amount, and optionally category.
 */
export function summarizeImport(text: string): ImportSummary {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("That file is empty.");

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const dateIdx = header.indexOf("date");
  const amountIdx = header.indexOf("amount");
  const categoryIdx = header.indexOf("category");
  if (dateIdx < 0 || amountIdx < 0) {
    throw new Error("The CSV needs 'date' and 'amount' columns.");
  }

  let count = 0;
  let skipped = 0;
  let totalCents = 0;
  let start = "";
  let end = "";
  const byCategory: Record<string, number> = {};

  for (const r of rows.slice(1)) {
    const date = (r[dateIdx] ?? "").trim();
    const cents = parseDollars(r[amountIdx] ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || cents === null) {
      skipped++;
      continue;
    }
    count++;
    totalCents += cents;
    if (!start || date < start) start = date;
    if (!end || date > end) end = date;
    const cat = (categoryIdx >= 0 ? (r[categoryIdx] ?? "").trim() : "") || "uncategorized";
    byCategory[cat] = (byCategory[cat] ?? 0) + cents;
  }

  if (count === 0) throw new Error("No valid transactions found in that file.");

  return {
    count,
    skipped,
    totalCents,
    start,
    end,
    name: `Expenses ${mmddyy(start)}-${mmddyy(end)}`,
    byCategory,
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
