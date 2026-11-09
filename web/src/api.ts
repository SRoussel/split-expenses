import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { Frequency } from "../shared/recurring";
import { todayLocal } from "./ledger";
import type { StatementImport } from "./ledger";
import type { Entry, Member, NewEntry, Recurring, RecurringInput, SpendingData } from "./types";

export interface User {
  id: string;
  email: string;
}

export interface Membership {
  household_id: string;
  display_name: string;
}

/** Called when the server says we're signed out (e.g. the session expired). */
let onSessionLost: (() => void) | null = null;
export function setSessionLostHandler(fn: (() => void) | null) {
  onSessionLost = fn;
}

/** An error from the API, with the server's machine-readable code when it sends one. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The server wants this session to confirm it's you (password or passkey) before going on. */
export const needsConfirm = (err: unknown) => err instanceof ApiError && err.code === "confirm";

// The sign-in and account-check calls legitimately answer 401; everything else means the session is gone.
const AUTH_PATHS = new Set([
  "/api/me",
  "/api/login",
  "/api/signup",
  "/api/logout",
  "/api/passkeys/login/options",
  "/api/passkeys/login/verify",
  "/api/confirm",
  "/api/confirm/options",
]);

async function call<T = void>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    const lost = (res.status === 401 || res.status === 403) && data.code !== "confirm" && !AUTH_PATHS.has(path);
    if (lost) onSessionLost?.();
    throw new ApiError(data.error ?? `Request failed (${res.status}).`, res.status, data.code);
  }
  return data as T;
}

export const getMe = () => call<{ user: User | null; membership?: Membership | null }>("GET", "/api/me");

export const signUp = (email: string, password: string) => call("POST", "/api/signup", { email, password });
export const signIn = (email: string, password: string) => call("POST", "/api/login", { email, password });
export const signOut = () => call("POST", "/api/logout", {});
export const changePassword = (current: string, next: string) => call("POST", "/api/password", { current, next });

export const createHousehold = (displayName: string) => call("POST", "/api/household", { displayName });
export const joinHousehold = (code: string, displayName: string) =>
  call("POST", "/api/household/join", { code, displayName });

// Sends the phone's local date, so recurring expenses appear on the right day where you are.
export const loadHousehold = () =>
  call<{ members: Member[]; inviteCode: string; entries: Entry[]; recurring: Recurring[] }>(
    "GET",
    `/api/household?today=${todayLocal()}`,
  );

export const setDefaultSplit = (myShare: number) => call("POST", "/api/household/split", { myShare });
export const purgeVoided = () => call<{ deleted: number }>("POST", "/api/household/purge-voided", {});
export const resetHousehold = (confirm: string) =>
  call<{ deletedEntries: number; deletedRecurring: number }>("POST", "/api/household/reset", { confirm });

export const addEntry = (entry: NewEntry) => call("POST", "/api/entries", entry);
export const editEntry = (id: string, entry: NewEntry) => call("POST", `/api/entries/${id}/edit`, entry);
export const voidEntry = (id: string) => call("POST", `/api/entries/${id}/void`, {});
export const unvoidEntry = (id: string) => call("POST", `/api/entries/${id}/unvoid`, {});

export const createRecurring = (rule: RecurringInput & { frequency: Frequency; start_date: string }) =>
  call("POST", "/api/recurring", { ...rule, today: todayLocal() });
export const updateRecurring = (id: string, rule: RecurringInput & { paused: boolean }) =>
  call("POST", `/api/recurring/${id}/update`, { ...rule, today: todayLocal() });
export const stopRecurring = (id: string) => call("POST", `/api/recurring/${id}/stop`, {});

export const importStatement = (body: StatementImport) =>
  call<{ entryId: string | null; batchId: string | null }>("POST", "/api/statements/import", {
    ...body,
    today: todayLocal(),
  });
export const getSpending = () => call<SpendingData>("GET", "/api/spending");
export const deleteUpload = (id: string) => call("POST", `/api/statements/${id}/delete`, {});
/** Move money between categories in one month of an upload or an imported shared entry. */
export const moveSpending = (move: {
  kind: "upload" | "entry";
  id: string;
  month: string;
  from: string;
  to: string;
  cents: number;
}) => call("POST", "/api/spending/move", move);

// ---------------------------------------------------------------------------
// Passkeys. The browser library talks to Face ID / Touch ID; the server checks the result.
// ---------------------------------------------------------------------------

export interface Passkey {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export const passkeysSupported = () => browserSupportsWebAuthn();
/** Stops a passkey request that's still waiting (e.g. the autofill one when leaving the sign-in screen). */
export const cancelPasskeyRequest = () => WebAuthnAbortService.cancelCeremony();

// After a password sign-in, the app offers once to add a passkey (see LedgerScreen).
const OFFER_KEY = "split.offerPasskey";
export function markPasskeyOffer() {
  try {
    sessionStorage.setItem(OFFER_KEY, "1");
  } catch {
    /* storage blocked: just don't offer */
  }
}
export function takePasskeyOffer(): boolean {
  try {
    const due = sessionStorage.getItem(OFFER_KEY) === "1";
    sessionStorage.removeItem(OFFER_KEY);
    return due;
  } catch {
    return false;
  }
}
export const passkeyAutofillSupported = () => browserSupportsWebAuthnAutofill();

export const getAccount = () => call<{ passwordEnabled: boolean; passkeys: Passkey[] }>("GET", "/api/account");

/** A name for the passkey list, from the kind of device it was made on. */
function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android phone";
  if (/Windows/.test(ua)) return "Windows PC";
  return "This device";
}

/** The device's own messages when you cancel are long and technical; this one isn't. */
function friendly(err: unknown): never {
  if (err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError")) {
    throw new ApiError("Cancelled. Nothing was changed.", 0, "cancelled");
  }
  if (err instanceof Error && err.name === "InvalidStateError") {
    throw new ApiError("This device already has a passkey for your account.", 0);
  }
  throw err;
}

export async function addPasskey() {
  const optionsJSON = await call<PublicKeyCredentialCreationOptionsJSON>("POST", "/api/passkeys/register/options", {});
  const response = await startRegistration({ optionsJSON }).catch(friendly);
  await call("POST", "/api/passkeys/register/verify", { response, name: deviceName() });
}

/**
 * Sign in with a passkey. With `autofill`, it waits quietly for you to pick the passkey
 * that iOS offers in the email field's suggestions, instead of opening a prompt.
 */
export async function passkeySignIn(autofill = false) {
  const optionsJSON = await call<PublicKeyCredentialRequestOptionsJSON>("POST", "/api/passkeys/login/options", {});
  const response = await startAuthentication({ optionsJSON, useBrowserAutofill: autofill }).catch(friendly);
  await call("POST", "/api/passkeys/login/verify", { response });
}

export async function confirmWithPasskey() {
  const optionsJSON = await call<PublicKeyCredentialRequestOptionsJSON>("POST", "/api/confirm/options", {});
  const response = await startAuthentication({ optionsJSON }).catch(friendly);
  await call("POST", "/api/confirm", { response });
}
export const confirmWithPassword = (password: string) => call("POST", "/api/confirm", { password });
export const removePasskey = (id: string) => call("POST", `/api/passkeys/${encodeURIComponent(id)}/delete`, {});
export const disablePassword = () => call("POST", "/api/password/disable", {});
export const enablePassword = (next: string) => call("POST", "/api/password/enable", { next });
