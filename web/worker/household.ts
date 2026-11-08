// The household: creating and joining it, loading everything, the default split, and reset.

import { pctToBasisPoints } from "../shared/owed";
import { clearAttempts, membershipOf, randomHex, requireMembership, requireUser, throttle } from "./auth";
import { type Env, HttpError, isUniqueViolation, json, readBody, str, todayFor } from "./http";
import { addDueRecurring } from "./recurring";

export async function createHousehold(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const displayName = str(await readBody(request), "displayName", 60);
  if (await membershipOf(env, user.id)) throw new HttpError(409, "You are already in a household.");

  const id = crypto.randomUUID();
  try {
    await env.DB.batch([
      // 64-bit random invite code
      env.DB.prepare("INSERT INTO households (id, invite_code) VALUES (?, ?)").bind(id, randomHex(8)),
      env.DB.prepare("INSERT INTO members (household_id, user_id, display_name) VALUES (?, ?, ?)").bind(
        id,
        user.id,
        displayName,
      ),
    ]);
  } catch (err) {
    // A double tap: the other request already put this user in a household.
    if (isUniqueViolation(err)) throw new HttpError(409, "You are already in a household.");
    throw err;
  }
  return json({ householdId: id });
}

export async function joinHousehold(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const body = await readBody(request);
  const code = str(body, "code", 40).toLowerCase();
  const displayName = str(body, "displayName", 60);
  if (await membershipOf(env, user.id)) throw new HttpError(409, "You are already in a household.");

  const bucket = `join:${user.id}`;
  await throttle(env, { bucket, max: 10, window: "-15 minutes" });
  const household = await env.DB.prepare("SELECT id FROM households WHERE invite_code = ?")
    .bind(code)
    .first<{ id: string }>();
  if (!household) throw new HttpError(404, "That invite code was not found.");
  await clearAttempts(env, bucket);

  // The size check and the insert are one statement, so two people can't race past the limit.
  let res;
  try {
    res = await env.DB.prepare(
      `INSERT INTO members (household_id, user_id, display_name)
       SELECT ?1, ?2, ?3 WHERE (SELECT count(*) FROM members WHERE household_id = ?1) < 2`,
    )
      .bind(household.id, user.id, displayName)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "You are already in a household.");
    throw err;
  }
  if (!res.meta.changes) throw new HttpError(409, "That household is already full.");
  return json({ householdId: household.id });
}

export async function getHousehold(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  await addDueRecurring(env, household_id, todayFor(request));
  const [members, household, entries, recurring] = await env.DB.batch([
    env.DB.prepare("SELECT user_id, display_name, share_pct FROM members WHERE household_id = ?").bind(household_id),
    env.DB.prepare("SELECT invite_code FROM households WHERE id = ?").bind(household_id),
    env.DB.prepare(
      "SELECT * FROM entries WHERE household_id = ? ORDER BY entry_date DESC, created_at DESC",
    ).bind(household_id),
    env.DB.prepare(
      `SELECT id, name, amount_cents, payer_id, payer_share_pct, frequency, start_date, next_date, paused, created_by,
              category
       FROM recurring WHERE household_id = ? AND stopped_at IS NULL ORDER BY next_date, name`,
    ).bind(household_id),
  ]);
  return json({
    members: members.results,
    inviteCode: (household.results[0] as { invite_code: string }).invite_code,
    entries: entries.results,
    recurring: (recurring.results as { paused: number }[]).map((r) => ({ ...r, paused: Boolean(r.paused) })),
  });
}

/** Set the default split: my share and my partner's (the rest) together. */
export async function setSplit(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  const raw = (await readBody(request)).myShare;
  const bp = typeof raw === "number" ? pctToBasisPoints(raw) : null;
  if (bp === null) throw new HttpError(400, "Your share must be a number from 0 to 100, with at most two decimals.");

  // One transaction; each update only applies if the household has exactly two members.
  const [mine, theirs] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE members SET share_pct = ? WHERE household_id = ? AND user_id = ?
         AND (SELECT count(*) FROM members WHERE household_id = ?) = 2`,
    ).bind(bp / 100, household_id, user.id, household_id),
    env.DB.prepare(
      `UPDATE members SET share_pct = ? WHERE household_id = ? AND user_id != ?
         AND (SELECT count(*) FROM members WHERE household_id = ?) = 2`,
    ).bind((10_000 - bp) / 100, household_id, user.id, household_id),
  ]);
  if (!mine.meta.changes || !theirs.meta.changes) {
    throw new HttpError(409, "Your partner needs to join before you can set a default split.");
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Reset: permanent deletes, for either member
// ---------------------------------------------------------------------------

/**
 * Permanently delete voided entries and the old versions of edited entries.
 * Active entries are untouched. Recurring rules have already moved past any
 * occurrence that was voided, so a purged occurrence isn't created again.
 */
export async function purgeVoided(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  await readBody(request); // JSON only, like every other write
  // Count the entries themselves: D1's "changes" also counts breakdown rows deleted along with them.
  const res = await env.DB.prepare("DELETE FROM entries WHERE household_id = ? AND voided_at IS NOT NULL RETURNING id")
    .bind(household_id)
    .all();
  return json({ ok: true, deleted: res.results.length });
}

/**
 * Delete every entry and recurring expense in the household. Accounts, the
 * household, its invite code and the default split stay. Needs the word DELETE
 * in the request itself, so nothing can trigger it by accident.
 */
export async function resetHousehold(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  if ((await readBody(request)).confirm !== "DELETE") {
    throw new HttpError(400, 'Type DELETE to confirm.');
  }
  // Uploads and entries first: they point at entries and recurring rules.
  // RETURNING id counts the rows themselves, not the rows deleted along with them.
  const [batches, entries, rules] = await env.DB.batch([
    env.DB.prepare("DELETE FROM spending_batches WHERE household_id = ? RETURNING id").bind(household_id),
    env.DB.prepare("DELETE FROM entries WHERE household_id = ? RETURNING id").bind(household_id),
    env.DB.prepare("DELETE FROM recurring WHERE household_id = ? RETURNING id").bind(household_id),
  ]);
  return json({
    ok: true,
    deletedEntries: entries.results.length,
    deletedRecurring: rules.results.length,
    deletedUploads: batches.results.length,
  });
}
