// Recurring expenses: the rules, and adding the occurrences that are due.

import { isSpendingCategory } from "../shared/categories";
import { owedCents, pctToBasisPoints } from "../shared/owed";
import { dueOccurrences, firstIndexOnOrAfter, FREQUENCIES, type Frequency, occurrenceDate } from "../shared/recurring";
import { requireMembership, requireUser } from "./auth";
import { addDays, type Env, HttpError, json, MAX_AMOUNT_CENTS, readBody, str, todayFor, validDate } from "./http";

const MAX_RULES = 50;

interface RecurringRow {
  id: string;
  name: string;
  amount_cents: number;
  payer_id: string;
  payer_share_pct: number;
  frequency: Frequency;
  start_date: string;
  next_index: number;
  paused: number;
  created_by: string;
  category: string | null;
}

/**
 * Create every occurrence that is due and not created yet, then move each rule on.
 * Runs whenever the household is loaded. Safe to run twice at once: the unique
 * index on (recurring_id, occurrence_date) drops a duplicate insert, and each
 * rule only moves forward from the position it was read at.
 */
export async function addDueRecurring(env: Env, householdId: string, today: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, amount_cents, payer_id, payer_share_pct, frequency, start_date, next_index, paused, created_by,
            category
     FROM recurring WHERE household_id = ? AND stopped_at IS NULL AND paused = 0 AND next_date <= ?`,
  )
    .bind(householdId, today)
    .all<RecurringRow>();

  const statements: D1PreparedStatement[] = [];
  for (const r of results) {
    const due = dueOccurrences(r.start_date, r.frequency, r.next_index, today);
    if (!due.length) continue;
    const owed = owedCents("expense", r.amount_cents, r.payer_share_pct);
    for (const o of due) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO entries
             (id, household_id, kind, entry_date, name, amount_cents, payer_id, payer_share_pct, owed_cents,
              created_by, recurring_id, occurrence_date, category)
           VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (recurring_id, occurrence_date) WHERE recurring_id IS NOT NULL DO NOTHING`,
        ).bind(
          crypto.randomUUID(), householdId, o.date, r.name, r.amount_cents, r.payer_id, r.payer_share_pct, owed,
          r.created_by, r.id, o.date, r.category,
        ),
      );
    }
    const next = due[due.length - 1].index + 1;
    const nextDate = occurrenceDate(r.start_date, r.frequency, next);
    statements.push(
      env.DB.prepare("UPDATE recurring SET next_index = ?, next_date = ? WHERE id = ? AND next_index = ?").bind(
        next, nextDate, r.id, r.next_index,
      ),
    );
  }
  if (statements.length) await env.DB.batch(statements);
}

/** Checks the parts of a rule that can be set or changed. */
async function validateRuleFields(env: Env, householdId: string, body: Record<string, unknown>) {
  const name = str(body, "name", 200);
  const amount = body.amount_cents;
  if (!Number.isInteger(amount) || (amount as number) <= 0 || (amount as number) > MAX_AMOUNT_CENTS) {
    throw new HttpError(400, "Invalid amount.");
  }
  const bp = typeof body.payer_share_pct === "number" ? pctToBasisPoints(body.payer_share_pct) : null;
  if (bp === null) throw new HttpError(400, "Invalid share.");
  const payerId = str(body, "payer_id", 64);
  const payer = await env.DB.prepare("SELECT 1 FROM members WHERE household_id = ? AND user_id = ?")
    .bind(householdId, payerId)
    .first();
  if (!payer) throw new HttpError(400, "The payer isn't in this household.");
  const category = body.category ?? null;
  if (category !== null && !isSpendingCategory(category)) throw new HttpError(400, "Invalid category.");
  return { name, amount: amount as number, pct: bp / 100, payerId, category };
}

export async function createRecurring(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  const body = await readBody(request);
  const f = await validateRuleFields(env, household_id, body);

  const frequency = body.frequency as Frequency;
  if (!FREQUENCIES.includes(frequency)) throw new HttpError(400, "Invalid frequency.");
  const today = todayFor(request, body);
  const start = str(body, "start_date", 10);
  if (!validDate(start)) throw new HttpError(400, "Invalid start date.");
  // Rules only start from today: no back-filling of past dates.
  if (start < today) throw new HttpError(400, "The first date can't be in the past.");
  if (start > addDays(today, 366)) throw new HttpError(400, "The first date must be within the next year.");

  const count = await env.DB.prepare(
    "SELECT count(*) AS n FROM recurring WHERE household_id = ? AND stopped_at IS NULL",
  )
    .bind(household_id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_RULES) throw new HttpError(409, `You can have at most ${MAX_RULES} recurring expenses.`);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO recurring
       (id, household_id, name, amount_cents, payer_id, payer_share_pct, frequency, start_date, next_index, next_date,
        created_by, category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  )
    .bind(id, household_id, f.name, f.amount, f.payerId, f.pct, frequency, start, start, user.id, f.category)
    .run();
  return json({ ok: true, id }, 201);
}

/** Change the amount, name, payer or split (future occurrences only), or pause / resume. */
export async function updateRecurring(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  const body = await readBody(request);
  const rule = await env.DB.prepare(
    `SELECT start_date, frequency, next_index, paused FROM recurring
     WHERE id = ? AND household_id = ? AND stopped_at IS NULL`,
  )
    .bind(id, household_id)
    .first<{ start_date: string; frequency: Frequency; next_index: number; paused: number }>();
  if (!rule) throw new HttpError(404, "Recurring expense not found.");

  const f = await validateRuleFields(env, household_id, body);
  if (typeof body.paused !== "boolean") throw new HttpError(400, 'Missing or invalid "paused".');

  // Resuming continues from the next date on or after today; paused months aren't filled in.
  let nextIndex = rule.next_index;
  if (rule.paused && !body.paused) {
    nextIndex = firstIndexOnOrAfter(rule.start_date, rule.frequency, rule.next_index, todayFor(request, body));
  }
  const nextDate = occurrenceDate(rule.start_date, rule.frequency, nextIndex);

  await env.DB.prepare(
    `UPDATE recurring SET name = ?, amount_cents = ?, payer_id = ?, payer_share_pct = ?, paused = ?,
       next_index = ?, next_date = ?, category = ?
     WHERE id = ? AND household_id = ? AND stopped_at IS NULL`,
  )
    .bind(f.name, f.amount, f.payerId, f.pct, body.paused ? 1 : 0, nextIndex, nextDate, f.category, id, household_id)
    .run();
  return json({ ok: true });
}

/** Stop a rule for good. Entries it already added stay. */
export async function stopRecurring(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  const res = await env.DB.prepare(
    `UPDATE recurring SET stopped_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND household_id = ? AND stopped_at IS NULL`,
  )
    .bind(id, household_id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, "Recurring expense not found.");
  return json({ ok: true });
}
