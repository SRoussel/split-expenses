// Desktop keys: how the desktop app (split-insights) sends statement summaries straight
// here instead of as a file. A key is made on the computer with `npm run desktop-key`,
// which needs the Cloudflare login that deploys the app, so it adds no new way in.
//
// A key works only on the routes in this file, and only for statement uploads and
// budgets: list uploads, import one, replace one, and replace the household's budgets
// (which are set on the desktop page). It can't add expenses, change other settings or sign in.
// It travels in an Authorization header, which browsers never attach on their own, so
// these routes don't need the cross-site checks that cookie sessions do; and cookies
// are never accepted here. Only a hash is stored. Keys expire after a year and can be
// revoked in the app (More > Passkeys and sign-in).

import { requireMembership, requireUser, sha256Hex } from "./auth";
import { type Env, HttpError, json, readBody } from "./http";
import { budgetStatements, importFor } from "./spending";

const KEY_FORMAT = /^Bearer (split_[A-Za-z0-9_-]{43})$/;

async function requireKey(request: Request, env: Env) {
  const match = KEY_FORMAT.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new HttpError(401, "This needs a desktop key. Make one with `npm run desktop-key`.");
  const keyHash = await sha256Hex(match[1]);
  const row = await env.DB.prepare(
    "SELECT id, user_id FROM desktop_keys WHERE key_hash = ? AND expires_at > datetime('now')",
  )
    .bind(keyHash)
    .first<{ id: string; user_id: string }>();
  if (!row)
    throw new HttpError(401, "This desktop key was revoked or has expired. Make a new one with `npm run desktop-key`.");
  await env.DB.prepare("UPDATE desktop_keys SET last_used_at = datetime('now') WHERE id = ?").bind(row.id).run();
  const { household_id } = await requireMembership(env, row.user_id);
  return { userId: row.user_id, household_id };
}

/** Who's in the household (and their default shares), and every statement upload so far. */
export async function desktopHousehold(request: Request, env: Env): Promise<Response> {
  const { userId, household_id } = await requireKey(request, env);
  const [members, batches, sharedOnly] = await env.DB.batch([
    env.DB.prepare("SELECT user_id, display_name, share_pct FROM members WHERE household_id = ?").bind(household_id),
    env.DB.prepare(
      `SELECT b.id, b.person_id, b.name, b.start_date AS start, b.end_date AS end, b.created_at,
              (e.id IS NOT NULL AND e.voided_at IS NULL) AS has_shared
       FROM spending_batches b LEFT JOIN entries e ON e.id = b.entry_id
       WHERE b.household_id = ? ORDER BY b.start_date`,
    ).bind(household_id),
    // Imports with only a shared part leave no upload, just the ledger entry and its breakdown.
    env.DB.prepare(
      `SELECT e.id, e.payer_id AS person_id, e.name, min(t.month) || '-01' AS start, max(t.month) || '-31' AS end,
              e.created_at, 1 AS has_shared
       FROM entries e JOIN entry_breakdown t ON t.entry_id = e.id
       WHERE e.household_id = ? AND e.voided_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM spending_batches b WHERE b.entry_id = e.id)
         AND e.upload_of IS NULL -- a split that came with another upload
       GROUP BY e.id ORDER BY start`,
    ).bind(household_id),
  ]);
  return json({
    me: userId,
    members: members.results,
    uploads: [...batches.results, ...sharedOnly.results].map((u) => ({
      ...(u as Record<string, unknown>),
      has_shared: Boolean((u as { has_shared: number }).has_shared),
    })),
  });
}

/** Import a statement summary: exactly what the app's own import does. */
export async function desktopImport(request: Request, env: Env): Promise<Response> {
  const { userId, household_id } = await requireKey(request, env);
  return importFor(request, env, userId, household_id, await readBody(request));
}

/** Replace the household's budgets with the desktop page's, between statement uploads. */
export async function desktopBudgets(request: Request, env: Env): Promise<Response> {
  const { userId, household_id } = await requireKey(request, env);
  await env.DB.batch(budgetStatements(env, household_id, userId, (await readBody(request)).budgets));
  return json({ ok: true });
}

/**
 * Take an upload back out, to send a corrected one: its spending totals are deleted, and
 * the shared expense it added to the ledger is voided (so it still shows, crossed out).
 */
export async function desktopRemove(request: Request, env: Env, id: string): Promise<Response> {
  const { userId, household_id } = await requireKey(request, env);
  const batch = await env.DB.prepare("SELECT entry_id FROM spending_batches WHERE id = ? AND household_id = ?")
    .bind(id, household_id)
    .first<{ entry_id: string | null }>();
  const entryId = batch ? batch.entry_id : id;
  // Its shared expense, and any at their own split that came with it.
  const voidEntry = env.DB.prepare(
    `UPDATE entries SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), voided_by = ?
     WHERE (id = ? OR upload_of = ?) AND household_id = ? AND voided_at IS NULL
       AND EXISTS (SELECT 1 FROM entry_breakdown WHERE entry_id = entries.id)`,
  ).bind(userId, entryId, id, household_id);
  const results = await env.DB.batch(
    batch
      ? [
          env.DB.prepare("DELETE FROM spending_batches WHERE id = ? AND household_id = ?").bind(id, household_id),
          voidEntry,
        ]
      : [voidEntry],
  );
  if (!batch && !results[0].meta.changes) throw new HttpError(404, "Upload not found.");
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// For the app itself (signed in): seeing and revoking keys
// ---------------------------------------------------------------------------

export async function listDesktopKeys(env: Env, userId: string) {
  const res = await env.DB.prepare(
    "SELECT id, name, created_at, last_used_at, expires_at FROM desktop_keys WHERE user_id = ? ORDER BY created_at",
  )
    .bind(userId)
    .all();
  return res.results;
}

/** Revoking needs no fresh confirmation: it only ever takes access away. */
export async function revokeDesktopKey(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  const res = await env.DB.prepare("DELETE FROM desktop_keys WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  if (!res.meta.changes) throw new HttpError(404, "Key not found.");
  return json({ ok: true });
}
