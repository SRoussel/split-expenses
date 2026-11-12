-- Net worth for the Home screen: one total per household at the end of a month, and the
-- month before, worked out on the desktop page from its accounts and sent along with a
-- statement summary. Only these numbers come here, never the accounts. The latest month
-- wins, so importing an older summary afterwards doesn't take it back.
CREATE TABLE net_worth (
  household_id   TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  month          TEXT NOT NULL,
  cents          INTEGER NOT NULL,
  previous_month TEXT,
  previous_cents INTEGER,
  updated_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
