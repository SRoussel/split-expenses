// Ledger entries: add, edit (void + replace), void and restore.

import { isSpendingCategory } from "../shared/categories";
import { owedCents, pctToBasisPoints } from "../shared/owed";
import { requireMembership, requireUser } from "./auth";
import { type Env, HttpError, isUniqueViolation, json, MAX_AMOUNT_CENTS, readBody, str, validDate } from "./http";

interface ValidEntry {
  kind: "expense" | "settlement" | "opening";
  category: string | null;
  entryDate: string;
  name: string;
  amount: number;
  pct: number | null;
  owed: number;
  payerId: string;
}

/** Checks an entry from the browser and works out what's owed. Shared by add and edit. */
async function validateEntry(env: Env, householdId: string, body: Record<string, unknown>): Promise<ValidEntry> {
  const kind = body.kind;
  if (kind !== "expense" && kind !== "settlement" && kind !== "opening") {
    throw new HttpError(400, "Invalid entry type.");
  }
  const entryDate = str(body, "entry_date", 10);
  if (!validDate(entryDate)) throw new HttpError(400, "Invalid date.");
  const name = str(body, "name", 200);
  const amount = body.amount_cents;
  if (!Number.isInteger(amount) || (amount as number) <= 0 || (amount as number) > MAX_AMOUNT_CENTS) {
    throw new HttpError(400, "Invalid amount.");
  }

  // The server decides how much is owed. The browser doesn't send it, and if
  // anything does, it's ignored, so the number always follows from the rest.
  let pct: number | null = null;
  if (kind === "expense") {
    const raw = body.payer_share_pct ?? 50;
    const bp = typeof raw === "number" ? pctToBasisPoints(raw) : null;
    if (bp === null) throw new HttpError(400, "Invalid share.");
    pct = bp / 100;
  }
  const owed = owedCents(kind, amount as number, pct ?? 50);
  const payerId = str(body, "payer_id", 64);
  const payer = await env.DB.prepare("SELECT 1 FROM members WHERE household_id = ? AND user_id = ?")
    .bind(householdId, payerId)
    .first();
  if (!payer) throw new HttpError(400, "The payer isn't in this household.");
  const category = body.category ?? null;
  if (category !== null && (kind !== "expense" || !isSpendingCategory(category))) {
    throw new HttpError(400, "Invalid category.");
  }
  return { kind, category, entryDate, name, amount: amount as number, pct, owed, payerId };
}

const OPENING_EXISTS = "There's already a starting balance. Void it first to change it.";

export async function addEntry(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  const e = await validateEntry(env, household_id, await readBody(request));
  try {
    await env.DB.prepare(
      `INSERT INTO entries
         (id, household_id, kind, entry_date, name, amount_cents, payer_id, payer_share_pct, owed_cents, created_by, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        household_id,
        e.kind,
        e.entryDate,
        e.name,
        e.amount,
        e.payerId,
        e.pct,
        e.owed,
        user.id,
        e.category,
      )
      .run();
  } catch (err) {
    // The unique index allows only one active starting balance per household.
    if (e.kind === "opening" && isUniqueViolation(err)) throw new HttpError(409, OPENING_EXISTS);
    throw err;
  }
  return json({ ok: true }, 201);
}

/**
 * Edit = void the original and add the corrected copy, in one transaction.
 * The original keeps a pointer to its replacement (replaced_by), so the
 * history still shows what it used to say.
 */
export async function editEntry(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  const e = await validateEntry(env, household_id, await readBody(request));
  const newId = crypto.randomUUID();
  const [voided] = await env.DB.batch([
    // 1. Void the original. Only an active entry of the same type in this household qualifies.
    env.DB.prepare(
      `UPDATE entries SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), voided_by = ?, replaced_by = ?
       WHERE id = ? AND household_id = ? AND voided_at IS NULL AND kind = ?`,
    ).bind(user.id, newId, id, household_id, e.kind),
    // 2. Add the replacement, but only if step 1 actually voided the original.
    env.DB.prepare(
      `INSERT INTO entries
         (id, household_id, kind, entry_date, name, amount_cents, payer_id, payer_share_pct, owed_cents, created_by,
          category)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM entries WHERE id = ? AND replaced_by = ?)`,
    ).bind(
      newId,
      household_id,
      e.kind,
      e.entryDate,
      e.name,
      e.amount,
      e.payerId,
      e.pct,
      e.owed,
      user.id,
      e.category,
      id,
      newId,
    ),
    // 3. An imported statement's month/category breakdown carries over if the total didn't change.
    env.DB.prepare(
      `INSERT INTO entry_breakdown (entry_id, month, category, cents)
       SELECT ?, b.month, b.category, b.cents FROM entry_breakdown b
       WHERE b.entry_id = ?
         AND EXISTS (SELECT 1 FROM entries WHERE id = ? AND amount_cents = ?)
         AND (SELECT amount_cents FROM entries WHERE id = ?) = ?`,
    ).bind(newId, id, id, e.amount, newId, e.amount),
  ]);
  if (!voided.meta.changes) throw new HttpError(404, "Entry not found, already voided, or a different type.");
  return json({ ok: true, id: newId });
}

/** Undo a void. Edited entries can't come back: their replacement already exists. */
export async function unvoidEntry(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  let res;
  try {
    res = await env.DB.prepare(
      `UPDATE entries SET voided_at = NULL, voided_by = NULL
       WHERE id = ? AND household_id = ? AND voided_at IS NOT NULL AND replaced_by IS NULL`,
    )
      .bind(id, household_id)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, OPENING_EXISTS);
    throw err;
  }
  if (!res.meta.changes) throw new HttpError(404, "Entry not found, not voided, or replaced by an edit.");
  return json({ ok: true });
}

export async function voidEntry(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  const res = await env.DB.prepare(
    `UPDATE entries SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), voided_by = ?
     WHERE id = ? AND household_id = ? AND voided_at IS NULL`,
  )
    .bind(user.id, id, household_id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, "Entry not found or already voided.");
  return json({ ok: true });
}
