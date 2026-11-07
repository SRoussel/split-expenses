// Reset someone's password from your computer (there's no email, so this is the
// "forgot password" path). It also signs that person out everywhere.
//
//   npm run reset-password -- someone@example.com           # local database
//   npm run reset-password -- someone@example.com --remote  # the deployed one
//
// It asks for the new password; nothing is sent anywhere except to D1 via wrangler.

import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();
if (!email || !email.includes("@")) {
  console.error("Usage: npm run reset-password -- <email> [--remote]");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question("New password (at least 8 characters, shown as you type): ");
rl.close();
if (password.length < 8) {
  console.error("Too short.");
  process.exit(1);
}

// Must match worker/index.ts: PBKDF2-SHA256, 16-byte salt, 32-byte hash, hex.
// Use the same work factor the Worker is configured with, so the first sign-in doesn't rehash.
const configured = /"PBKDF2_ITERATIONS"\s*:\s*"(\d+)"/.exec(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
const iterations = configured ? Number(configured[1]) : 20000;
const salt = randomBytes(16).toString("hex");
const hash = pbkdf2Sync(password, Buffer.from(salt, "hex"), iterations, 32, "sha256").toString("hex");
const quoted = `'${email.replace(/'/g, "''")}'`;

const sql =
  `UPDATE users SET password_hash = '${hash}', password_salt = '${salt}', password_iterations = ${iterations} ` +
  `WHERE email = ${quoted}; ` +
  `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ${quoted}); ` +
  `SELECT count(*) AS matched FROM users WHERE email = ${quoted};`;

execFileSync("npx", ["wrangler", "d1", "execute", "ledger", remote ? "--remote" : "--local", "--command", sql], {
  stdio: "inherit",
});
console.log('\nIf "matched" above is 1, the password is reset. If it is 0, no account has that email.');
