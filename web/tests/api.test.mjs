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

  test("default split: both shares are set together, only once both have joined", async () => {
    // Carol is alone in her household right now.
    assert.equal((await carol.post("/api/household/split", { myShare: 60 })).status, 409);
    assert.equal((await alice.post("/api/household/split", { myShare: 33.333 })).status, 400);
    assert.equal((await alice.post("/api/household/split", { myShare: "60" })).status, 400);

    assert.equal((await alice.post("/api/household/split", { myShare: 60 })).status, 200);
    let members = (await bob.get("/api/household")).data.members;
    const share = (id) => members.find((m) => m.user_id === id).share_pct;
    assert.equal(share(aliceId), 60);
    assert.equal(share(bobId), 40);

    assert.equal((await bob.post("/api/household/split", { myShare: 50 })).status, 200);
    members = (await alice.get("/api/household")).data.members;
    assert.equal(share(aliceId), 50);
    assert.equal(share(bobId), 50);
  });

  test("edit: replaces the entry, recomputes what's owed, keeps the old one in history", async () => {
    await alice.post("/api/entries", expense(aliceId, { name: "Edit me" }));
    const find = async (pred) => (await alice.get("/api/household")).data.entries.find(pred);
    const original = await find((e) => e.name === "Edit me");

    const res = await bob.post(`/api/entries/${original.id}/edit`, expense(aliceId, { name: "Edited", amount_cents: 3000, owed_cents: 1 }));
    assert.equal(res.status, 200);
    const old = await find((e) => e.id === original.id);
    const fresh = await find((e) => e.id === res.data.id);
    assert.ok(old.voided_at, "original is voided");
    assert.equal(old.replaced_by, fresh.id, "original points at its replacement");
    assert.equal(old.voided_by, bobId);
    assert.equal(fresh.voided_at, null);
    assert.equal(fresh.owed_cents, 1500, "server recomputed, ignoring the client's owed_cents");
    assert.equal(fresh.created_by, bobId);

    // The old version can't be edited again, and an edit can't change the entry type.
    assert.equal((await alice.post(`/api/entries/${original.id}/edit`, expense(aliceId))).status, 404);
    const asSettlement = { ...expense(aliceId), kind: "settlement" };
    assert.equal((await alice.post(`/api/entries/${fresh.id}/edit`, asSettlement)).status, 404);
    assert.equal((await find((e) => e.id === fresh.id)).voided_at, null, "a refused edit changes nothing");
    // Bad input is refused before anything is touched.
    assert.equal((await alice.post(`/api/entries/${fresh.id}/edit`, expense(aliceId, { amount_cents: -5 }))).status, 400);
    assert.equal((await find((e) => e.id === fresh.id)).voided_at, null);
    // Someone from another household can't edit it (Carol is a valid payer in her own household,
    // so this reaches the update, which must not match an entry outside her household).
    assert.equal((await carol.post(`/api/entries/${fresh.id}/edit`, expense(carolId))).status, 404);
    assert.equal((await find((e) => e.id === fresh.id)).voided_at, null, "untouched by the other household");
  });

  test("edit: a starting balance can be edited despite the one-at-a-time rule", async () => {
    const active = (await alice.get("/api/household")).data.entries.find((e) => e.kind === "opening" && !e.voided_at);
    const body = { kind: "opening", entry_date: day, name: "Starting balance", amount_cents: 7000, payer_id: bobId };
    assert.equal((await alice.post(`/api/entries/${active.id}/edit`, body)).status, 200);
    const openings = (await alice.get("/api/household")).data.entries.filter((e) => e.kind === "opening" && !e.voided_at);
    assert.equal(openings.length, 1);
    assert.equal(openings[0].amount_cents, 7000);
    assert.equal(openings[0].payer_id, bobId);
  });

  test("restore (undo void): works for voided entries, not for edited ones or a second opening", async () => {
    const entries = async () => (await alice.get("/api/household")).data.entries;
    const target = (await entries()).find((e) => e.name === "Edited" && !e.voided_at);
    assert.equal((await alice.post(`/api/entries/${target.id}/void`)).status, 200);
    assert.equal((await bob.post(`/api/entries/${target.id}/unvoid`)).status, 200);
    const back = (await entries()).find((e) => e.id === target.id);
    assert.equal(back.voided_at, null);
    assert.equal(back.voided_by, null);
    assert.equal((await bob.post(`/api/entries/${target.id}/unvoid`)).status, 404, "not voided any more");

    const editedOld = (await entries()).find((e) => e.name === "Edit me");
    assert.equal((await alice.post(`/api/entries/${editedOld.id}/unvoid`)).status, 404, "edited entries stay replaced");

    // An old, plainly voided starting balance can't come back while another is active.
    const oldOpening = (await entries()).find((e) => e.kind === "opening" && e.voided_at && !e.replaced_by);
    assert.equal((await alice.post(`/api/entries/${oldOpening.id}/unvoid`)).status, 409);

    // Another household can't restore our entries.
    await alice.post(`/api/entries/${target.id}/void`);
    assert.equal((await carol.post(`/api/entries/${target.id}/unvoid`)).status, 404);
  });

  describe("recurring expenses", () => {
    // The server's notion of "today" (no ?today= sent, so it uses UTC).
    const today = new Date().toISOString().slice(0, 10);
    const rule = (extra = {}) => ({
      name: "Rent",
      amount_cents: 240000,
      payer_id: aliceId,
      payer_share_pct: 50,
      frequency: "monthly",
      start_date: today,
      today,
      ...extra,
    });
    const household = async () => (await alice.get("/api/household")).data;
    const occurrences = async (id) => (await household()).entries.filter((e) => e.recurring_id === id);
    let ruleId;

    test("creating: validation, and no dates in the past", async () => {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const tooFar = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
      const bad = [
        rule({ start_date: yesterday }),
        rule({ start_date: tooFar }),
        rule({ start_date: "2026-02-31" }),
        rule({ frequency: "daily" }),
        rule({ payer_share_pct: 33.333 }),
        rule({ amount_cents: 0 }),
        rule({ name: " " }),
        rule({ payer_id: carolId }),
      ];
      for (const body of bad) assert.equal((await alice.post("/api/recurring", body)).status, 400, JSON.stringify(body));
    });

    test("the first occurrence appears when the app is opened, exactly once", async () => {
      const res = await alice.post("/api/recurring", rule());
      assert.equal(res.status, 201);
      ruleId = res.data.id;

      // Five phones opening the app at the same moment still create it once.
      await Promise.all(Array.from({ length: 5 }, () => (Math.random() < 0.5 ? alice : bob).get("/api/household")));
      const occ = await occurrences(ruleId);
      assert.equal(occ.length, 1);
      assert.equal(occ[0].entry_date, today);
      assert.equal(occ[0].occurrence_date, today);
      assert.equal(occ[0].owed_cents, 120000, "owed computed on the server");
      assert.equal(occ[0].created_by, aliceId);

      const listed = (await household()).recurring.find((r) => r.id === ruleId);
      assert.ok(listed.next_date > today, "the rule moved on to the next month");
      assert.equal(listed.paused, false);
    });

    test("a voided occurrence never comes back", async () => {
      const [occ] = await occurrences(ruleId);
      assert.equal((await alice.post(`/api/entries/${occ.id}/void`)).status, 200);
      // Even if the rule were rewound (e.g. a lost race), the voided month isn't recreated.
      sql(`UPDATE recurring SET next_index = 0, next_date = start_date WHERE id = '${ruleId}'`);
      const after = await occurrences(ruleId);
      assert.equal(after.length, 1);
      assert.ok(after[0].voided_at);
    });

    test("catches up on every missed occurrence after a gap", async () => {
      // Pretend the rule started on the 1st, two months ago, and nobody opened the app since.
      const d = new Date();
      const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
      sql(`UPDATE recurring SET start_date = '${start}', next_index = 0, next_date = '${start}' WHERE id = '${ruleId}'`);
      const occ = await occurrences(ruleId);
      const firsts = occ.filter((e) => e.occurrence_date.endsWith("-01")).map((e) => e.occurrence_date).sort();
      assert.equal(firsts.length, 3, "three 1sts: two months ago, last month, this month");
      assert.equal(firsts[0], start);
      assert.equal(occ.length, today.endsWith("-01") ? 3 : 4, "plus the voided one from today");
      assert.ok((await household()).recurring.find((r) => r.id === ruleId).next_date > today);
    });

    test("pausing stops new occurrences; resuming doesn't fill in the paused months", async () => {
      const base = rule();
      delete base.start_date;
      delete base.frequency;
      assert.equal((await bob.post(`/api/recurring/${ruleId}/update`, { ...base, paused: true })).status, 200);
      const before = (await occurrences(ruleId)).length;

      sql(`UPDATE recurring SET next_index = 0, next_date = start_date WHERE id = '${ruleId}'`);
      assert.equal((await occurrences(ruleId)).length, before, "nothing while paused");

      sql(`UPDATE recurring SET start_date = '2025-01-01', next_index = 0, next_date = '2025-01-01' WHERE id = '${ruleId}'`);
      assert.equal((await bob.post(`/api/recurring/${ruleId}/update`, { ...base, paused: false })).status, 200);
      assert.equal((await occurrences(ruleId)).length, before, "resuming skips the paused period");
      const listed = (await household()).recurring.find((r) => r.id === ruleId);
      assert.equal(listed.paused, false);
      assert.ok(listed.next_date >= today);
    });

    test("changes apply to future occurrences only", async () => {
      const before = (await occurrences(ruleId)).map((e) => e.amount_cents);
      const body = { ...rule({ name: "Rent (new lease)", amount_cents: 250000, payer_share_pct: 60 }), paused: false };
      assert.equal((await alice.post(`/api/recurring/${ruleId}/update`, body)).status, 200);
      const listed = (await household()).recurring.find((r) => r.id === ruleId);
      assert.equal(listed.amount_cents, 250000);
      assert.equal(listed.name, "Rent (new lease)");
      assert.deepEqual((await occurrences(ruleId)).map((e) => e.amount_cents), before, "past entries untouched");
      assert.equal((await alice.post(`/api/recurring/${ruleId}/update`, { ...body, paused: "no" })).status, 400);
    });

    test("another household can't change or stop it", async () => {
      const body = { ...rule({ payer_id: carolId }), paused: false };
      assert.equal((await carol.post(`/api/recurring/${ruleId}/update`, body)).status, 404);
      assert.equal((await carol.post(`/api/recurring/${ruleId}/stop`)).status, 404);
      assert.equal((await carol.get("/api/household")).data.recurring.length, 0);
    });

    test("stopping: no more occurrences, past ones stay", async () => {
      const kept = (await occurrences(ruleId)).length;
      assert.equal((await bob.post(`/api/recurring/${ruleId}/stop`)).status, 200);
      assert.equal((await bob.post(`/api/recurring/${ruleId}/stop`)).status, 404);
      assert.equal((await household()).recurring.length, 0);
      sql(`UPDATE recurring SET next_index = 0, next_date = '2020-01-01', start_date = '2020-01-01' WHERE id = '${ruleId}'`);
      assert.equal((await occurrences(ruleId)).length, kept);
      const body = { ...rule(), paused: false };
      assert.equal((await alice.post(`/api/recurring/${ruleId}/update`, body)).status, 404);
    });
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
