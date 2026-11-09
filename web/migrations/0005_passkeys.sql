-- Passkeys: sign in with Face ID / Touch ID instead of a password.
--
--   passkeys         one row per registered passkey. Only the PUBLIC key is stored:
--                    it can check a signature but never make one, so this table is
--                    useless to anyone who steals it.
--   auth_challenges  one-time random challenges for adding a passkey or signing in
--                    with one. Each is deleted the moment it's used, and expires after
--                    5 minutes, so a captured response can't be replayed.
--   users.password_disabled   1 = this person turned off password sign-in (they have
--                    a passkey). `npm run reset-password` turns it back on.
--   sessions.confirmed_at     when this session last proved who it is (signed in, or
--                    re-entered the password / used a passkey). Adding or removing a
--                    passkey and turning password sign-in on or off need it to be recent,
--                    so a stolen session cookie can't quietly add the thief's own passkey.

CREATE TABLE passkeys (
  id           TEXT PRIMARY KEY,               -- credential ID, base64url, chosen by the device
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key   TEXT NOT NULL,                  -- COSE public key, base64url
  sign_count   INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,                           -- JSON list, a hint for the browser
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX passkeys_user_idx ON passkeys (user_id);

CREATE TABLE auth_challenges (
  challenge  TEXT PRIMARY KEY,                 -- base64url, 32 random bytes
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,  -- empty when signing in
  purpose    TEXT NOT NULL CHECK (purpose IN ('register', 'login', 'confirm')),
  expires_at TEXT NOT NULL
);

ALTER TABLE users ADD COLUMN password_disabled INTEGER NOT NULL DEFAULT 0;

-- Existing sessions start out unconfirmed: the first sensitive action asks once.
ALTER TABLE sessions ADD COLUMN confirmed_at TEXT;
