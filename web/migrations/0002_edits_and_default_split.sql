-- Default split: the share of each expense this member normally pays.
-- The two members' shares always add up to 100 (set together via /api/household/split).
ALTER TABLE members ADD COLUMN share_pct REAL NOT NULL DEFAULT 50 CHECK (share_pct BETWEEN 0 AND 100);

-- Edits: an edited entry is voided and points at the entry that replaced it,
-- so the history shows what changed instead of silently overwriting it.
ALTER TABLE entries ADD COLUMN replaced_by TEXT;
