// End-to-end tests for the Worker API (auth, security guards, ledger rules).
//
//   npm run test:api
//
// Starts the real Worker under `wrangler dev` with a brand-new database in a
// temporary folder, runs every check against it over HTTP, then deletes it.
// Your normal local database (.wrangler/) and the deployed one are never touched.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const PORT = 8800 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
const STATE = mkdtempSync(join(tmpdir(), "split-api-test-"));
const WEB = new URL("..", import.meta.url).pathname;
let server;

function wrangler(args, opts = {}) {
  return execFileSync("npx", ["wrangler", ...args], { cwd: WEB, encoding: "utf8", stdio: "pipe", ...opts });
}

/** Run SQL directly against the test database (to fake time passing, etc.). */
function sql(command) {
  wrangler(["d1", "execute", "ledger", "--local", "--persist-to", STATE, "--command", command]);
}

/** A browser stand-in with its own cookie jar. */
class Client {
  cookie = null;

  async req(method, path, body, headers = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
    const res = await fetch(BASE + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(";")[0];
      this.cookie = pair.endsWith("=") ? null : pair;
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }
  get(path) {
    return this.req("GET", path);
  }
  post(path, body = {}, headers) {
    return this.req("POST", path, body, headers);
  }
}

const day = "2026-11-01";
const expense = (payer_id, extra = {}) => ({
  kind: "expense",
  entry_date: day,
  name: "Groceries",
  amount_cents: 10000,
  payer_id,
  payer_share_pct: 50,
  ...extra,
});

before(async () => {
  // The Worker serves ./dist, so the app must be built (npm run test:api does this).
  wrangler(["d1", "migrations", "apply", "ledger", "--local", "--persist-to", STATE]);
  server = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--persist-to", STATE, "--var", "MAX_USERS:3"],
    { cwd: WEB, stdio: "ignore", detached: true },
  );
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/me`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev didn't start");
});

after(() => {
  // Kill the whole process group (npx -> wrangler -> workerd).
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  rmSync(STATE, { recursive: true, force: true });
});

describe("Split API", () => {
  const alice = new Client();
  const bob = new Client();
  const carol = new Client();
  let aliceId, bobId, carolId, invite;

  test("security headers on the page", async () => {
    const res = await fetch(`${BASE}/`);
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  test("not signed in: reads and writes are refused", async () => {
    const c = new Client();
    assert.deepEqual((await c.get("/api/me")).data, { user: null });
    assert.equal((await c.get("/api/household")).status, 401);
    assert.equal((await c.post("/api/entries", expense("x"))).status, 401);
    assert.equal((await c.post("/api/password", { current: "a", next: "bbbbbbbb" })).status, 401);
  });

  test("CSRF: cross-site and non-JSON requests are refused", async () => {
    const c = new Client();
    const creds = { email: "x@example.com", password: "password1" };
    assert.equal((await c.post("/api/login", creds, { origin: "https://evil.example" })).status, 403);
    assert.equal((await c.post("/api/login", creds, { "sec-fetch-site": "cross-site" })).status, 403);
    const smuggled = await c.post("/api/login", creds, { "content-type": "text/plain; x=application/json" });
    assert.equal(smuggled.status, 415);
  });

  test("sign-up: validation, duplicates, untrimmed passwords", async () => {
    assert.equal((await new Client().post("/api/signup", { email: "nope", password: "password1" })).status, 400);
    assert.equal((await new Client().post("/api/signup", { email: "a@x.com", password: "short" })).status, 400);

    assert.equal((await alice.post("/api/signup", { email: "Alice@X.com", password: "  spaced pw  " })).status, 200);
    aliceId = (await alice.get("/api/me")).data.user.id;
    assert.equal((await new Client().post("/api/signup", { email: "alice@x.com", password: "password1" })).status, 409);

    // The password is stored exactly as typed: the trimmed version must not work.
    assert.equal((await new Client().post("/api/login", { email: "alice@x.com", password: "spaced pw" })).status, 401);
    assert.equal((await new Client().post("/api/login", { email: "alice@x.com", password: "  spaced pw  " })).status, 200);
  });

  test("household: create, join, size limit, double-tap", async () => {
    assert.equal((await alice.post("/api/household", { displayName: "Alice" })).status, 200);
    assert.equal((await alice.post("/api/household", { displayName: "Alice" })).status, 409);
    invite = (await alice.get("/api/household")).data.inviteCode;
    assert.match(invite, /^[0-9a-f]{16}$/);

    await bob.post("/api/signup", { email: "bob@x.com", password: "password2" });
    bobId = (await bob.get("/api/me")).data.user.id;
    assert.equal((await bob.post("/api/household/join", { code: "0000000000000000", displayName: "Bob" })).status, 404);
    assert.equal((await bob.post("/api/household/join", { code: invite, displayName: "Bob" })).status, 200);
    assert.equal((await bob.post("/api/household/join", { code: invite, displayName: "Bob" })).status, 409);

    await carol.post("/api/signup", { email: "carol@x.com", password: "password3" });
    carolId = (await carol.get("/api/me")).data.user.id;
    const full = await carol.post("/api/household/join", { code: invite, displayName: "Carol" });
    assert.equal(full.status, 409);
    assert.match(full.data.error, /full/);
  });

  test("sign-up closes at MAX_USERS (3 in this test)", async () => {
    const res = await new Client().post("/api/signup", { email: "dave@x.com", password: "password4" });
    assert.equal(res.status, 403);
    assert.match(res.data.error, /closed/i);
  });

  test("entries: the server computes what's owed and ignores the client's number", async () => {
    assert.equal((await alice.post("/api/entries", expense(aliceId, { owed_cents: 1 }))).status, 201);
    // Half-cent rule: non-payer owes 51c of $1.01, the payer gets the one-cent discount.
    await alice.post("/api/entries", expense(bobId, { name: "Coffee", amount_cents: 101 }));
    await bob.post("/api/entries", { kind: "settlement", entry_date: day, name: "Settlement", amount_cents: 2000, payer_id: bobId, owed_cents: 1 });

    const { entries } = (await bob.get("/api/household")).data;
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    assert.equal(byName.Groceries.owed_cents, 5000);
    assert.equal(byName.Coffee.owed_cents, 51);
    assert.equal(byName.Settlement.owed_cents, 2000);
  });

  test("entries: invalid input is rejected", async () => {
    const bad = [
      expense(aliceId, { payer_share_pct: 33.333 }),
      expense(aliceId, { payer_share_pct: 101 }),
      expense(aliceId, { entry_date: "2026-02-31" }),
      expense(aliceId, { amount_cents: 0 }),
      expense(aliceId, { amount_cents: 1.5 }),
      expense(aliceId, { name: "   " }),
      expense(carolId), // payer outside the household
      { ...expense(aliceId), kind: "gift" },
    ];
    for (const body of bad) assert.equal((await alice.post("/api/entries", body)).status, 400, JSON.stringify(body));
  });

  test("only one active starting balance; voiding frees the slot", async () => {
    const opening = { kind: "opening", entry_date: day, name: "Starting balance", amount_cents: 5000, payer_id: aliceId };
    assert.equal((await alice.post("/api/entries", opening)).status, 201);
    assert.equal((await bob.post("/api/entries", opening)).status, 409);

    const id = (await alice.get("/api/household")).data.entries.find((e) => e.kind === "opening").id;
    assert.equal((await bob.post(`/api/entries/${id}/void`)).status, 200);
    assert.equal((await bob.post(`/api/entries/${id}/void`)).status, 404); // already voided
    assert.equal((await alice.post("/api/entries", opening)).status, 201);
  });

  test("someone outside the household can't see or touch its entries", async () => {
    const id = (await alice.get("/api/household")).data.entries[0].id;
    assert.equal((await carol.get("/api/household")).status, 403); // Carol has no household
    assert.equal((await carol.post(`/api/entries/${id}/void`)).status, 403);
    // Carol starts her own household: still can't reach Alice's entries.
    await carol.post("/api/household", { displayName: "Carol" });
    assert.equal((await carol.post(`/api/entries/${id}/void`)).status, 404);
    assert.equal((await carol.get("/api/household")).data.entries.length, 0);
  });

  test("sessions renew when the app is opened", async () => {
    sql("UPDATE sessions SET expires_at = datetime('now', '+5 days')");
    const res = await alice.get("/api/me");
    assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=5184000/);
    assert.match(res.headers.get("set-cookie") ?? "", /HttpOnly/);
  });

  test("changing password signs out other devices, keeps this one", async () => {
    const otherDevice = new Client();
    assert.equal((await otherDevice.post("/api/login", { email: "bob@x.com", password: "password2" })).status, 200);

    assert.equal((await bob.post("/api/password", { current: "wrong-wrong", next: "newpassword2" })).status, 400);
    assert.equal((await bob.post("/api/password", { current: "password2", next: "newpassword2" })).status, 200);

    assert.ok((await bob.get("/api/me")).data.user, "this device stays signed in");
    assert.equal((await otherDevice.get("/api/me")).data.user, null, "other device signed out");
    assert.equal((await new Client().post("/api/login", { email: "bob@x.com", password: "password2" })).status, 401);
    assert.equal((await new Client().post("/api/login", { email: "bob@x.com", password: "newpassword2" })).status, 200);
  });

  test("logout ends the session on the server", async () => {
    const c = new Client();
    await c.post("/api/login", { email: "bob@x.com", password: "newpassword2" });
    const stolen = c.cookie;
    assert.equal((await c.post("/api/logout")).status, 200);
    const replay = await fetch(`${BASE}/api/household`, { headers: { cookie: stolen } });
    assert.equal(replay.status, 401, "an old cookie must not work after logout");
  });

  test("brute force: a burst of wrong passwords is cut off at 10", async () => {
    const tries = await Promise.all(
      Array.from({ length: 12 }, () =>
        new Client().post("/api/login", { email: "carol@x.com", password: "not-her-password" }),
      ),
    );
    const codes = tries.map((t) => t.status).sort();
    assert.equal(codes.filter((c) => c === 401).length, 10);
    assert.equal(codes.filter((c) => c === 429).length, 2);
    // Even the right password is refused while locked.
    assert.equal((await new Client().post("/api/login", { email: "carol@x.com", password: "password3" })).status, 429);
  });

  test("invite-code guessing is throttled", async () => {
    // Carol is in her own household now, so use a fresh account slot... none left (MAX_USERS),
    // so free Carol by deleting her membership directly.
    sql(`DELETE FROM members WHERE user_id = '${carolId}'`);
    const codes = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await carol.post("/api/household/join", { code: `guess${i}`, displayName: "Carol" })).status);
    }
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(404));
    assert.equal(codes[10], 429);
  });
});
