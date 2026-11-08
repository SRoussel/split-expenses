// Shared plumbing for every route: the environment, errors, JSON in and out, and input checks.

export interface Env {
  DB: D1Database;
  /** Most accounts that may ever exist. "2" for the two of you; sign-up closes after that. */
  MAX_USERS?: string;
  /** PBKDF2 work factor for new and changed passwords. See README (CPU limits). */
  PBKDF2_ITERATIONS?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const MAX_AMOUNT_CENTS = 100_000_000_00; // $100M, just a sanity cap

function intVar(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
// Default fits the Workers Free plan's 10 ms CPU limit; 100k is the most Workers' WebCrypto allows.
export const iterationsFor = (env: Env) => intVar(env.PBKDF2_ITERATIONS, 20_000, 10_000, 100_000);
export const maxUsersFor = (env: Env) => intVar(env.MAX_USERS, 2, 1, 1000);

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export function json(data: unknown, status = 200, extraHeaders: [string, string][] = []): Response {
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
export function assertSameOrigin(request: Request) {
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

export async function readBody(request: Request): Promise<Record<string, unknown>> {
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

export function str(body: Record<string, unknown>, field: string, max = 200): string {
  const v = body[field];
  if (typeof v !== "string" || !v.trim() || v.length > max) {
    throw new HttpError(400, `Missing or invalid "${field}".`);
  }
  return v.trim();
}

/** Like str() but leaves the value exactly as typed (passwords must not be trimmed). */
export function rawStr(body: Record<string, unknown>, field: string, max = 200): string {
  const v = body[field];
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    throw new HttpError(400, `Missing or invalid "${field}".`);
  }
  return v;
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // Round-trip so impossible dates like 2026-02-31 are rejected.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * "Today" in the household's time zone. The app sends its local date so a bill due
 * on the 1st appears on the 1st where you are; anything more than a day away from
 * the server's UTC date is ignored and UTC is used instead.
 */
export function todayFor(request: Request, body?: Record<string, unknown>): string {
  const utc = new Date().toISOString().slice(0, 10);
  const claimed = typeof body?.today === "string" ? body.today : new URL(request.url).searchParams.get("today");
  if (claimed && validDate(claimed) && claimed >= addDays(utc, -1) && claimed <= addDays(utc, 1)) return claimed;
  return utc;
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}
