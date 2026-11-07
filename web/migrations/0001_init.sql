-- D1 (SQLite) schema. Applied with `npm run db:migrate:local` / `db:migrate:remote`.
--
-- Model:
--   users       sign-in accounts
--   sessions    one row per signed-in browser (token is stored hashed)
--   households  one row for the two of you
--   members     which users belong to a household (max 2), with a display name
--   auth_attempts  log used for throttling (see the end of this file)
--   entries     the ledger. Every row has:
--                 payer_id    the person who is OWED money by this entry
--                             (expense: who paid, settlement: who paid,
--                              opening: the person the other one owes)
--                 owed_cents  how much the other person owes payer_id because of this row
--               A person's balance = sum(owed_cents where they are payer_id)
--                                  - sum(owed_cents where they are not).

CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  password_salt       TEXT NOT NULL,
  -- PBKDF2 work factor this hash was made with, so PBKDF2_ITERATIONS in
  -- wrangler.jsonc can change later; hashes are redone at the next sign-in.
  password_iterations INTEGER NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE households (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT 'Our ledger',
  invite_code TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE members (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, user_id)
);

CREATE TABLE entries (
  id              TEXT PRIMARY KEY,
  household_id    TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('expense', 'settlement', 'opening')),
  entry_date      TEXT NOT NULL,
  name            TEXT NOT NULL CHECK (length(trim(name)) > 0),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  payer_id        TEXT NOT NULL REFERENCES users(id),
  payer_share_pct REAL CHECK (payer_share_pct BETWEEN 0 AND 100),
  owed_cents      INTEGER NOT NULL CHECK (owed_cents >= 0),
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  voided_at       TEXT,
  voided_by       TEXT REFERENCES users(id),
  CHECK (owed_cents <= amount_cents)
);
CREATE INDEX entries_household_idx ON entries (household_id, entry_date DESC, created_at DESC);

-- At most one active (not voided) starting balance per household. This also
-- stops two simultaneous requests from both creating one.
CREATE UNIQUE INDEX one_active_opening
  ON entries (household_id)
  WHERE kind = 'opening' AND voided_at IS NULL;

-- Attempt log used to throttle sign-in, sign-up, password changes and
-- invite-code guessing. Rows older than a day are deleted as new ones arrive.
CREATE TABLE auth_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX auth_attempts_idx ON auth_attempts (bucket, created_at);
