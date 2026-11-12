// The Home screen's numbers: when you last settled, and this month against the budgets.

import { INCOME_CATEGORY } from "../shared/categories";
import { fmt } from "./ledger";
import type { Entry, SpendingData } from "./types";

const DAY = 86_400_000;
const dayNumber = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY;

/** The latest payment between you that isn't voided, and how many days ago it was. */
export function lastSettled(entries: Entry[], today: string): { date: string; daysAgo: number } | null {
  let date: string | null = null;
  for (const e of entries) {
    if (e.kind === "settlement" && !e.voided_at && (!date || e.entry_date > date)) date = e.entry_date;
  }
  return date ? { date, daysAgo: Math.max(0, dayNumber(today) - dayNumber(date)) } : null;
}

export interface BudgetLine {
  category: string;
  budget: number;
  spent: number;
}

/** Budgeted categories (over budget first, then biggest budget first), and what went to categories without one. */
export function budgetLines(spent: Record<string, number>, budgets: { category: string; cents: number }[]) {
  const lines: BudgetLine[] = budgets
    .map((b) => ({ category: b.category, budget: b.cents, spent: spent[b.category] ?? 0 }))
    .sort(
      (a, b) =>
        Number(b.spent > b.budget) - Number(a.spent > a.budget) ||
        b.budget - a.budget ||
        a.category.localeCompare(b.category),
    );
  const budgeted = new Set(budgets.map((b) => b.category));
  const other = Object.entries(spent)
    .filter(([c]) => !budgeted.has(c) && c !== INCOME_CATEGORY)
    .reduce((n, [, v]) => n + v, 0);
  return { lines, other };
}

const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
/** fmt shows amounts without a sign (balances say which way in words); net worth can be negative. */
const signed = (cents: number) => (cents < 0 ? `−${fmt(cents)}` : fmt(cents));

/** "Net worth $252,400 at the end of October, up $4,100 from September." */
export function netWorthLine(nw: NonNullable<SpendingData["net_worth"]>): string {
  const head = `Net worth ${signed(nw.cents)} at the end of ${monthName(nw.month)}`;
  if (nw.previous_cents === null || nw.previous_month === null) return `${head}.`;
  const change = nw.cents - nw.previous_cents;
  const from = monthName(nw.previous_month);
  if (change === 0) return `${head}, the same as ${from}.`;
  return `${head}, ${change > 0 ? "up" : "down"} ${fmt(change)} from ${from}.`;
}
