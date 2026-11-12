// Statement imports and spending totals: totals per (month, category) only.

import { INCOME_CATEGORY, isPersonalCategory, isSpendingCategory } from "../shared/categories";
import { MAX_UPLOAD_MONTHS } from "../shared/limits";
import { owedCents, pctToBasisPoints } from "../shared/owed";
import { requireMembership, requireUser } from "./auth";
import {
  type Env,
  HttpError,
  isUniqueViolation,
  json,
  MAX_AMOUNT_CENTS,
  readBody,
  str,
  todayFor,
  validDate,
} from "./http";

const MAX_CATEGORIES_PER_MONTH = 13;
const ROWS_PER_INSERT = 20; // 4 values per row; D1 allows about 100 values per statement

interface TotalRow {
  month: string;
  category: string;
  cents: number;
}

/** Checks a { "YYYY-MM": { category: cents } } block from a statement summary. */
function validateMonths(
  raw: unknown,
  start: string,
  end: string,
  allowed: (c: unknown) => boolean,
  label: string,
): TotalRow[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, `${label}: invalid months.`);
  const months = Object.entries(raw as Record<string, unknown>);
  if (months.length === 0) throw new HttpError(400, `${label}: no months.`);
  if (months.length > MAX_UPLOAD_MONTHS)
    throw new HttpError(400, `${label}: one upload can cover at most ${MAX_UPLOAD_MONTHS} months.`);
  const rows: TotalRow[] = [];
  for (const [month, cats] of months) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < start.slice(0, 7) || month > end.slice(0, 7)) {
      throw new HttpError(400, `${label}: month ${month} is outside the statement's dates.`);
    }
    if (!cats || typeof cats !== "object" || Array.isArray(cats))
      throw new HttpError(400, `${label}: invalid month ${month}.`);
    const entries = Object.entries(cats as Record<string, unknown>);
    if (entries.length === 0 || entries.length > MAX_CATEGORIES_PER_MONTH) {
      throw new HttpError(400, `${label}: invalid categories in ${month}.`);
    }
    for (const [category, cents] of entries) {
      if (!allowed(category)) throw new HttpError(400, `${label}: unknown category "${category}".`);
      if (!Number.isInteger(cents) || Math.abs(cents as number) > MAX_AMOUNT_CENTS) {
        throw new HttpError(400, `${label}: invalid amount for ${category} in ${month}.`);
      }
      if (category === INCOME_CATEGORY && (cents as number) < 0)
        throw new HttpError(400, `${label}: income can't be negative.`);
      rows.push({ month, category, cents: cents as number });
    }
  }
  return rows;
}

/** INSERT ... VALUES (...), (...) in chunks small enough for D1. */
function insertTotals(
  env: Env,
  table: "entry_breakdown" | "spending_totals",
  ownerColumn: string,
  ownerId: string,
  rows: TotalRow[],
) {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    statements.push(
      env.DB.prepare(
        `INSERT INTO ${table} (${ownerColumn}, month, category, cents) VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")}`,
      ).bind(...chunk.flatMap((r) => [ownerId, r.month, r.category, r.cents])),
    );
  }
  return statements;
}

/**
 * Import a statement summary in one transaction: the shared part becomes one
 * ledger entry (with its month/category breakdown), the personal part becomes
 * a spending upload for the person whose statement it is.
 */
export async function importStatement(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  return importFor(request, env, user.id, household_id, await readBody(request));
}

/** The import itself, for whoever is asking: a signed-in person, or a desktop key (desktop.ts). */
export async function importFor(
  request: Request,
  env: Env,
  userId: string,
  household_id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const user = { id: userId };

  const name = str(body, "name", 200);
  const start = str(body, "start", 10);
  const end = str(body, "end", 10);
  if (!validDate(start) || !validDate(end) || start > end) throw new HttpError(400, "Invalid statement dates.");
  if (!body.shared && !body.personal) throw new HttpError(400, "Nothing to import.");
  // Summaries from the desktop page carry the household's budgets along.
  const budgets = body.budgets === undefined ? [] : budgetStatements(env, household_id, userId, body.budgets);
  const netWorth = body.net_worth === undefined ? [] : [netWorthStatement(env, household_id, userId, body.net_worth)];

  const isMember = async (id: unknown) =>
    typeof id === "string" &&
    Boolean(
      await env.DB.prepare("SELECT 1 FROM members WHERE household_id = ? AND user_id = ?")
        .bind(household_id, id)
        .first(),
    );

  const statements: D1PreparedStatement[] = [];
  const entryId = body.shared ? crypto.randomUUID() : null;
  const batchId = body.personal ? crypto.randomUUID() : null;

  if (body.shared) {
    const shared = body.shared as Record<string, unknown>;
    const rows = validateMonths(shared.months, start, end, isSpendingCategory, "Shared");
    const total = rows.reduce((sum, r) => sum + r.cents, 0);
    if (
      !Number.isInteger(shared.total_cents) ||
      shared.total_cents !== total ||
      total <= 0 ||
      total > MAX_AMOUNT_CENTS
    ) {
      throw new HttpError(400, "Shared: the categories don't add up to the total.");
    }
    const bp = typeof shared.payer_share_pct === "number" ? pctToBasisPoints(shared.payer_share_pct) : null;
    if (bp === null) throw new HttpError(400, "Invalid share.");
    if (!(await isMember(shared.payer_id))) throw new HttpError(400, "The payer isn't in this household.");
    statements.push(
      env.DB.prepare(
        `INSERT INTO entries
           (id, household_id, kind, entry_date, name, amount_cents, payer_id, payer_share_pct, owed_cents, created_by)
         VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        entryId,
        household_id,
        todayFor(request, body),
        name,
        total,
        shared.payer_id,
        bp / 100,
        owedCents("expense", total, bp / 100),
        user.id,
      ),
      ...insertTotals(env, "entry_breakdown", "entry_id", entryId!, rows),
    );
  }

  if (body.personal) {
    const personal = body.personal as Record<string, unknown>;
    const rows = validateMonths(personal.months, start, end, isPersonalCategory, "Personal");
    if (!(await isMember(personal.person_id))) throw new HttpError(400, "That person isn't in this household.");
    statements.push(
      env.DB.prepare(
        `INSERT INTO spending_batches (id, household_id, person_id, name, start_date, end_date, entry_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(batchId, household_id, personal.person_id, name, start, end, entryId, user.id),
      ...insertTotals(env, "spending_totals", "batch_id", batchId!, rows),
    );
  }

  statements.push(...budgets, ...netWorth);
  try {
    await env.DB.batch(statements); // all or nothing
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, "This statement was already uploaded for that person. Delete the old upload first.");
    }
    throw err;
  }
  return json({ ok: true, entryId, batchId }, 201);
}

/** Everything the spending and cash-flow views need: totals only. */
export async function getSpending(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  const [batches, totals, breakdown, budgets, netWorth] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, person_id, name, start_date, end_date, entry_id, created_by, created_at
       FROM spending_batches WHERE household_id = ? ORDER BY start_date DESC, created_at DESC`,
    ).bind(household_id),
    env.DB.prepare(
      `SELECT t.batch_id, t.month, t.category, t.cents FROM spending_totals t
       JOIN spending_batches b ON b.id = t.batch_id WHERE b.household_id = ?`,
    ).bind(household_id),
    env.DB.prepare(
      `SELECT d.entry_id, d.month, d.category, d.cents FROM entry_breakdown d
       JOIN entries e ON e.id = d.entry_id WHERE e.household_id = ? AND e.voided_at IS NULL`,
    ).bind(household_id),
    env.DB.prepare("SELECT category, cents FROM budgets WHERE household_id = ? ORDER BY category").bind(household_id),
    env.DB.prepare("SELECT month, cents, previous_month, previous_cents FROM net_worth WHERE household_id = ?").bind(
      household_id,
    ),
  ]);
  return json({
    batches: batches.results,
    totals: totals.results,
    breakdown: breakdown.results,
    budgets: budgets.results,
    net_worth: netWorth.results[0] ?? null,
  });
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const isCents = (v: unknown) => Number.isInteger(v) && Math.abs(v as number) <= MAX_AMOUNT_CENTS;

/**
 * Net worth from the desktop page, for Home: { month, cents, previous_month, previous_cents }.
 * Only the totals. Kept only if it's for the same month or later than the one already here.
 */
export function netWorthStatement(env: Env, household_id: string, userId: string, note: unknown) {
  const n = note as Record<string, unknown>;
  const ok =
    !!n &&
    typeof n === "object" &&
    !Array.isArray(n) &&
    Object.keys(n).sort().join() === "cents,month,previous_cents,previous_month" &&
    typeof n.month === "string" &&
    MONTH.test(n.month) &&
    isCents(n.cents) &&
    (n.previous_month === null
      ? n.previous_cents === null
      : typeof n.previous_month === "string" &&
        MONTH.test(n.previous_month) &&
        n.previous_month < n.month &&
        isCents(n.previous_cents));
  if (!ok) throw new HttpError(400, "The net worth isn't valid.");
  return env.DB.prepare(
    `INSERT INTO net_worth (household_id, month, cents, previous_month, previous_cents, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (household_id) DO UPDATE SET
       month = excluded.month, cents = excluded.cents, previous_month = excluded.previous_month,
       previous_cents = excluded.previous_cents, updated_by = excluded.updated_by, updated_at = datetime('now')
     WHERE excluded.month >= net_worth.month`,
  ).bind(household_id, n.month, n.cents, n.previous_month, n.previous_cents, userId);
}

/**
 * The statements that replace the household's monthly budgets with `budgets`
 * ({ groceries: 80000, ... } in cents; a category left out has no budget).
 * Budgets come only from the desktop page, the one place they're set: with a
 * statement upload (a summary file or a desktop key), or on their own with a
 * desktop key (desktop.ts). So there's one writer, and nothing to race.
 */
export function budgetStatements(env: Env, household_id: string, userId: string, budgets: unknown) {
  if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) {
    throw new HttpError(400, "Expected budgets by category.");
  }
  const rows = Object.entries(budgets as Record<string, unknown>);
  for (const [category, cents] of rows) {
    if (!isSpendingCategory(category)) throw new HttpError(400, `Unknown budget category: ${category}.`);
    if (!Number.isInteger(cents) || (cents as number) <= 0 || (cents as number) > MAX_AMOUNT_CENTS) {
      throw new HttpError(400, "A budget is a whole number of cents above zero.");
    }
  }
  return [
    env.DB.prepare("DELETE FROM budgets WHERE household_id = ?").bind(household_id),
    ...rows.map(([category, cents]) =>
      env.DB.prepare("INSERT INTO budgets (household_id, category, cents, updated_by) VALUES (?, ?, ?, ?)").bind(
        household_id,
        category,
        cents,
        userId,
      ),
    ),
  ];
}

/**
 * Move money between two spending categories within one month of one upload
 * (personal) or one imported shared entry, e.g. $700 of a Costco run from
 * groceries to household. The source's total doesn't change, so neither does
 * the ledger balance. Still totals only: nothing about the purchase is stored.
 */
export async function moveSpending(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  const body = await readBody(request);
  const kind = body.kind;
  const id = str(body, "id", 64);
  const month = str(body, "month", 7);
  const from = body.from;
  const to = body.to;
  const cents = body.cents;
  if (kind !== "upload" && kind !== "entry") throw new HttpError(400, "Invalid source.");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "Invalid month.");
  if (!isSpendingCategory(from) || !isSpendingCategory(to) || from === to) {
    throw new HttpError(400, "Choose two different spending categories.");
  }
  if (!Number.isInteger(cents) || (cents as number) <= 0 || (cents as number) > MAX_AMOUNT_CENTS) {
    throw new HttpError(400, "Invalid amount.");
  }

  // Only an upload in this household, or an active imported entry in it.
  const owner =
    kind === "upload"
      ? await env.DB.prepare("SELECT id FROM spending_batches WHERE id = ? AND household_id = ?")
          .bind(id, household_id)
          .first()
      : await env.DB.prepare("SELECT id FROM entries WHERE id = ? AND household_id = ? AND voided_at IS NULL")
          .bind(id, household_id)
          .first();
  if (!owner) throw new HttpError(404, kind === "upload" ? "Upload not found." : "Entry not found or voided.");

  const [table, col] = kind === "upload" ? ["spending_totals", "batch_id"] : ["entry_breakdown", "entry_id"];
  const row = await env.DB.prepare(`SELECT cents FROM ${table} WHERE ${col} = ? AND month = ? AND category = ?`)
    .bind(id, month, from)
    .first<{ cents: number }>();
  const have = row?.cents ?? 0;
  if (have < (cents as number)) {
    throw new HttpError(
      400,
      `There's only $${(Math.max(0, have) / 100).toFixed(2)} in ${from} for that month to move.`,
    );
  }

  // One transaction. The take only happens if the amount is still what we read, and
  // the give only if the take happened, so two people moving at once can't double up.
  const left = have - (cents as number);
  const [taken] = await env.DB.batch([
    env.DB.prepare(`UPDATE ${table} SET cents = ? WHERE ${col} = ? AND month = ? AND category = ? AND cents = ?`).bind(
      left,
      id,
      month,
      from,
      have,
    ),
    env.DB.prepare(
      `INSERT INTO ${table} (${col}, month, category, cents)
       SELECT ?, ?, ?, ? WHERE changes() = 1
       ON CONFLICT (${col}, month, category) DO UPDATE SET cents = cents + excluded.cents`,
    ).bind(id, month, to, cents),
    env.DB.prepare(`DELETE FROM ${table} WHERE ${col} = ? AND month = ? AND category = ? AND cents = 0`).bind(
      id,
      month,
      from,
    ),
  ]);
  if (!taken.meta.changes) throw new HttpError(409, "That changed in the meantime. Try again.");
  return json({ ok: true });
}

/** Undo a personal upload. (The shared entry from the same import, if any, is voided separately.) */
export async function deleteBatch(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  const res = await env.DB.prepare("DELETE FROM spending_batches WHERE id = ? AND household_id = ?")
    .bind(id, household_id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, "Upload not found.");
  return json({ ok: true });
}
