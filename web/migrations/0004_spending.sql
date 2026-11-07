-- Spending by category and cash flow. Only totals per (month, category) are
-- stored: never individual transactions, merchants or purchase dates.

-- A category on manually added and recurring shared expenses (optional).
ALTER TABLE entries ADD COLUMN category TEXT;
ALTER TABLE recurring ADD COLUMN category TEXT;

-- For a shared entry imported from a statement: its total split by month and
-- category. Amounts can be negative where returns outweigh purchases.
CREATE TABLE entry_breakdown (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  month    TEXT NOT NULL, -- YYYY-MM
  category TEXT NOT NULL,
  cents    INTEGER NOT NULL,
  PRIMARY KEY (entry_id, month, category)
);

-- One person's spending and income from one statement upload. Visible to both
-- members of the household, like everything else.
CREATE TABLE spending_batches (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  person_id    TEXT NOT NULL REFERENCES users(id),      -- whose statement it is
  name         TEXT NOT NULL,
  start_date   TEXT NOT NULL,                           -- the period it covers
  end_date     TEXT NOT NULL,
  entry_id     TEXT REFERENCES entries(id) ON DELETE SET NULL, -- shared entry from the same import, if any
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- The same statement can't be uploaded twice for the same person.
CREATE UNIQUE INDEX one_batch_name_per_person ON spending_batches (household_id, person_id, name);

CREATE TABLE spending_totals (
  batch_id TEXT NOT NULL REFERENCES spending_batches(id) ON DELETE CASCADE,
  month    TEXT NOT NULL, -- YYYY-MM
  category TEXT NOT NULL, -- a spending category, or 'income'
  cents    INTEGER NOT NULL,
  PRIMARY KEY (batch_id, month, category)
);
