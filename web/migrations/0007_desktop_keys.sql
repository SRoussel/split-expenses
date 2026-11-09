-- Desktop keys: let the desktop app (split-insights) send statement summaries straight
-- to the app. Made on the computer with `npm run desktop-key`, which needs the Cloudflare
-- login that deploys the app. A key only works on /api/desktop/*: listing, importing and
-- replacing statement uploads. Only a hash is stored, like session tokens.
CREATE TABLE desktop_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at   TEXT NOT NULL
);
CREATE INDEX desktop_keys_user ON desktop_keys (user_id);
