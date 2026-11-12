// The Home screen's numbers: when you last settled, and this month against the budgets.

import { INCOME_CATEGORY } from "../shared/categories";
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
