-- Recurring expenses: a rule that adds the same expense on a schedule.
-- Entries are created when either of you opens the app (any that are due and
-- not yet created), never by a background job.
CREATE TABLE recurring (
  id              TEXT PRIMARY KEY,
  household_id    TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(trim(name)) > 0),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  payer_id        TEXT NOT NULL REFERENCES users(id),
  payer_share_pct REAL NOT NULL CHECK (payer_share_pct BETWEEN 0 AND 100),
  frequency       TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'yearly')),
  start_date      TEXT NOT NULL,              -- first occurrence; sets the day of the week/month
  next_index      INTEGER NOT NULL DEFAULT 0, -- next occurrence not created yet (0 = start_date)
  next_date       TEXT NOT NULL,              -- its date, kept alongside so "what's due" is a simple query
  paused          INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  stopped_at      TEXT                        -- stopped rules are kept so past entries can still point at them
);
CREATE INDEX recurring_due_idx ON recurring (household_id, next_date);

ALTER TABLE entries ADD COLUMN recurring_id TEXT REFERENCES recurring(id);
ALTER TABLE entries ADD COLUMN occurrence_date TEXT;

-- Each occurrence of a rule exists at most once, voided or edited rows included,
-- so a voided month never comes back and two phones opening at once can't double it.
CREATE UNIQUE INDEX one_entry_per_occurrence
  ON entries (recurring_id, occurrence_date)
  WHERE recurring_id IS NOT NULL;
