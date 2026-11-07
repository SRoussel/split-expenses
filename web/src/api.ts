import type { Entry, Member, NewEntry } from "./types";

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

// The sign-in and account-check calls legitimately answer 401; everything else means the session is gone.
const AUTH_PATHS = new Set(["/api/me", "/api/login", "/api/signup", "/api/logout"]);

async function call<T = void>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if ((res.status === 401 || res.status === 403) && !AUTH_PATHS.has(path)) onSessionLost?.();
    throw new Error(data.error ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

export const getMe = () => call<{ user: User | null; membership?: Membership | null }>("GET", "/api/me");

export const signUp = (email: string, password: string) => call("POST", "/api/signup", { email, password });
export const signIn = (email: string, password: string) => call("POST", "/api/login", { email, password });
export const signOut = () => call("POST", "/api/logout", {});
export const changePassword = (current: string, next: string) =>
  call("POST", "/api/password", { current, next });

export const createHousehold = (displayName: string) => call("POST", "/api/household", { displayName });
export const joinHousehold = (code: string, displayName: string) =>
  call("POST", "/api/household/join", { code, displayName });

export const loadHousehold = () =>
  call<{ members: Member[]; inviteCode: string; entries: Entry[] }>("GET", "/api/household");

export const addEntry = (entry: NewEntry) => call("POST", "/api/entries", entry);
export const voidEntry = (id: string) => call("POST", `/api/entries/${id}/void`, {});
