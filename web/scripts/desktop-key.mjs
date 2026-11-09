// Make a desktop key, so the desktop app (split-insights) can send statement summaries
// straight to the app instead of as a file. It uses your Cloudflare login (the one that
// deploys the app) to add the key to the database, and saves it for the desktop app in
// desktop-data/app.json, which only you can read and git ignores.
//
//   npm run desktop-key -- you@example.com --remote --url https://ledger.you.workers.dev
//   npm run desktop-key -- you@example.com            # the local database, for trying it out
//   npm run desktop-key -- you@example.com --remote --revoke   # remove all your desktop keys
//
// The key only works for statement uploads. It expires in a year; see and revoke keys in
// the app under More > Passkeys and sign-in.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const remote = flag("--remote");
const out = resolve(option("--out") ?? new URL("../../desktop-data/app.json", import.meta.url).pathname);
const persist = option("--persist-to"); // for the tests
const valued = new Set(["--url", "--name", "--out", "--persist-to"]);
const email = args
  .find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]))
  ?.trim()
  .toLowerCase();
if (!email || !email.includes("@")) {
  console.error(
    "Usage: npm run desktop-key -- <your email> [--remote --url <the app's address>] [--name <label>] [--revoke]",
  );
  process.exit(1);
}

const previous = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
const url = (option("--url") ?? (remote ? previous.url : "http://localhost:8787"))?.replace(/\/+$/, "");
// HTTPS only, so the key never travels in the clear (plain HTTP just to this computer).
const safe = /^https:\/\/[^/\s]+$/.test(url ?? "") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url ?? "");
if (!flag("--revoke") && !safe) {
  console.error("Say where the app is, starting with https:// : --url https://… (the address you open on your phone).");
  process.exit(1);
}

const quote = (s) => `'${s.replace(/'/g, "''")}'`;
function d1(sql) {
  const where = remote ? ["--remote"] : ["--local", ...(persist ? ["--persist-to", persist] : [])];
  const json = execFileSync("npx", ["wrangler", "d1", "execute", "ledger", ...where, "--json", "--command", sql], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });
  return JSON.parse(json).flatMap((r) => r.results ?? []);
}

const user = `(SELECT id FROM users WHERE email = ${quote(email)})`;

if (flag("--revoke")) {
  const [{ removed }] = d1(`DELETE FROM desktop_keys WHERE user_id = ${user}; SELECT changes() AS removed;`).slice(-1);
  if (existsSync(out)) rmSync(out);
  console.log(`Removed ${removed} desktop key(s) for ${email}, and ${out}.`);
  process.exit(0);
}

const key = `split_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(key).digest("hex");
const name = option("--name") ?? `Desktop, ${new Date().toISOString().slice(0, 10)}`;
const [{ added }] = d1(
  `INSERT INTO desktop_keys (id, user_id, name, key_hash, expires_at) ` +
    `SELECT ${quote(randomUUID())}, id, ${quote(name)}, ${quote(hash)}, datetime('now', '+365 days') ` +
    `FROM users WHERE email = ${quote(email)}; SELECT changes() AS added;`,
).slice(-1);
if (!added) {
  console.error(`No account has the email ${email}.`);
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ url, key }, null, 2) + "\n", { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`Made a desktop key "${name}" for ${email}, saved in ${out} (only you can read it).`);
console.log("The desktop app can now send summaries to " + url + ". Restart split-insights if it's running.");
