// Passkeys: sign in with Face ID / Touch ID. The phone keeps a private key; this server
// only ever stores the matching public key, which can check signatures but not make them.
//
// Every passkey ceremony is challenge-response:
//   1. "options": the server makes 32 random bytes, stores them for 5 minutes, sends them.
//   2. The device asks for Face ID, then signs the challenge together with the web address
//      it's really on and a hash of this site's domain.
//   3. "verify": the library checks the signature, the address, the domain hash and the
//      Face ID flag; the challenge is deleted as it's checked, so it works exactly once.
//
// Sensitive account changes (adding or removing a passkey, turning password sign-in off or
// on) also need the session to have proved who it is in the last few minutes: by signing
// in, or by confirming with the password or a passkey (POST /api/confirm). That way a stolen
// session cookie can't quietly add the thief's own passkey.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import {
  clearAttempts,
  currentSession,
  PASSWORD_COLUMNS,
  type PasswordRow,
  randomHex,
  type Session,
  setPassword,
  startSession,
  checkNewPassword,
  throttle,
  verifyPassword,
} from "./auth";
import { clientIp, type Env, HttpError, json, readBody, rawStr } from "./http";

const RP_NAME = "Split";
const CHALLENGE_MINUTES = 5;
/** How long a confirmation lasts for sensitive changes. */
const CONFIRM_MINUTES = 5;
const MAX_PASSKEYS = 10;

type Purpose = "register" | "login" | "confirm";

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: string;
  sign_count: number;
  transports: string | null;
}

/**
 * The domain passkeys belong to, and the web addresses allowed to use them. Passkeys are
 * tied to the hostname, so they keep working across deploys but not on a different domain.
 * In local development the app runs on Vite's port and the API on Wrangler's, so both count.
 */
function relyingParty(request: Request) {
  const url = new URL(request.url);
  const origins = [url.origin];
  if (url.hostname === "localhost") origins.push("http://localhost:5173");
  return { rpID: url.hostname, origins };
}

async function requireSession(request: Request, env: Env): Promise<Session> {
  const session = await currentSession(request, env);
  if (!session) throw new HttpError(401, "Not signed in.");
  return session;
}

/** Sensitive changes need a recent sign-in or confirmation; the app then asks you to confirm. */
function requireConfirmed(session: Session) {
  if (session.confirmedMinutesAgo === null || session.confirmedMinutesAgo > CONFIRM_MINUTES) {
    throw new HttpError(403, "Confirm it's you first.", "confirm");
  }
}

async function markConfirmed(env: Env, session: Session) {
  await env.DB.prepare("UPDATE sessions SET confirmed_at = datetime('now') WHERE token_hash = ?")
    .bind(session.tokenHash)
    .run();
}

async function issueChallenge(env: Env, purpose: Purpose, userId: string | null): Promise<string> {
  const challenge = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= datetime('now')"),
    env.DB.prepare(
      "INSERT INTO auth_challenges (challenge, user_id, purpose, expires_at) VALUES (?, ?, ?, datetime('now', ?))",
    ).bind(challenge, userId, purpose, `+${CHALLENGE_MINUTES} minutes`),
  ]);
  return challenge;
}

/**
 * Used as the library's expectedChallenge check: true only for a challenge this server issued,
 * for this purpose and person, that hasn't expired. It's deleted in the same statement, so two
 * requests racing with the same response can't both succeed.
 */
function takeChallenge(env: Env, purpose: Purpose, userId: string | null) {
  return async (challenge: string) => {
    const row = await env.DB.prepare(
      `DELETE FROM auth_challenges
       WHERE challenge = ? AND purpose = ? AND user_id IS ? AND expires_at > datetime('now')
       RETURNING challenge`,
    )
      .bind(challenge, purpose, userId)
      .first();
    return row !== null;
  };
}

/** The library throws on anything malformed or not matching; turn that into a plain 400/401. */
async function checked<T>(status: number, message: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.warn("passkey check failed:", err instanceof Error ? err.message : err);
    throw new HttpError(status, message);
  }
}

function credentialBody(body: Record<string, unknown>): Record<string, unknown> {
  const response = body.response;
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new HttpError(400, 'Missing or invalid "response".');
  }
  return response as Record<string, unknown>;
}

async function passkeyById(env: Env, id: unknown): Promise<PasskeyRow | null> {
  if (typeof id !== "string" || id.length > 1024) return null;
  return env.DB.prepare("SELECT id, user_id, public_key, sign_count, transports FROM passkeys WHERE id = ?")
    .bind(id)
    .first<PasskeyRow>();
}

/** Checks a sign-in style response (sign-in or confirm) against a stored passkey and records its use. */
async function verifyAssertion(
  request: Request,
  env: Env,
  response: AuthenticationResponseJSON,
  passkey: PasskeyRow,
  purpose: Purpose,
  userId: string | null,
) {
  const { rpID, origins } = relyingParty(request);
  const result = await checked(401, "That passkey couldn't be checked. Try again.", () =>
    verifyAuthenticationResponse({
      response,
      expectedChallenge: takeChallenge(env, purpose, userId),
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: passkey.id,
        publicKey: isoBase64URL.toBuffer(passkey.public_key),
        counter: passkey.sign_count,
        transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
      },
    }),
  );
  if (!result.verified) throw new HttpError(401, "That passkey couldn't be checked. Try again.");
  await env.DB.prepare("UPDATE passkeys SET sign_count = ?, last_used_at = datetime('now') WHERE id = ?")
    .bind(result.authenticationInfo.newCounter, passkey.id)
    .run();
}

// ---------------------------------------------------------------------------
// Account: what the More screen shows
// ---------------------------------------------------------------------------

export async function getAccount(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const [user, passkeys] = await env.DB.batch([
    env.DB.prepare("SELECT password_disabled FROM users WHERE id = ?").bind(session.user.id),
    env.DB.prepare(
      "SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at",
    ).bind(session.user.id),
  ]);
  return json({
    passwordEnabled: !(user.results[0] as { password_disabled: number }).password_disabled,
    passkeys: passkeys.results,
  });
}

// ---------------------------------------------------------------------------
// Adding a passkey (signed in, recently confirmed)
// ---------------------------------------------------------------------------

export async function registerOptions(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  requireConfirmed(session);
  await readBody(request);
  const existing = await env.DB.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?")
    .bind(session.user.id)
    .all<{ id: string; transports: string | null }>();
  if (existing.results.length >= MAX_PASSKEYS)
    throw new HttpError(409, `You can have at most ${MAX_PASSKEYS} passkeys.`);

  const { rpID } = relyingParty(request);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: session.user.email,
    // The user handle the device stores with the passkey: our random user id, nothing personal.
    userID: new Uint8Array(new TextEncoder().encode(session.user.id)),
    challenge: isoBase64URL.toBuffer(await issueChallenge(env, "register", session.user.id)),
    attestationType: "none",
    // Don't make a second passkey on a device that already has one for this account.
    excludeCredentials: existing.results.map((p) => ({
      id: p.id,
      transports: p.transports ? JSON.parse(p.transports) : undefined,
    })),
    // A "discoverable" passkey, so you can sign in without typing your email; Face ID required.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  return json(options);
}

export async function registerVerify(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  requireConfirmed(session);
  const body = await readBody(request);
  const response = credentialBody(body) as unknown as RegistrationResponseJSON;
  const rawName = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  const { rpID, origins } = relyingParty(request);

  const result = await checked(400, "That passkey couldn't be added. Try again.", () =>
    verifyRegistrationResponse({
      response,
      expectedChallenge: takeChallenge(env, "register", session.user.id),
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
    }),
  );
  if (!result.verified) throw new HttpError(400, "That passkey couldn't be added. Try again.");
  const { credential } = result.registrationInfo;
  try {
    await env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, sign_count, transports, name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        credential.id,
        session.user.id,
        isoBase64URL.fromBuffer(credential.publicKey),
        credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null,
        rawName || "Passkey",
      )
      .run();
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      throw new HttpError(409, "That passkey is already added.");
    }
    throw err;
  }
  return json({ ok: true }, 201);
}

// ---------------------------------------------------------------------------
// Signing in with a passkey (not signed in)
// ---------------------------------------------------------------------------

export async function loginOptions(request: Request, env: Env): Promise<Response> {
  await readBody(request);
  await throttle(env, { bucket: `passkey-ip:${clientIp(request)}`, max: 60, window: "-15 minutes" });
  const { rpID } = relyingParty(request);
  const options = await generateAuthenticationOptions({
    rpID,
    // Empty: the device offers whichever passkey it has for this site, no email needed.
    allowCredentials: [],
    userVerification: "required",
    challenge: isoBase64URL.toBuffer(await issueChallenge(env, "login", null)),
  });
  return json(options);
}

export async function loginVerify(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  const bucket = `passkey-ip:${clientIp(request)}`;
  await throttle(env, { bucket, max: 60, window: "-15 minutes" });
  const response = credentialBody(body) as unknown as AuthenticationResponseJSON;
  const passkey = await passkeyById(env, response.id);
  if (!passkey) {
    throw new HttpError(401, "That passkey isn't set up for this app any more. Sign in another way and add it again.");
  }
  // The device also says which account the passkey was made for; it must be the same one.
  const handle = (response.response as { userHandle?: unknown } | undefined)?.userHandle;
  if (typeof handle === "string" && new TextDecoder().decode(isoBase64URL.toBuffer(handle)) !== passkey.user_id) {
    throw new HttpError(401, "That passkey couldn't be checked. Try again.");
  }
  await verifyAssertion(request, env, response, passkey, "login", null);
  await clearAttempts(env, bucket);
  return startSession(request, env, passkey.user_id);
}

// ---------------------------------------------------------------------------
// Confirming it's you (signed in): password, or a passkey
// ---------------------------------------------------------------------------

export async function confirmOptions(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  await readBody(request);
  const mine = await env.DB.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?")
    .bind(session.user.id)
    .all<{ id: string; transports: string | null }>();
  if (!mine.results.length) throw new HttpError(409, "You don't have a passkey yet. Confirm with your password.");
  const { rpID } = relyingParty(request);
  const options = await generateAuthenticationOptions({
    rpID,
    // Only this person's own passkeys can confirm.
    allowCredentials: mine.results.map((p) => ({
      id: p.id,
      transports: p.transports ? JSON.parse(p.transports) : undefined,
    })),
    userVerification: "required",
    challenge: isoBase64URL.toBuffer(await issueChallenge(env, "confirm", session.user.id)),
  });
  return json(options);
}

export async function confirm(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const body = await readBody(request);
  const bucket = `confirm:${session.user.id}`;
  await throttle(env, { bucket, max: 10, window: "-15 minutes" });

  if (body.response !== undefined) {
    const response = credentialBody(body) as unknown as AuthenticationResponseJSON;
    const passkey = await passkeyById(env, response.id);
    if (!passkey || passkey.user_id !== session.user.id) throw new HttpError(401, "That passkey isn't one of yours.");
    await verifyAssertion(request, env, response, passkey, "confirm", session.user.id);
  } else {
    const password = rawStr(body, "password", 200);
    const row = await env.DB.prepare(`SELECT ${PASSWORD_COLUMNS} FROM users WHERE id = ?`)
      .bind(session.user.id)
      .first<PasswordRow>();
    if (row?.password_disabled) throw new HttpError(409, "Password sign-in is off. Confirm with your passkey.");
    if (!(await verifyPassword(env, row, password))) throw new HttpError(400, "That password is wrong.");
  }
  await clearAttempts(env, bucket);
  await markConfirmed(env, session);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Removing a passkey, turning password sign-in off and on (recently confirmed)
// ---------------------------------------------------------------------------

export async function deletePasskey(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireSession(request, env);
  requireConfirmed(session);
  await readBody(request);
  // One statement: never remove the last passkey of an account that has no password.
  const res = await env.DB.prepare(
    `DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2
       AND ((SELECT password_disabled FROM users WHERE id = ?2) = 0
            OR (SELECT count(*) FROM passkeys WHERE user_id = ?2) > 1)`,
  )
    .bind(id, session.user.id)
    .run();
  if (!res.meta.changes) {
    const exists = await env.DB.prepare("SELECT 1 FROM passkeys WHERE id = ? AND user_id = ?")
      .bind(id, session.user.id)
      .first();
    if (exists) throw new HttpError(409, "That's your only way to sign in. Turn password sign-in back on first.");
    throw new HttpError(404, "Passkey not found.");
  }
  return json({ ok: true });
}

export async function disablePassword(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  requireConfirmed(session);
  await readBody(request);
  // Replace the hash with random bytes rather than just flagging it: then a leaked database
  // holds nothing to crack for this account. Only if the person has a passkey to sign in with.
  const res = await env.DB.prepare(
    `UPDATE users SET password_disabled = 1, password_hash = ?, password_salt = ?
     WHERE id = ? AND password_disabled = 0 AND EXISTS (SELECT 1 FROM passkeys WHERE user_id = users.id)`,
  )
    .bind(randomHex(32), randomHex(16), session.user.id)
    .run();
  if (!res.meta.changes) {
    const row = await env.DB.prepare("SELECT password_disabled FROM users WHERE id = ?")
      .bind(session.user.id)
      .first<{ password_disabled: number }>();
    if (row?.password_disabled) throw new HttpError(409, "Password sign-in is already off.");
    throw new HttpError(409, "Add a passkey first, so you can still sign in.");
  }
  return json({ ok: true });
}

export async function enablePassword(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  requireConfirmed(session);
  const next = rawStr(await readBody(request), "next", 200);
  checkNewPassword(next);
  await setPassword(env, session.user.id, next); // also turns password sign-in back on
  return json({ ok: true });
}
