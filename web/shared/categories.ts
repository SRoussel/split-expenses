// The category list, shared by the app and the Worker. The Python scripts keep a
// copy in src/split_expenses/categories.py; CI checks the two match.
import list from "./categories.json";

export const SPENDING_CATEGORIES: readonly string[] = list.spending;
/** Money in: paychecks, interest earned. (Returns reduce their own category instead.) */
export const INCOME_CATEGORY: string = list.income;

export const isSpendingCategory = (c: unknown): c is string =>
  typeof c === "string" && SPENDING_CATEGORIES.includes(c);
export const isPersonalCategory = (c: unknown): c is string => isSpendingCategory(c) || c === INCOME_CATEGORY;

/** "groceries" -> "Groceries" */
export const categoryLabel = (c: string) => c.charAt(0).toUpperCase() + c.slice(1);
