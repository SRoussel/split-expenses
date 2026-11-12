// The Home screen's numbers: when you last settled, and this month against the budgets.

import { INCOME_CATEGORY } from "../shared/categories";
import { monthsEnding, summarize, type SpendingIndex } from "./spending";
import type { Entry } from "./types";

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

/**
 * The household's average month per category over the `count` months before `month`,
 * counting only months that have any data. A starting point for budgets.
 */
export function monthlyAverages(
  index: SpendingIndex,
  month: string,
  me: string,
  partner: string | null,
  count = 6,
): Record<string, number> {
  const have = new Set(index.months);
  const months = monthsEnding(month, count + 1)
    .slice(0, count)
    .filter((m) => have.has(m));
  const totals: Record<string, number> = {};
  for (const m of months) {
    for (const [c, v] of Object.entries(summarize(index, "household", m, me, partner).categories)) {
      totals[c] = (totals[c] ?? 0) + v;
    }
  }
  return Object.fromEntries(
    Object.entries(totals)
      .filter(([, v]) => v > 0)
      .map(([c, v]) => [c, Math.round(v / months.length)]),
  );
}

/** A starting budget from an average: rounded up to the next $10. */
export const roundBudget = (cents: number) => Math.ceil(Math.max(0, cents) / 1000) * 1000;
