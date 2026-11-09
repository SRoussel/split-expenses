// Accounts and sessions: passwords, sign-in throttling, cookies, and the auth routes.

import { clientIp, type Env, HttpError, isUniqueViolation, iterationsFor, json, maxUsersFor, rawStr, readBody, str } from "./http";

const SESSION_DAYS = 60;
const RENEW_WHEN_DAYS_LEFT = 30; // sessions slide: opening the app renews them

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

const toHex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function randomHex(bytes: number): string {
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

// Throttling. Every attempt is logged first and then counted, so a burst of
// parallel requests can't all slip past a check that hasn't seen the others yet.
// A successful attempt clears its bucket afterwards (see clearAttempts).
interface Limit {
  bucket: string;
  max: number;
  window: string; // SQLite modifier, e.g. "-15 minutes"
}

export async function throttle(env: Env, ...limits: Limit[]) {
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

export async function clearAttempts(env: Env, bucket: string) {
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

export interface Session {
  user: User;
  token: string;
  tokenHash: string;
  daysLeft: number;
  /** Minutes since this session last proved who it is, or null if it never has. */
  confirmedMinutesAgo: number | null;
}

export async function currentSession(request: Request, env: Env): Promise<Session | null> {
  const token = sessionToken(request);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, julianday(s.expires_at) - julianday('now') AS days_left,
            (julianday('now') - julianday(s.confirmed_at)) * 1440 AS confirmed_minutes_ago
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
  )
    .bind(tokenHash)
    .first<{ id: string; email: string; days_left: number; confirmed_minutes_ago: number | null }>();
  if (!row) return null;
  return {
    user: { id: row.id, email: row.email },
    token,
    tokenHash,
    daysLeft: row.days_left,
    confirmedMinutesAgo: row.confirmed_minutes_ago,
  };
}

async function currentUser(request: Request, env: Env): Promise<User | null> {
  return (await currentSession(request, env))?.user ?? null;
}

export async function requireUser(request: Request, env: Env): Promise<User> {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "Not signed in.");
  return user;
}

export async function membershipOf(env: Env, userId: string) {
  return env.DB.prepare("SELECT household_id, display_name FROM members WHERE user_id = ?")
    .bind(userId)
    .first<{ household_id: string; display_name: string }>();
}

export async function requireMembership(env: Env, userId: string) {
  const m = await membershipOf(env, userId);
  if (!m) throw new HttpError(403, "You're not in a household yet.");
  return m;
}

export async function startSession(request: Request, env: Env, userId: string): Promise<Response> {
  const token = randomHex(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),
    env.DB.prepare(
      // Signing in counts as proving who you are, so the session starts out confirmed.
      "INSERT INTO sessions (token_hash, user_id, expires_at, confirmed_at) VALUES (?, ?, datetime('now', ?), datetime('now'))",
    ).bind(await sha256Hex(token), userId, `+${SESSION_DAYS} days`),
  ]);
  return json({ ok: true }, 200, [["set-cookie", sessionCookie(request, token, SESSION_DAYS * 86400)]]);
}

export function checkNewPassword(password: string) {
  if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");
}

export async function signup(request: Request, env: Env): Promise<Response> {
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

export interface PasswordRow {
  id: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  password_disabled: number;
}

/** Checks a password; on success, quietly upgrades the stored hash if the work factor changed. */
export async function verifyPassword(env: Env, row: PasswordRow | null, password: string): Promise<boolean> {
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

/** Sets a new password and turns password sign-in (back) on. */
export async function setPassword(env: Env, userId: string, password: string) {
  const salt = randomHex(16);
  const iterations = iterationsFor(env);
  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, password_disabled = 0 WHERE id = ?",
  )
    .bind(await hashPassword(password, salt, iterations), salt, iterations, userId)
    .run();
}

export const PASSWORD_COLUMNS = "id, password_hash, password_salt, password_iterations, password_disabled";
const PASSWORD_OFF = "Password sign-in is turned off for this account. Sign in with your passkey.";

export async function login(request: Request, env: Env): Promise<Response> {
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
  // A passkey-only account has no usable password (its hash was replaced with random
  // bytes), so say so instead of "wrong password". Learning that an email is passkey-only
  // doesn't help an attacker: there's no password left to guess.
  if (row?.password_disabled) throw new HttpError(401, PASSWORD_OFF);
  if (!(await verifyPassword(env, row, password))) throw new HttpError(401, "Wrong email or password.");
  await clearAttempts(env, emailBucket);
  return startSession(request, env, row!.id);
}

export async function changePassword(request: Request, env: Env): Promise<Response> {
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
  if (row?.password_disabled) throw new HttpError(409, "Password sign-in is turned off. Turn it back on in More first.");
  if (!(await verifyPassword(env, row, current))) throw new HttpError(400, "Your current password is wrong.");
  await clearAttempts(env, bucket);

  await setPassword(env, session.user.id, next);
  // Sign out every other device; this one stays signed in.
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
    .bind(session.user.id, session.tokenHash)
    .run();
  return json({ ok: true });
}

export async function logout(request: Request, env: Env): Promise<Response> {
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

export async function me(request: Request, env: Env): Promise<Response> {
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
