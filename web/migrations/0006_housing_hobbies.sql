-- Categories: "housing" and "hobbies" are new; "subscriptions" and "fees" are retired.
-- Their amounts move to "other" (only totals are stored here, so there's no telling
-- which subscription was which). Where a month already has "other", the amounts add up.

UPDATE entries SET category = 'other' WHERE category IN ('subscriptions', 'fees');
UPDATE recurring SET category = 'other' WHERE category IN ('subscriptions', 'fees');

INSERT INTO entry_breakdown (entry_id, month, category, cents)
  SELECT entry_id, month, 'other', SUM(cents) FROM entry_breakdown
  WHERE category IN ('subscriptions', 'fees')
  GROUP BY entry_id, month
  ON CONFLICT (entry_id, month, category) DO UPDATE SET cents = cents + excluded.cents;
DELETE FROM entry_breakdown WHERE category IN ('subscriptions', 'fees');

INSERT INTO spending_totals (batch_id, month, category, cents)
  SELECT batch_id, month, 'other', SUM(cents) FROM spending_totals
  WHERE category IN ('subscriptions', 'fees')
  GROUP BY batch_id, month
  ON CONFLICT (batch_id, month, category) DO UPDATE SET cents = cents + excluded.cents;
DELETE FROM spending_totals WHERE category IN ('subscriptions', 'fees');
