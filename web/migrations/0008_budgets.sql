-- Budgets: a monthly amount per spending category for the household, shared by both
-- people. This month's spending is measured against them on the Home screen. They're
-- set on the desktop page and arrive with statement uploads (or on their own with a
-- desktop key). Like the default split, they're a setting: resetting the household keeps them.
CREATE TABLE budgets (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  cents        INTEGER NOT NULL CHECK (cents > 0),
  updated_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, category)
);
