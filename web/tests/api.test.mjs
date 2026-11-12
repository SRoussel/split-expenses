// End-to-end tests for the Worker API (auth, security guards, ledger rules).
//
//   npm run test:api
//
// Starts the real Worker under `wrangler dev` with a brand-new database in a
// temporary folder, runs every check against it over HTTP, then deletes it.
// Your normal local database (.wrangler/) and the deployed one are never touched.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { FakePasskey } from "./fake-passkey.mjs";
import categories from "../shared/categories.json" with { type: "json" };

const SPENDING_CATEGORIES = categories.spending;

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
  server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", STATE, "--var", "MAX_USERS:3"], {
    cwd: WEB,
    stdio: "ignore",
    detached: true,
  });
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
    assert.equal(
      (await new Client().post("/api/login", { email: "alice@x.com", password: "  spaced pw  " })).status,
      200,
    );
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
    await bob.post("/api/entries", {
      kind: "settlement",
      entry_date: day,
      name: "Settlement",
      amount_cents: 2000,
      payer_id: bobId,
      owed_cents: 1,
    });

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
    const opening = {
      kind: "opening",
      entry_date: day,
      name: "Starting balance",
      amount_cents: 5000,
      payer_id: aliceId,
    };
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

    const res = await bob.post(
      `/api/entries/${original.id}/edit`,
      expense(aliceId, { name: "Edited", amount_cents: 3000, owed_cents: 1 }),
    );
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
    assert.equal(
      (await alice.post(`/api/entries/${fresh.id}/edit`, expense(aliceId, { amount_cents: -5 }))).status,
      400,
    );
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
    const openings = (await alice.get("/api/household")).data.entries.filter(
      (e) => e.kind === "opening" && !e.voided_at,
    );
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
      for (const body of bad)
        assert.equal((await alice.post("/api/recurring", body)).status, 400, JSON.stringify(body));
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
      sql(
        `UPDATE recurring SET start_date = '${start}', next_index = 0, next_date = '${start}' WHERE id = '${ruleId}'`,
      );
      const occ = await occurrences(ruleId);
      const firsts = occ
        .filter((e) => e.occurrence_date.endsWith("-01"))
        .map((e) => e.occurrence_date)
        .sort();
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

      sql(
        `UPDATE recurring SET start_date = '2025-01-01', next_index = 0, next_date = '2025-01-01' WHERE id = '${ruleId}'`,
      );
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
      assert.deepEqual(
        (await occurrences(ruleId)).map((e) => e.amount_cents),
        before,
        "past entries untouched",
      );
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
      sql(
        `UPDATE recurring SET next_index = 0, next_date = '2020-01-01', start_date = '2020-01-01' WHERE id = '${ruleId}'`,
      );
      assert.equal((await occurrences(ruleId)).length, kept);
      const body = { ...rule(), paused: false };
      assert.equal((await alice.post(`/api/recurring/${ruleId}/update`, body)).status, 404);
    });
  });

  describe("statement imports and spending", () => {
    const today = new Date().toISOString().slice(0, 10);
    const summary = JSON.parse(readFileSync(new URL("./fixtures/expected_summary_v2.json", import.meta.url), "utf8"));
    const body = (extra = {}) => ({
      name: summary.name,
      start: summary.start,
      end: summary.end,
      today,
      shared: {
        total_cents: summary.shared.total_cents,
        months: summary.shared.months,
        payer_id: bobId,
        payer_share_pct: 50,
      },
      personal: { person_id: bobId, months: summary.personal.months },
      ...extra,
    });
    const spending = async (c = alice) => (await c.get("/api/spending")).data;
    const entries = async () => (await alice.get("/api/household")).data.entries;
    let entryId, batchId;

    test("Alex imports Sam's statement: one shared entry plus Sam's personal totals, together", async () => {
      const res = await alice.post("/api/statements/import", body());
      assert.equal(res.status, 201);
      ({ entryId, batchId } = res.data);

      const entry = (await entries()).find((e) => e.id === entryId);
      assert.equal(entry.amount_cents, 134955);
      assert.equal(entry.payer_id, bobId);
      assert.equal(entry.owed_cents, 67478, "half of $1,349.55, rounded half up for the non-payer");
      assert.equal(entry.created_by, aliceId);

      const sp = await spending(bob);
      const batch = sp.batches.find((b) => b.id === batchId);
      assert.equal(batch.person_id, bobId, "Sam's spending, uploaded by Alex");
      assert.equal(batch.created_by, aliceId);
      assert.equal(batch.entry_id, entryId);
      const totals = sp.totals.filter((t) => t.batch_id === batchId);
      assert.equal(totals.length, 6);
      assert.deepEqual(
        totals.find((t) => t.month === "2026-01" && t.category === "income"),
        { batch_id: batchId, month: "2026-01", category: "income", cents: 325042 },
      );
      assert.equal(totals.find((t) => t.category === "entertainment").cents, 4499, "the return reduced it");
      const breakdown = sp.breakdown.filter((b) => b.entry_id === entryId);
      assert.equal(
        breakdown.reduce((n, b) => n + b.cents, 0),
        134955,
      );
      assert.equal(breakdown.find((b) => b.month === "2026-02").cents, 2025, "the shared return reduced groceries");
    });

    test("the same statement can't be uploaded twice for the same person", async () => {
      const before = (await entries()).length;
      const res = await alice.post("/api/statements/import", body());
      assert.equal(res.status, 409);
      assert.equal((await entries()).length, before, "no shared entry from the refused import");
      // Alex's own statement with the same name is fine.
      const mine = await alice.post(
        "/api/statements/import",
        body({ shared: undefined, personal: { person_id: aliceId, months: summary.personal.months } }),
      );
      assert.equal(mine.status, 201);
    });

    test("an upload can cover up to 24 months, every category in every one", async () => {
      const months = (n) =>
        Object.fromEntries(
          Array.from({ length: n }, (_, i) => {
            const m = `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
            return [m, Object.fromEntries(SPENDING_CATEGORIES.map((c) => [c, 100]))];
          }),
        );
      const upload = (n, name) => {
        const shared = months(n);
        const total = Object.values(shared).reduce((t, cats) => t + Object.values(cats).reduce((a, b) => a + b, 0), 0);
        return body({
          name,
          start: "2024-01-01",
          end: `${2024 + Math.floor((n - 1) / 12)}-${String(((n - 1) % 12) + 1).padStart(2, "0")}-28`,
          shared: { total_cents: total, months: shared, payer_id: aliceId, payer_share_pct: 50 },
          personal: { person_id: aliceId, months: months(n) },
        });
      };
      const two = await alice.post("/api/statements/import", upload(24, "Two years"));
      assert.equal(two.status, 201);
      const rows = (await spending()).totals.filter((t) => t.batch_id === two.data.batchId);
      assert.equal(rows.length, 24 * SPENDING_CATEGORIES.length, "every row written");
      const more = await alice.post("/api/statements/import", upload(25, "Too long"));
      assert.equal(more.status, 400);
      assert.match(more.data.error, /at most 24 months/);
      // Leave the household as the later tests expect it.
      assert.equal((await alice.post(`/api/statements/${two.data.batchId}/delete`)).status, 200);
      assert.equal((await alice.post(`/api/entries/${two.data.entryId}/void`)).status, 200);
    });

    test("all or nothing: a bad personal part leaves no shared entry behind", async () => {
      const before = (await entries()).length;
      const bad = body({
        name: "Another statement",
        personal: { person_id: aliceId, months: { "2026-01": { shopping: 100 } } },
      });
      assert.equal((await alice.post("/api/statements/import", bad)).status, 400);
      assert.equal((await entries()).length, before);
    });

    test("validation", async () => {
      const m = summary.shared.months;
      const cases = [
        ["nothing to import", body({ name: "x", shared: undefined, personal: undefined })],
        ["total doesn't match", body({ name: "x", personal: undefined, shared: { ...body().shared, total_cents: 1 } })],
        [
          "month outside the dates",
          body({
            name: "x",
            personal: undefined,
            shared: { ...body().shared, months: { ...m, "2026-03": { groceries: 1 } }, total_cents: 134956 },
          }),
        ],
        [
          "income in the shared part",
          body({
            name: "x",
            personal: undefined,
            shared: { ...body().shared, months: { "2026-01": { income: 100 } }, total_cents: 100 },
          }),
        ],
        [
          "negative income",
          body({
            name: "x",
            shared: undefined,
            personal: { person_id: aliceId, months: { "2026-01": { income: -5 } } },
          }),
        ],
        [
          "amount in dollars",
          body({
            name: "x",
            shared: undefined,
            personal: { person_id: aliceId, months: { "2026-01": { dining: 12.5 } } },
          }),
        ],
        [
          "person outside the household",
          body({ name: "x", shared: undefined, personal: { person_id: carolId, months: summary.personal.months } }),
        ],
        [
          "payer outside the household",
          body({ name: "x", personal: undefined, shared: { ...body().shared, payer_id: carolId } }),
        ],
        ["bad dates", body({ name: "x", start: "2026-02-31" })],
        [
          "too many months",
          body({
            name: "x",
            shared: undefined,
            start: "2025-01-01",
            end: "2026-12-31",
            personal: {
              person_id: aliceId,
              months: Object.fromEntries(
                Array.from({ length: 14 }, (_, i) => [
                  `2025-${String((i % 12) + 1).padStart(2, "0")}${i >= 12 ? "x" : ""}`,
                  { dining: 1 },
                ]),
              ),
            },
          }),
        ],
      ];
      for (const [label, b] of cases) assert.equal((await alice.post("/api/statements/import", b)).status, 400, label);
    });

    test("another household sees none of it and can't delete it", async () => {
      const theirs = await spending(carol);
      assert.equal(theirs.batches.length, 0);
      assert.equal(theirs.totals.length, 0);
      assert.equal(theirs.breakdown.length, 0);
      assert.equal((await carol.post(`/api/statements/${batchId}/delete`)).status, 404);
      assert.equal((await new Client().get("/api/spending")).status, 401);
    });

    test("moving money between categories keeps the totals and the balance", async () => {
      const move = (c, m) => c.post("/api/spending/move", m);
      const balanceBefore = (await entries()).find((e) => e.id === entryId).owed_cents;
      // Shared: $50 of the biggest January category goes to travel (a category it doesn't have yet).
      let sp = await spending();
      const jan = sp.breakdown
        .filter((b) => b.entry_id === entryId && b.month === "2026-01")
        .sort((a, b) => b.cents - a.cents)[0];
      assert.ok(jan.category !== "travel" && jan.cents > 5000);
      const r = await move(bob, {
        kind: "entry",
        id: entryId,
        month: "2026-01",
        from: jan.category,
        to: "travel",
        cents: 5000,
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      sp = await spending();
      const rows = sp.breakdown.filter((b) => b.entry_id === entryId);
      assert.equal(rows.find((b) => b.month === "2026-01" && b.category === jan.category).cents, jan.cents - 5000);
      assert.equal(rows.find((b) => b.month === "2026-01" && b.category === "travel").cents, 5000);
      assert.equal(
        rows.reduce((n, b) => n + b.cents, 0),
        134955,
        "same total",
      );
      assert.equal((await entries()).find((e) => e.id === entryId).owed_cents, balanceBefore, "same balance");

      // Moving all of it back removes the now-empty row.
      assert.equal(
        (
          await move(alice, {
            kind: "entry",
            id: entryId,
            month: "2026-01",
            from: "travel",
            to: jan.category,
            cents: 5000,
          })
        ).status,
        200,
      );
      sp = await spending();
      assert.ok(!sp.breakdown.some((b) => b.entry_id === entryId && b.category === "travel"));

      // Personal upload: more than there is is refused, and nothing changes.
      const dining = sp.totals.find((t) => t.batch_id === batchId && t.category !== "income" && t.cents > 0);
      const tooMuch = await move(alice, {
        kind: "upload",
        id: batchId,
        month: dining.month,
        from: dining.category,
        to: "gift",
        cents: dining.cents + 1,
      });
      assert.equal(tooMuch.status, 400);
      const ok = await move(alice, {
        kind: "upload",
        id: batchId,
        month: dining.month,
        from: dining.category,
        to: "gift",
        cents: dining.cents,
      });
      assert.equal(ok.status, 200);
      sp = await spending();
      assert.ok(
        !sp.totals.some((t) => t.batch_id === batchId && t.month === dining.month && t.category === dining.category),
      );
      assert.equal(
        sp.totals.find((t) => t.batch_id === batchId && t.month === dining.month && t.category === "gift").cents,
        dining.cents,
      );
      await move(alice, {
        kind: "upload",
        id: batchId,
        month: dining.month,
        from: "gift",
        to: dining.category,
        cents: dining.cents,
      });

      const base = { kind: "upload", id: batchId, month: dining.month, from: dining.category, to: "gift", cents: 1 };
      const cases = [
        ["income can't be moved", { ...base, from: "income" }],
        ["into income", { ...base, to: "income" }],
        ["same category", { ...base, to: dining.category }],
        ["zero", { ...base, cents: 0 }],
        ["dollars", { ...base, cents: 0.5 }],
        ["bad month", { ...base, month: "2026-13" }],
        ["bad kind", { ...base, kind: "batch" }],
      ];
      for (const [label, m] of cases) assert.equal((await move(alice, m)).status, 400, label);
      assert.equal((await move(carol, base)).status, 404, "another household's upload");
      assert.equal((await move(carol, { ...base, kind: "entry", id: entryId, from: jan.category })).status, 404);
    });

    test("editing the imported entry keeps its breakdown only if the total is unchanged", async () => {
      const entry = (await entries()).find((e) => e.id === entryId);
      const same = {
        kind: "expense",
        entry_date: entry.entry_date,
        name: "Renamed statement",
        amount_cents: entry.amount_cents,
        payer_id: bobId,
        payer_share_pct: 50,
      };
      const r1 = await alice.post(`/api/entries/${entryId}/edit`, same);
      assert.equal(r1.status, 200);
      let sp = await spending();
      assert.equal(sp.breakdown.filter((b) => b.entry_id === r1.data.id).length, 4, "breakdown carried over");
      assert.equal(sp.breakdown.filter((b) => b.entry_id === entryId).length, 0, "voided original no longer counts");

      const r2 = await alice.post(`/api/entries/${r1.data.id}/edit`, { ...same, amount_cents: 100000 });
      sp = await spending();
      assert.equal(
        sp.breakdown.filter((b) => b.entry_id === r2.data.id).length,
        0,
        "a changed total drops the breakdown",
      );
      entryId = r2.data.id;
    });

    test("deleting an upload removes its totals; the shared entry stays", async () => {
      assert.equal((await bob.post(`/api/statements/${batchId}/delete`)).status, 200);
      const sp = await spending();
      assert.ok(!sp.batches.some((b) => b.id === batchId));
      assert.ok(!sp.totals.some((t) => t.batch_id === batchId));
      assert.ok((await entries()).some((e) => e.id === entryId && !e.voided_at));
      assert.equal((await bob.post(`/api/statements/${batchId}/delete`)).status, 404);
    });

    test("categories on manual and recurring expenses", async () => {
      assert.equal(
        (await alice.post("/api/entries", expense(aliceId, { name: "Tagged", category: "dining" }))).status,
        201,
      );
      const tagged = (await entries()).find((e) => e.name === "Tagged");
      assert.equal(tagged.category, "dining");
      assert.equal(
        (await alice.post("/api/entries", expense(aliceId, { category: "income" }))).status,
        400,
        "income isn't an expense category",
      );
      assert.equal((await alice.post("/api/entries", expense(aliceId, { category: "shopping" }))).status, 400);
      const settle = {
        kind: "settlement",
        entry_date: day,
        name: "S",
        amount_cents: 100,
        payer_id: aliceId,
        category: "dining",
      };
      assert.equal((await alice.post("/api/entries", settle)).status, 400, "payments don't have categories");

      const rule = await alice.post("/api/recurring", {
        name: "Internet",
        amount_cents: 6000,
        payer_id: aliceId,
        payer_share_pct: 50,
        frequency: "monthly",
        start_date: today,
        today,
        category: "utilities",
      });
      assert.equal(rule.status, 201);
      const gen = (await entries()).find((e) => e.recurring_id === rule.data.id);
      assert.equal(gen.category, "utilities");
      assert.equal(
        (await alice.get("/api/household")).data.recurring.find((r) => r.id === rule.data.id).category,
        "utilities",
      );
      await alice.post(`/api/recurring/${rule.data.id}/stop`);
    });
  });

  describe("desktop keys", () => {
    const today = new Date().toISOString().slice(0, 10);
    const summary = JSON.parse(readFileSync(new URL("./fixtures/expected_summary_v2.json", import.meta.url), "utf8"));
    const keyFile = join(STATE, "app.json");
    const script = (...args) =>
      execFileSync("node", ["scripts/desktop-key.mjs", ...args, "--persist-to", STATE, "--out", keyFile], {
        cwd: WEB,
        encoding: "utf8",
        stdio: "pipe",
      });
    let key;
    /** What the desktop app does: a key in the Authorization header, no cookie, no Origin. */
    const desk = async (method, path, body, k = key) => {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(k ? { authorization: `Bearer ${k}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    const upload = (name) => ({
      name,
      start: summary.start,
      end: summary.end,
      today,
      shared: {
        total_cents: summary.shared.total_cents,
        months: summary.shared.months,
        payer_id: aliceId,
        payer_share_pct: 50,
      },
      personal: { person_id: aliceId, months: summary.personal.months },
    });

    test("npm run desktop-key makes a key and saves it where only you can read it", () => {
      script("alice@x.com", "--name", "Test laptop");
      const saved = JSON.parse(readFileSync(keyFile, "utf8"));
      assert.equal(saved.url, "http://localhost:8787");
      assert.match(saved.key, /^split_[\w-]{43}$/);
      assert.equal(statSync(keyFile).mode & 0o777, 0o600);
      key = saved.key;
      assert.throws(() => script("nobody@x.com"), "no account, no key");
    });

    test("with a key: who's in the household, and the uploads so far", async () => {
      const res = await desk("GET", "/api/desktop/household");
      assert.equal(res.status, 200);
      assert.equal(res.data.me, aliceId);
      assert.deepEqual(res.data.members.map((m) => m.user_id).sort(), [aliceId, bobId].sort());
      assert.ok(Array.isArray(res.data.uploads));
    });

    test("import a summary, then take it back out to send a corrected one", async () => {
      const res = await desk("POST", "/api/desktop/import", upload("From the desktop"));
      assert.equal(res.status, 201);
      const { batchId, entryId } = res.data;
      const listed = (await desk("GET", "/api/desktop/household")).data.uploads.find((u) => u.id === batchId);
      assert.equal(listed.name, "From the desktop");
      assert.equal(listed.has_shared, true);
      const entry = (await alice.get("/api/household")).data.entries.find((e) => e.id === entryId);
      assert.equal(entry.created_by, aliceId, "made as the key's owner");

      assert.equal((await desk("POST", `/api/desktop/uploads/${batchId}/remove`)).status, 200);
      const sp = (await alice.get("/api/spending")).data;
      assert.ok(!sp.batches.some((b) => b.id === batchId), "spending totals gone");
      const voided = (await alice.get("/api/household")).data.entries.find((e) => e.id === entryId);
      assert.ok(voided.voided_at, "the shared expense is voided, still visible");
      assert.equal((await desk("POST", `/api/desktop/uploads/${batchId}/remove`)).status, 404);
      // The same name can be sent again now.
      assert.equal((await desk("POST", "/api/desktop/import", upload("From the desktop"))).status, 201);
    });

    test("splits: each becomes its own shared expense, and taking the upload out takes them all", async () => {
      const split = (pct, cents) => ({
        payer_id: aliceId,
        payer_share_pct: pct,
        total_cents: cents,
        months: { [summary.start.slice(0, 7)]: { dining: cents } },
      });
      const res = await desk("POST", "/api/desktop/import", {
        ...upload("With splits"),
        splits: [split(70, 10000), split(33.5, 4000)],
      });
      assert.equal(res.status, 201);
      const { batchId, entryId, splitIds } = res.data;
      const entries = (await alice.get("/api/household")).data.entries;
      const made = splitIds.map((id) => entries.find((e) => e.id === id));
      assert.deepEqual(
        made.map((e) => [e.name, e.amount_cents, e.payer_id, e.payer_share_pct, e.owed_cents]),
        [
          ["With splits · 70/30 split", 10000, aliceId, 70, 3000],
          ["With splits · 33.5/66.5 split", 4000, aliceId, 33.5, 2660],
        ],
      );
      // Still one upload as far as the desktop is concerned.
      const uploads = (await desk("GET", "/api/desktop/household")).data.uploads;
      assert.equal(uploads.filter((u) => u.name.startsWith("With splits")).length, 1);
      // Taking it out voids the shared expense and both splits.
      assert.equal((await desk("POST", `/api/desktop/uploads/${batchId}/remove`)).status, 200);
      const after = (await alice.get("/api/household")).data.entries;
      for (const id of [entryId, ...splitIds]) assert.ok(after.find((e) => e.id === id).voided_at, id);
    });

    test("an upload of only splits works, lists once, and comes out whole", async () => {
      const only = {
        name: "Only splits",
        start: summary.start,
        end: summary.end,
        today,
        splits: [60, 80].map((pct) => ({
          payer_id: bobId,
          payer_share_pct: pct,
          total_cents: 5000,
          months: { [summary.start.slice(0, 7)]: { groceries: 5000 } },
        })),
      };
      const res = await desk("POST", "/api/desktop/import", only);
      assert.equal(res.status, 201);
      const listed = (await desk("GET", "/api/desktop/household")).data.uploads.filter((u) =>
        u.name.startsWith("Only splits"),
      );
      assert.equal(listed.length, 1);
      assert.equal((await desk("POST", `/api/desktop/uploads/${listed[0].id}/remove`)).status, 200);
      const after = (await alice.get("/api/household")).data.entries;
      for (const id of res.data.splitIds) assert.ok(after.find((e) => e.id === id).voided_at);
    });

    test("bad splits stop the whole upload", async () => {
      const before = (await alice.get("/api/household")).data.entries.length;
      const good = {
        payer_id: aliceId,
        payer_share_pct: 70,
        total_cents: 100,
        months: { [summary.start.slice(0, 7)]: { dining: 100 } },
      };
      for (const bad of [
        { ...good, total_cents: 99 }, // doesn't add up
        { ...good, payer_share_pct: "70" },
        { ...good, payer_id: carolId }, // not in this household
        { ...good, months: { [summary.start.slice(0, 7)]: { income: 100 } } },
      ]) {
        assert.equal(
          (await desk("POST", "/api/desktop/import", { ...upload("Bad split"), splits: [bad] })).status,
          400,
          JSON.stringify(bad),
        );
      }
      assert.equal(
        (await desk("POST", "/api/desktop/import", { ...upload("Too many"), splits: Array(11).fill(good) })).status,
        400,
      );
      assert.equal((await desk("POST", "/api/desktop/import", { ...upload("Not a list"), splits: good })).status, 400);
      assert.equal((await alice.get("/api/household")).data.entries.length, before, "nothing added");
    });

    test("removing can't touch ordinary expenses", async () => {
      assert.equal((await alice.post("/api/entries", expense(aliceId, { name: "Not an import" }))).status, 201);
      const plain = (await alice.get("/api/household")).data.entries.find((e) => e.name === "Not an import");
      assert.equal((await desk("POST", `/api/desktop/uploads/${plain.id}/remove`)).status, 404);
      const after = (await alice.get("/api/household")).data.entries.find((e) => e.id === plain.id);
      assert.equal(after.voided_at, null);
    });

    test("a key only works on the desktop routes, and cookies don't work there", async () => {
      assert.equal((await desk("GET", "/api/household")).status, 401);
      assert.equal((await desk("GET", "/api/account")).status, 401);
      assert.equal((await desk("POST", "/api/entries", expense(aliceId))).status, 401);
      assert.equal((await desk("POST", "/api/household/split", { myShare: 10 })).status, 401);
      assert.equal((await alice.get("/api/desktop/household")).status, 401, "a signed-in browser can't use them");
      assert.equal((await alice.post("/api/desktop/import", upload("Via cookie"))).status, 401);
    });

    test("budgets come from the desktop: on their own with a key, or along with an upload", async () => {
      const budgets = async () => (await bob.get("/api/spending")).data.budgets;
      const set = (b) => desk("POST", "/api/desktop/budgets", { budgets: b });
      assert.equal((await set({ groceries: 80000, dining: 30000 })).status, 200);
      assert.deepEqual(await budgets(), [
        { category: "dining", cents: 30000 },
        { category: "groceries", cents: 80000 },
      ]);
      // Setting them again replaces them; an upload that carries budgets does too.
      assert.equal(
        (await desk("POST", "/api/desktop/import", { ...upload("With budgets"), budgets: { travel: 50000 } })).status,
        201,
      );
      assert.deepEqual(await budgets(), [{ category: "travel", cents: 50000 }]);
      // An upload without them leaves them alone; an empty set clears them.
      assert.equal((await desk("POST", "/api/desktop/import", upload("Without budgets"))).status, 201);
      assert.deepEqual(await budgets(), [{ category: "travel", cents: 50000 }]);
      assert.equal((await set({})).status, 200);
      assert.deepEqual(await budgets(), []);
    });

    test("net worth comes with an upload; only a later month replaces it", async () => {
      const nw = async () => (await bob.get("/api/spending")).data.net_worth;
      const note = (month, cents, previous_month = null, previous_cents = null) => ({
        month,
        cents,
        previous_month,
        previous_cents,
      });
      const send = (name, n) => desk("POST", "/api/desktop/import", { ...upload(name), net_worth: n });
      assert.equal(await nw(), null);
      assert.equal((await send("NW October", note("2026-10", 25240000, "2026-09", 24830000))).status, 201);
      assert.deepEqual(await nw(), note("2026-10", 25240000, "2026-09", 24830000));
      assert.equal((await send("NW August", note("2026-08", 1))).status, 201, "an older summary still imports");
      assert.equal((await nw()).month, "2026-10", "but doesn't take the net worth back");
      assert.equal((await send("NW November", note("2026-11", -5000))).status, 201);
      assert.deepEqual(await nw(), note("2026-11", -5000));
      for (const bad of [
        { ...note("2026-12", 1), accounts: [] },
        note("2026-13", 1),
        note("2026-12", 1.5),
        note("2026-12", 1, "2026-12", 1),
        note("2026-12", 1, "2026-11", null),
        "252400",
      ]) {
        assert.equal((await send("NW bad", bad)).status, 400, JSON.stringify(bad));
      }
      assert.deepEqual(await nw(), note("2026-11", -5000));
    });

    test("bad budgets are refused, and a bad one stops the whole upload", async () => {
      await desk("POST", "/api/desktop/budgets", { budgets: { groceries: 80000 } });
      for (const bad of [
        { nope: 100 },
        { income: 100 },
        { groceries: 0 },
        { groceries: 12.5 },
        { groceries: "1" },
        [],
        null,
      ]) {
        assert.equal((await desk("POST", "/api/desktop/budgets", { budgets: bad })).status, 400, JSON.stringify(bad));
      }
      const uploadsBefore = (await desk("GET", "/api/desktop/household")).data.uploads.length;
      assert.equal(
        (await desk("POST", "/api/desktop/import", { ...upload("Bad budgets"), budgets: { nope: 1 } })).status,
        400,
      );
      assert.equal(
        (await desk("GET", "/api/desktop/household")).data.uploads.length,
        uploadsBefore,
        "nothing imported",
      );
      assert.deepEqual((await alice.get("/api/spending")).data.budgets, [{ category: "groceries", cents: 80000 }]);
    });

    test("the phone can't set budgets itself, except by importing a summary file", async () => {
      assert.equal((await alice.post("/api/budgets", { budgets: { dining: 1 } })).status, 404);
      assert.equal(
        (await alice.post("/api/desktop/budgets", { budgets: { dining: 1 } })).status,
        401,
        "no cookies there",
      );
      const file = { ...upload("From a file"), budgets: { dining: 25000 } };
      delete file.today;
      assert.equal((await alice.post("/api/statements/import", file)).status, 201);
      assert.deepEqual((await alice.get("/api/spending")).data.budgets, [{ category: "dining", cents: 25000 }]);
      assert.deepEqual((await carol.get("/api/spending")).data.budgets, [], "another household's are its own");
    });

    test("wrong, malformed and expired keys are refused", async () => {
      assert.equal((await desk("GET", "/api/desktop/household", undefined, null)).status, 401);
      assert.equal((await desk("GET", "/api/desktop/household", undefined, `split_${"A".repeat(43)}`)).status, 401);
      assert.equal((await desk("GET", "/api/desktop/household", undefined, "not-a-key")).status, 401);
      sql("UPDATE desktop_keys SET expires_at = datetime('now', '-1 day')");
      assert.equal((await desk("GET", "/api/desktop/household")).status, 401);
      sql("UPDATE desktop_keys SET expires_at = datetime('now', '+1 day')");
      assert.equal((await desk("GET", "/api/desktop/household")).status, 200);
    });

    test("the app lists your keys; you can revoke yours, not someone else's", async () => {
      const keys = (await alice.get("/api/account")).data.desktopKeys;
      assert.equal(keys.length, 1);
      assert.equal(keys[0].name, "Test laptop");
      assert.ok(keys[0].last_used_at);
      assert.equal((await bob.get("/api/account")).data.desktopKeys.length, 0);
      assert.equal((await bob.post(`/api/desktop-keys/${keys[0].id}/delete`)).status, 404);
      assert.equal((await alice.post(`/api/desktop-keys/${keys[0].id}/delete`)).status, 200);
      assert.equal((await desk("GET", "/api/desktop/household")).status, 401, "revoked right away");
    });

    test("npm run desktop-key -- --revoke removes them and the saved file", async () => {
      script("alice@x.com");
      assert.equal(
        (await desk("GET", "/api/desktop/household", undefined, JSON.parse(readFileSync(keyFile, "utf8")).key)).status,
        200,
      );
      const said = script("alice@x.com", "--revoke");
      assert.match(said, /Removed 1 desktop key/);
      assert.equal(existsSync(keyFile), false);
    });
  });

  describe("reset", () => {
    const today = new Date().toISOString().slice(0, 10);
    const ours = async () => (await alice.get("/api/household")).data;
    const carolsEntries = async () => (await carol.get("/api/household")).data.entries;

    test("delete voided and edited history: removes only those, only in this household", async () => {
      // Carol (another household) has a voided entry that must survive.
      await carol.post("/api/entries", expense(carolId, { name: "Carol's" }));
      const carolEntry = (await carolsEntries()).find((e) => e.name === "Carol's");
      await carol.post(`/api/entries/${carolEntry.id}/void`);

      // A recurring entry that gets voided and then purged must not come back.
      const rule = await alice.post("/api/recurring", {
        name: "Gym",
        amount_cents: 5000,
        payer_id: aliceId,
        payer_share_pct: 50,
        frequency: "monthly",
        start_date: today,
        today,
      });
      const gym = (await ours()).entries.find((e) => e.recurring_id === rule.data.id);
      await alice.post(`/api/entries/${gym.id}/void`);

      const before = (await ours()).entries;
      const voided = before.filter((e) => e.voided_at).length;
      const active = before
        .filter((e) => !e.voided_at)
        .map((e) => e.id)
        .sort();
      assert.ok(voided >= 3, "there is voided and edited history to purge");

      const res = await bob.post("/api/household/purge-voided");
      assert.equal(res.status, 200);
      assert.equal(res.data.deleted, voided);

      const after = (await ours()).entries;
      assert.equal(after.filter((e) => e.voided_at).length, 0);
      assert.deepEqual(after.map((e) => e.id).sort(), active, "active entries untouched");
      assert.ok(!after.some((e) => e.recurring_id === rule.data.id), "purged recurring entry not recreated");
      assert.ok(
        (await carolsEntries()).some((e) => e.id === carolEntry.id && e.voided_at),
        "other household untouched",
      );
      await alice.post(`/api/recurring/${rule.data.id}/stop`);
    });

    test("delete everything: needs the word DELETE, keeps accounts and settings", async () => {
      assert.equal((await alice.post("/api/household/reset", {})).status, 400);
      assert.equal((await alice.post("/api/household/reset", { confirm: "delete" })).status, 400);
      assert.ok((await ours()).entries.length > 0, "nothing deleted by refused requests");

      await alice.post("/api/household/split", { myShare: 60 });
      await alice.post("/api/recurring", {
        name: "Internet",
        amount_cents: 6000,
        payer_id: aliceId,
        payer_share_pct: 50,
        frequency: "monthly",
        start_date: today,
        today,
      });
      const carolCount = (await carolsEntries()).length;

      const res = await bob.post("/api/household/reset", { confirm: "DELETE" });
      assert.equal(res.status, 200);
      assert.ok(res.data.deletedEntries > 0);
      assert.ok(res.data.deletedRecurring > 0);
      assert.ok(res.data.deletedUploads > 0, "statement uploads are deleted too");
      const sp = (await alice.get("/api/spending")).data;
      assert.equal(sp.batches.length + sp.totals.length + sp.breakdown.length, 0);

      const h = await ours();
      assert.equal(h.entries.length, 0);
      assert.equal(h.recurring.length, 0);
      assert.equal(h.members.length, 2, "both still in the household");
      assert.equal(h.members.find((m) => m.user_id === aliceId).share_pct, 60, "default split kept");
      assert.match(h.inviteCode, /^[0-9a-f]{16}$/);
      assert.equal((await carolsEntries()).length, carolCount, "other household untouched");
      // Still usable afterwards.
      assert.equal((await alice.post("/api/entries", expense(aliceId))).status, 201);
      await alice.post("/api/household/split", { myShare: 50 });
    });

    test("outsiders can't reset or purge anyone else's household", async () => {
      const outsider = new Client();
      assert.equal((await outsider.post("/api/household/reset", { confirm: "DELETE" })).status, 401);
      assert.equal((await outsider.post("/api/household/purge-voided")).status, 401);
      assert.equal(
        (await alice.post("/api/household/reset", { confirm: "DELETE" }, { origin: "https://evil.example" })).status,
        403,
      );
      assert.equal((await ours()).entries.length, 1, "the entry from the previous test is still there");
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

  describe("passkeys", () => {
    const origin = BASE;
    let alicePasskey;
    const account = async (c) => (await c.get("/api/account")).data;
    /** Run a whole passkey sign-in on a fresh client; returns [response status, client]. */
    const passkeyLogin = async (pk, knobs) => {
      const c = new Client();
      const options = (await c.post("/api/passkeys/login/options")).data;
      const res = await c.post("/api/passkeys/login/verify", { response: await pk.get(options, knobs) });
      return [res.status, c, res];
    };
    const addPasskey = async (c, pk, knobs) => {
      const options = (await c.post("/api/passkeys/register/options")).data;
      return c.post("/api/passkeys/register/verify", { response: await pk.create(options, knobs), name: "Test phone" });
    };

    test("an account starts with a password and no passkeys", async () => {
      assert.deepEqual(await account(alice), { passwordEnabled: true, passkeys: [], desktopKeys: [] });
      assert.equal((await new Client().get("/api/account")).status, 401);
    });

    test("adding a passkey stores only the public key, once", async () => {
      alicePasskey = await new FakePasskey({ origin }).init();
      const options = (await alice.post("/api/passkeys/register/options")).data;
      assert.equal(options.rp.id, "localhost");
      assert.equal(options.authenticatorSelection.userVerification, "required");
      assert.equal(options.authenticatorSelection.residentKey, "required");
      const response = await alicePasskey.create(options);
      assert.equal((await alice.post("/api/passkeys/register/verify", { response, name: "Test phone" })).status, 201);
      assert.equal(
        (await alice.post("/api/passkeys/register/verify", { response, name: "Again" })).status,
        400,
        "the same response can't be used twice: its challenge is gone",
      );
      const { passkeys } = await account(alice);
      assert.equal(passkeys.length, 1);
      assert.equal(passkeys[0].id, alicePasskey.id);
      assert.equal(passkeys[0].name, "Test phone");
      // The next options exclude it, so the same device isn't registered twice.
      const again = (await alice.post("/api/passkeys/register/options")).data;
      assert.deepEqual(
        again.excludeCredentials.map((c) => c.id),
        [alicePasskey.id],
      );
    });

    test("adding a passkey refuses a wrong site, a missing Face ID, and signed-out callers", async () => {
      const pk = await new FakePasskey({ origin }).init();
      assert.equal((await addPasskey(alice, pk, { origin: "https://evil.example" })).status, 400, "phishing site");
      assert.equal((await addPasskey(alice, pk, { flags: 0x01 | 0x40 })).status, 400, "no user verification");
      assert.equal((await new Client().post("/api/passkeys/register/options")).status, 401);
      assert.equal((await account(alice)).passkeys.length, 1, "nothing was added");
    });

    test("signing in with a passkey starts a normal session", async () => {
      const [status, c] = await passkeyLogin(alicePasskey);
      assert.equal(status, 200);
      assert.equal((await c.get("/api/me")).data.user.id, aliceId);
      assert.ok((await account(alice)).passkeys[0].last_used_at, "last use is recorded");
    });

    test("passkey sign-in refuses replays, forgeries and look-alikes", async () => {
      const c = new Client();
      const options = (await c.post("/api/passkeys/login/options")).data;
      assert.deepEqual(options.allowCredentials, [], "no email needed: the phone offers its passkey");
      const response = await alicePasskey.get(options);
      assert.equal((await c.post("/api/passkeys/login/verify", { response })).status, 200);
      assert.equal((await new Client().post("/api/passkeys/login/verify", { response })).status, 401, "replay");

      assert.equal((await passkeyLogin(alicePasskey, { origin: "https://evil.example" }))[0], 401, "wrong site");
      assert.equal((await passkeyLogin(alicePasskey, { rpID: "evil.example" }))[0], 401, "wrong domain hash");
      assert.equal((await passkeyLogin(alicePasskey, { flags: 0x01 }))[0], 401, "no Face ID");
      const stranger = await new FakePasskey({ origin }).init();
      stranger.id = alicePasskey.id; // claims to be Alice's passkey, signs with another key
      assert.equal((await passkeyLogin(stranger, { userHandle: alicePasskey.userHandle }))[0], 401, "wrong key");
      const unknown = await new FakePasskey({ origin }).init();
      assert.equal((await passkeyLogin(unknown))[0], 401, "a passkey this app never saw");
      assert.equal(
        (await passkeyLogin(alicePasskey, { userHandle: Buffer.from(bobId).toString("base64url") }))[0],
        401,
        "made for a different account",
      );
    });

    test("an expired challenge doesn't work", async () => {
      const c = new Client();
      const options = (await c.post("/api/passkeys/login/options")).data;
      sql(
        `UPDATE auth_challenges SET expires_at = datetime('now', '-1 minute') WHERE challenge = '${options.challenge}'`,
      );
      assert.equal(
        (await c.post("/api/passkeys/login/verify", { response: await alicePasskey.get(options) })).status,
        401,
      );
    });

    test("sensitive changes need a recent confirmation, by password or passkey", async () => {
      sql(`UPDATE sessions SET confirmed_at = datetime('now', '-10 minutes')`);
      const res = await alice.post("/api/passkeys/register/options");
      assert.equal(res.status, 403);
      assert.equal(res.data.code, "confirm");
      assert.equal((await alice.post("/api/password/disable")).status, 403);

      assert.equal((await alice.post("/api/confirm", { password: "wrong" })).status, 400);
      assert.equal((await alice.post("/api/confirm", { password: "  spaced pw  " })).status, 200);
      assert.equal((await alice.post("/api/passkeys/register/options")).status, 200, "confirmed now");

      sql(`UPDATE sessions SET confirmed_at = NULL`);
      const options = (await alice.post("/api/confirm/options")).data;
      assert.deepEqual(
        options.allowCredentials.map((c) => c.id),
        [alicePasskey.id],
        "only her own passkeys",
      );
      assert.equal((await alice.post("/api/confirm", { response: await alicePasskey.get(options) })).status, 200);
      assert.equal((await alice.post("/api/passkeys/register/options")).status, 200);

      // Bob can't confirm his session with Alice's passkey.
      assert.equal((await bob.post("/api/confirm/options")).status, 409, "Bob has no passkey");
      const bobOptions = { challenge: "AAAA" };
      assert.equal((await bob.post("/api/confirm", { response: await alicePasskey.get(bobOptions) })).status, 401);
    });

    test("turning off password sign-in: needs a passkey, then passwords stop working", async () => {
      sql(`UPDATE sessions SET confirmed_at = datetime('now')`);
      assert.equal((await bob.post("/api/password/disable")).status, 409, "Bob has no passkey yet");

      assert.equal((await alice.post("/api/password/disable")).status, 200);
      assert.equal((await account(alice)).passwordEnabled, false);
      const login = await new Client().post("/api/login", { email: "alice@x.com", password: "  spaced pw  " });
      assert.equal(login.status, 401);
      assert.match(login.data.error, /passkey/);
      assert.equal((await alice.post("/api/password", { current: "  spaced pw  ", next: "whatever1" })).status, 409);
      assert.equal(
        (await alice.post("/api/confirm", { password: "  spaced pw  " })).status,
        409,
        "can't confirm by password",
      );
      assert.equal((await passkeyLogin(alicePasskey))[0], 200, "the passkey still works");
    });

    test("the last way in can't be removed; turning the password back on works", async () => {
      sql(`UPDATE sessions SET confirmed_at = datetime('now')`);
      assert.equal((await alice.post(`/api/passkeys/${alicePasskey.id}/delete`)).status, 409, "only way to sign in");
      assert.equal((await alice.post("/api/password/enable", { next: "short" })).status, 400);
      assert.equal((await alice.post("/api/password/enable", { next: "a new password" })).status, 200);
      assert.equal(
        (await new Client().post("/api/login", { email: "alice@x.com", password: "a new password" })).status,
        200,
      );
      assert.equal((await bob.post(`/api/passkeys/${alicePasskey.id}/delete`)).status, 404, "not Bob's to remove");
      assert.equal((await alice.post(`/api/passkeys/${alicePasskey.id}/delete`)).status, 200);
      assert.equal((await account(alice)).passkeys.length, 0);
      assert.equal((await passkeyLogin(alicePasskey))[0], 401, "a removed passkey no longer signs in");
    });
  });
});
