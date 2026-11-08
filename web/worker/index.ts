// The whole backend: a small JSON API on top of D1. Static files are served by
// Cloudflare before this runs; only /api/* reaches this Worker.

import { INCOME_CATEGORY, isPersonalCategory, isSpendingCategory } from "../shared/categories";
import { owedCents, pctToBasisPoints } from "../shared/owed";
import { dueOccurrences, firstIndexOnOrAfter, FREQUENCIES, occurrenceDate, type Frequency } from "../shared/recurring";

interface Env {
  DB: D1Database;
  /** Most accounts that may ever exist. "2" for the two of you; sign-up closes after that. */
  MAX_USERS?: string;
  /** PBKDF2 work factor for new and changed passwords. See README (CPU limits). */
  PBKDF2_ITERATIONS?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SESSION_DAYS = 60;
const RENEW_WHEN_DAYS_LEFT = 30; // sessions slide: opening the app renews them
const MAX_AMOUNT_CENTS = 100_000_000_00; // $100M, just a sanity cap

function intVar(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
// Default fits the Workers Free plan's 10 ms CPU limit; 100k is the most Workers' WebCrypto allows.
const iterationsFor = (env: Env) => intVar(env.PBKDF2_ITERATIONS, 20_000, 10_000, 100_000);
const maxUsersFor = (env: Env) => intVar(env.MAX_USERS, 2, 1, 1000);

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

const toHex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hashPassword(password: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return toHex(bits);
}

async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200, extraHeaders: [string, string][] = []): Response {
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  for (const [k, v] of extraHeaders) headers.append(k, v);
  return new Response(JSON.stringify(data), { status, headers });
}

/**
 * Cross-site request forgery guard for every POST. The session cookie is
 * SameSite=Lax, which already keeps it off cross-site POSTs; this is the second
 * lock. A page on another site can't send a real application/json request
 * without a CORS preflight (which we never approve), and browsers mark where a
 * request came from in Origin / Sec-Fetch-Site.
 */
function assertSameOrigin(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    throw new HttpError(403, "Cross-site request refused.");
  }
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      /* "null" or garbage */
    }
    if (originHost !== request.headers.get("host")) throw new HttpError(403, "Cross-site request refused.");
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  // Compare the media type exactly: "text/plain; x=application/json" must not pass,
  // because browsers send text/plain cross-site without asking first.
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    throw new HttpError(415, "Expected JSON.");
  }
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "Invalid request body.");
}

function str(body: Record<string, unknown>, field: string, max = 200): string {
  const v = body[field];
  if (typeof v !== "string" || !v.trim() || v.length > max) {
    throw new HttpError(400, `Missing or invalid "${field}".`);
  }
  return v.trim();
}

/** Like str() but leaves the value exactly as typed (passwords must not be trimmed). */
function rawStr(body: Record<string, unknown>, field: string, max = 200): string {
  const v = body[field];
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    throw new HttpError(400, `Missing or invalid "${field}".`);
  }
  return v;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // Round-trip so impossible dates like 2026-02-31 are rejected.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * "Today" in the household's time zone. The app sends its local date so a bill due
 * on the 1st appears on the 1st where you are; anything more than a day away from
 * the server's UTC date is ignored and UTC is used instead.
 */
function todayFor(request: Request, body?: Record<string, unknown>): string {
  const utc = new Date().toISOString().slice(0, 10);
  const claimed = typeof body?.today === "string" ? body.today : new URL(request.url).searchParams.get("today");
  if (claimed && validDate(claimed) && claimed >= addDays(utc, -1) && claimed <= addDays(utc, 1)) return claimed;
  return utc;
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}

// Throttling. Every attempt is logged first and then counted, so a burst of
// parallel requests can't all slip past a check that hasn't seen the others yet.
// A successful attempt clears its bucket afterwards (see clearAttempts).
interface Limit {
  bucket: string;
  max: number;
  window: string; // SQLite modifier, e.g. "-15 minutes"
}

async function throttle(env: Env, ...limits: Limit[]) {
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_attempts WHERE created_at < datetime('now', '-1 day')"),
    ...limits.map((l) => env.DB.prepare("INSERT INTO auth_attempts (bucket) VALUES (?)").bind(l.bucket)),
    ...limits.map((l) =>
      env.DB.prepare(
        "SELECT count(*) AS n FROM auth_attempts WHERE bucket = ? AND created_at > datetime('now', ?)",
      ).bind(l.bucket, l.window),
    ),
  ]);
  const counts = results.slice(1 + limits.length).map((r) => (r.results[0] as { n: number }).n);
  if (counts.some((n, i) => n > limits[i].max)) {
    throw new HttpError(429, "Too many attempts. Wait a few minutes and try again.");
  }
}

async function clearAttempts(env: Env, bucket: string) {
  await env.DB.prepare("DELETE FROM auth_attempts WHERE bucket = ?").bind(bucket).run();
}

// On https the cookie is named __Host-session: browsers then refuse it unless it is
// Secure, host-only and Path=/, so nothing else (e.g. a sibling subdomain) can set it.
// Plain http (local dev) can't use the prefix, so it keeps the plain name.
// LEGACY_COOKIE is read too, so sessions from before the rename keep working;
// /api/me moves them to the new name. It can be removed once everyone has opened the app.
const HOST_COOKIE = "__Host-session";
const LEGACY_COOKIE = "session";

const isHttps = (request: Request) => new URL(request.url).protocol === "https:";

function sessionCookie(request: Request, value: string, maxAgeSeconds: number, name?: string): string {
  const cookieName = name ?? (isHttps(request) ? HOST_COOKIE : LEGACY_COOKIE);
  const secure = isHttps(request) ? "; Secure" : "";
  return `${cookieName}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function sessionToken(request: Request): string | null {
  return cookieValue(request, HOST_COOKIE) ?? cookieValue(request, LEGACY_COOKIE);
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

interface User {
  id: string;
  email: string;
}

interface Session {
  user: User;
  token: string;
  tokenHash: string;
  daysLeft: number;
}

async function currentSession(request: Request, env: Env): Promise<Session | null> {
  const token = sessionToken(request);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, julianday(s.expires_at) - julianday('now') AS days_left
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
  )
    .bind(tokenHash)
    .first<{ id: string; email: string; days_left: number }>();
  if (!row) return null;
  return { user: { id: row.id, email: row.email }, token, tokenHash, daysLeft: row.days_left };
}

async function currentUser(request: Request, env: Env): Promise<User | null> {
  return (await currentSession(request, env))?.user ?? null;
}

async function requireUser(request: Request, env: Env): Promise<User> {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "Not signed in.");
  return user;
}

async function membershipOf(env: Env, userId: string) {
  return env.DB.prepare("SELECT household_id, display_name FROM members WHERE user_id = ?")
    .bind(userId)
    .first<{ household_id: string; display_name: string }>();
}

async function requireMembership(env: Env, userId: string) {
  const m = await membershipOf(env, userId);
  if (!m) throw new HttpError(403, "You're not in a household yet.");
  return m;
}

async function startSession(request: Request, env: Env, userId: string): Promise<Response> {
  const token = randomHex(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),
    env.DB.prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))",
    ).bind(await sha256Hex(token), userId, `+${SESSION_DAYS} days`),
  ]);
  return json({ ok: true }, 200, [["set-cookie", sessionCookie(request, token, SESSION_DAYS * 86400)]]);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function checkNewPassword(password: string) {
  if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");
}

async function signup(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  const email = str(body, "email").toLowerCase();
  const password = rawStr(body, "password", 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email.");
  checkNewPassword(password);

  await throttle(env, { bucket: `signup-ip:${clientIp(request)}`, max: 10, window: "-1 hour" });

  const id = crypto.randomUUID();
  const salt = randomHex(16);
  const iterations = iterationsFor(env);
  const hash = await hashPassword(password, salt, iterations);
  let res;
  try {
    // The cap check and the insert are one statement, so two sign-ups can't race past it.
    res = await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, password_salt, password_iterations)
       SELECT ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM users) < ?`,
    )
      .bind(id, email, hash, salt, iterations, maxUsersFor(env))
      .run();
  } catch (err) {
    // Only a duplicate email is the user's problem; anything else is a real server error.
    if (isUniqueViolation(err)) throw new HttpError(409, "That email already has an account. Try signing in.");
    throw err;
  }
  if (!res.meta.changes) throw new HttpError(403, "Sign-ups are closed.");
  return startSession(request, env, id);
}

interface PasswordRow {
  id: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
}

/** Checks a password; on success, quietly upgrades the stored hash if the work factor changed. */
async function verifyPassword(env: Env, row: PasswordRow | null, password: string): Promise<boolean> {
  // Hash even when the user doesn't exist so timing doesn't reveal which emails have accounts.
  const hash = await hashPassword(
    password,
    row?.password_salt ?? "00".repeat(16),
    row?.password_iterations ?? iterationsFor(env),
  );
  if (!row || !safeEqual(hash, row.password_hash)) return false;
  if (row.password_iterations !== iterationsFor(env)) await setPassword(env, row.id, password);
  return true;
}

async function setPassword(env: Env, userId: string, password: string) {
  const salt = randomHex(16);
  const iterations = iterationsFor(env);
  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?",
  )
    .bind(await hashPassword(password, salt, iterations), salt, iterations, userId)
    .run();
}

const PASSWORD_COLUMNS = "id, password_hash, password_salt, password_iterations";

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  const email = str(body, "email").toLowerCase();
  const password = rawStr(body, "password", 200);
  const emailBucket = `login:${email}`;
  await throttle(
    env,
    { bucket: emailBucket, max: 10, window: "-15 minutes" },
    { bucket: `login-ip:${clientIp(request)}`, max: 30, window: "-15 minutes" },
  );

  const row = await env.DB.prepare(`SELECT ${PASSWORD_COLUMNS} FROM users WHERE email = ?`)
    .bind(email)
    .first<PasswordRow>();
  if (!(await verifyPassword(env, row, password))) throw new HttpError(401, "Wrong email or password.");
  await clearAttempts(env, emailBucket);
  return startSession(request, env, row!.id);
}

async function changePassword(request: Request, env: Env): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) throw new HttpError(401, "Not signed in.");
  const body = await readBody(request);
  const current = rawStr(body, "current", 200);
  const next = rawStr(body, "next", 200);
  checkNewPassword(next);

  const bucket = `password:${session.user.id}`;
  await throttle(env, { bucket, max: 10, window: "-15 minutes" });
  const row = await env.DB.prepare(`SELECT ${PASSWORD_COLUMNS} FROM users WHERE id = ?`)
    .bind(session.user.id)
    .first<PasswordRow>();
  if (!(await verifyPassword(env, row, current))) throw new HttpError(400, "Your current password is wrong.");
  await clearAttempts(env, bucket);

  await setPassword(env, session.user.id, next);
  // Sign out every other device; this one stays signed in.
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
    .bind(session.user.id, session.tokenHash)
    .run();
  return json({ ok: true });
}

async function logout(request: Request, env: Env): Promise<Response> {
  const token = sessionToken(request);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await sha256Hex(token))
      .run();
  }
  const clear: [string, string][] = [["set-cookie", sessionCookie(request, "", 0)]];
  if (isHttps(request)) clear.push(["set-cookie", sessionCookie(request, "", 0, LEGACY_COOKIE)]);
  return json({ ok: true }, 200, clear);
}

async function me(request: Request, env: Env): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return json({ user: null });
  const body = { user: session.user, membership: (await membershipOf(env, session.user.id)) ?? null };

  // Sliding sessions: the app calls this every time it opens, so regular use never logs you out.
  const renew = session.daysLeft < RENEW_WHEN_DAYS_LEFT;
  // A session still under the old cookie name gets moved to the __Host- name.
  const migrate = isHttps(request) && !cookieValue(request, HOST_COOKIE);
  if (!renew && !migrate) return json(body);

  if (renew) {
    await env.DB.prepare("UPDATE sessions SET expires_at = datetime('now', ?) WHERE token_hash = ?")
      .bind(`+${SESSION_DAYS} days`, session.tokenHash)
      .run();
  }
  const maxAge = renew ? SESSION_DAYS * 86400 : Math.floor(session.daysLeft * 86400);
  const headers: [string, string][] = [["set-cookie", sessionCookie(request, session.token, maxAge)]];
  if (migrate) headers.push(["set-cookie", sessionCookie(request, "", 0, LEGACY_COOKIE)]);
  return json(body, 200, headers);
}

async function createHousehold(request: Request, env: Env): Promise<Response> {
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

async function joinHousehold(request: Request, env: Env): Promise<Response> {
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

async function getHousehold(request: Request, env: Env): Promise<Response> {
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

async function addEntry(request: Request, env: Env): Promise<Response> {
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
        crypto.randomUUID(), household_id, e.kind, e.entryDate, e.name, e.amount, e.payerId, e.pct, e.owed, user.id,
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
async function editEntry(request: Request, env: Env, id: string): Promise<Response> {
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
      newId, household_id, e.kind, e.entryDate, e.name, e.amount, e.payerId, e.pct, e.owed, user.id, e.category,
      id, newId,
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
async function unvoidEntry(request: Request, env: Env, id: string): Promise<Response> {
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

/** Set the default split: my share and my partner's (the rest) together. */
async function setSplit(request: Request, env: Env): Promise<Response> {
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

async function voidEntry(request: Request, env: Env, id: string): Promise<Response> {
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

// ---------------------------------------------------------------------------
// Recurring expenses
// ---------------------------------------------------------------------------

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
async function addDueRecurring(env: Env, householdId: string, today: string) {
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

async function createRecurring(request: Request, env: Env): Promise<Response> {
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
async function updateRecurring(request: Request, env: Env, id: string): Promise<Response> {
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
async function stopRecurring(request: Request, env: Env, id: string): Promise<Response> {
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

// ---------------------------------------------------------------------------
// Statement imports: totals per (month, category) only
// ---------------------------------------------------------------------------

const MAX_MONTHS = 13;
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
  if (months.length === 0 || months.length > MAX_MONTHS) throw new HttpError(400, `${label}: invalid number of months.`);
  const rows: TotalRow[] = [];
  for (const [month, cats] of months) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < start.slice(0, 7) || month > end.slice(0, 7)) {
      throw new HttpError(400, `${label}: month ${month} is outside the statement's dates.`);
    }
    if (!cats || typeof cats !== "object" || Array.isArray(cats)) throw new HttpError(400, `${label}: invalid month ${month}.`);
    const entries = Object.entries(cats as Record<string, unknown>);
    if (entries.length === 0 || entries.length > MAX_CATEGORIES_PER_MONTH) {
      throw new HttpError(400, `${label}: invalid categories in ${month}.`);
    }
    for (const [category, cents] of entries) {
      if (!allowed(category)) throw new HttpError(400, `${label}: unknown category "${category}".`);
      if (!Number.isInteger(cents) || Math.abs(cents as number) > MAX_AMOUNT_CENTS) {
        throw new HttpError(400, `${label}: invalid amount for ${category} in ${month}.`);
      }
      if (category === INCOME_CATEGORY && (cents as number) < 0) throw new HttpError(400, `${label}: income can't be negative.`);
      rows.push({ month, category, cents: cents as number });
    }
  }
  return rows;
}

/** INSERT ... VALUES (...), (...) in chunks small enough for D1. */
function insertTotals(env: Env, table: "entry_breakdown" | "spending_totals", ownerColumn: string, ownerId: string, rows: TotalRow[]) {
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
async function importStatement(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  const body = await readBody(request);

  const name = str(body, "name", 200);
  const start = str(body, "start", 10);
  const end = str(body, "end", 10);
  if (!validDate(start) || !validDate(end) || start > end) throw new HttpError(400, "Invalid statement dates.");
  if (!body.shared && !body.personal) throw new HttpError(400, "Nothing to import.");

  const isMember = async (id: unknown) =>
    typeof id === "string" &&
    Boolean(
      await env.DB.prepare("SELECT 1 FROM members WHERE household_id = ? AND user_id = ?").bind(household_id, id).first(),
    );

  const statements: D1PreparedStatement[] = [];
  const entryId = body.shared ? crypto.randomUUID() : null;
  const batchId = body.personal ? crypto.randomUUID() : null;

  if (body.shared) {
    const shared = body.shared as Record<string, unknown>;
    const rows = validateMonths(shared.months, start, end, isSpendingCategory, "Shared");
    const total = rows.reduce((sum, r) => sum + r.cents, 0);
    if (!Number.isInteger(shared.total_cents) || shared.total_cents !== total || total <= 0 || total > MAX_AMOUNT_CENTS) {
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
      ).bind(entryId, household_id, todayFor(request, body), name, total, shared.payer_id, bp / 100,
        owedCents("expense", total, bp / 100), user.id),
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
async function getSpending(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  const [batches, totals, breakdown] = await env.DB.batch([
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
  ]);
  return json({ batches: batches.results, totals: totals.results, breakdown: breakdown.results });
}

/**
 * Move money between two spending categories within one month of one upload
 * (personal) or one imported shared entry, e.g. $700 of a Costco run from
 * groceries to household. The source's total doesn't change, so neither does
 * the ledger balance. Still totals only: nothing about the purchase is stored.
 */
async function moveSpending(request: Request, env: Env): Promise<Response> {
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
      ? await env.DB.prepare("SELECT id FROM spending_batches WHERE id = ? AND household_id = ?").bind(id, household_id).first()
      : await env.DB.prepare("SELECT id FROM entries WHERE id = ? AND household_id = ? AND voided_at IS NULL").bind(id, household_id).first();
  if (!owner) throw new HttpError(404, kind === "upload" ? "Upload not found." : "Entry not found or voided.");

  const [table, col] = kind === "upload" ? ["spending_totals", "batch_id"] : ["entry_breakdown", "entry_id"];
  const row = await env.DB.prepare(`SELECT cents FROM ${table} WHERE ${col} = ? AND month = ? AND category = ?`)
    .bind(id, month, from)
    .first<{ cents: number }>();
  const have = row?.cents ?? 0;
  if (have < (cents as number)) {
    throw new HttpError(400, `There's only $${(Math.max(0, have) / 100).toFixed(2)} in ${from} for that month to move.`);
  }

  // One transaction. The take only happens if the amount is still what we read, and
  // the give only if the take happened, so two people moving at once can't double up.
  const left = have - (cents as number);
  const [taken] = await env.DB.batch([
    env.DB.prepare(`UPDATE ${table} SET cents = ? WHERE ${col} = ? AND month = ? AND category = ? AND cents = ?`)
      .bind(left, id, month, from, have),
    env.DB.prepare(
      `INSERT INTO ${table} (${col}, month, category, cents)
       SELECT ?, ?, ?, ? WHERE changes() = 1
       ON CONFLICT (${col}, month, category) DO UPDATE SET cents = cents + excluded.cents`,
    ).bind(id, month, to, cents),
    env.DB.prepare(`DELETE FROM ${table} WHERE ${col} = ? AND month = ? AND category = ? AND cents = 0`).bind(id, month, from),
  ]);
  if (!taken.meta.changes) throw new HttpError(409, "That changed in the meantime. Try again.");
  return json({ ok: true });
}

/** Undo a personal upload. (The shared entry from the same import, if any, is voided separately.) */
async function deleteBatch(request: Request, env: Env, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  const { household_id } = await requireMembership(env, user.id);
  const res = await env.DB.prepare("DELETE FROM spending_batches WHERE id = ? AND household_id = ?")
    .bind(id, household_id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, "Upload not found.");
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
async function purgeVoided(request: Request, env: Env): Promise<Response> {
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
async function resetHousehold(request: Request, env: Env): Promise<Response> {
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

// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    try {
      if (method === "GET" && pathname === "/api/me") return await me(request, env);
      if (method === "GET" && pathname === "/api/household") return await getHousehold(request, env);
      if (method === "GET" && pathname === "/api/spending") return await getSpending(request, env);
      if (method === "POST") {
        assertSameOrigin(request);
        if (pathname === "/api/password") return await changePassword(request, env);
        if (pathname === "/api/signup") return await signup(request, env);
        if (pathname === "/api/login") return await login(request, env);
        if (pathname === "/api/logout") return await logout(request, env);
        if (pathname === "/api/household") return await createHousehold(request, env);
        if (pathname === "/api/household/join") return await joinHousehold(request, env);
        if (pathname === "/api/household/split") return await setSplit(request, env);
        if (pathname === "/api/household/purge-voided") return await purgeVoided(request, env);
        if (pathname === "/api/household/reset") return await resetHousehold(request, env);
        if (pathname === "/api/statements/import") return await importStatement(request, env);
        if (pathname === "/api/spending/move") return await moveSpending(request, env);
        const b = pathname.match(/^\/api\/statements\/([\w-]+)\/delete$/);
        if (b) return await deleteBatch(request, env, b[1]);
        if (pathname === "/api/recurring") return await createRecurring(request, env);
        const r = pathname.match(/^\/api\/recurring\/([\w-]+)\/(update|stop)$/);
        if (r?.[2] === "update") return await updateRecurring(request, env, r[1]);
        if (r?.[2] === "stop") return await stopRecurring(request, env, r[1]);
        if (pathname === "/api/entries") return await addEntry(request, env);
        const m = pathname.match(/^\/api\/entries\/([\w-]+)\/(void|unvoid|edit)$/);
        if (m?.[2] === "void") return await voidEntry(request, env, m[1]);
        if (m?.[2] === "unvoid") return await unvoidEntry(request, env, m[1]);
        if (m?.[2] === "edit") return await editEntry(request, env, m[1]);
      }
      throw new HttpError(404, "Not found.");
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Something went wrong on the server." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
