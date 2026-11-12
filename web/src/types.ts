export type { EntryKind } from "../shared/owed";
import type { EntryKind } from "../shared/owed";
import type { Frequency } from "../shared/recurring";

export interface Entry {
  id: string;
  household_id: string;
  kind: EntryKind;
  entry_date: string; // YYYY-MM-DD
  name: string;
  amount_cents: number;
  payer_id: string;
  payer_share_pct: number | null;
  owed_cents: number;
  created_by: string;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  /** Set when the entry was edited: the id of the entry that replaced it. */
  replaced_by: string | null;
  /** Set when a recurring expense added this entry. */
  recurring_id: string | null;
  occurrence_date: string | null;
  /** Optional spending category (expenses only). Imported statements use a breakdown instead. */
  category: string | null;
}

/** A recurring expense rule. Its entries are added when the app is opened on or after each date. */
export interface Recurring {
  id: string;
  name: string;
  amount_cents: number;
  payer_id: string;
  payer_share_pct: number;
  frequency: Frequency;
  start_date: string;
  next_date: string;
  paused: boolean;
  created_by: string;
  category: string | null;
}

/** What the app sends to create or change a recurring expense. */
export interface RecurringInput {
  name: string;
  amount_cents: number;
  payer_id: string;
  payer_share_pct: number;
  category: string | null;
}

/** What the app sends to add or edit an entry. The server works out what's owed. */
export interface NewEntry {
  kind: EntryKind;
  entry_date: string;
  name: string;
  amount_cents: number;
  payer_id: string;
  payer_share_pct: number | null;
  category?: string | null;
}

export interface Member {
  user_id: string;
  display_name: string;
  /** The share of each expense this person normally pays (default split). */
  share_pct: number;
}

/** One person's spending and income from one statement upload (totals only). */
export interface SpendingBatch {
  id: string;
  person_id: string;
  name: string;
  start_date: string;
  end_date: string;
  entry_id: string | null;
  created_by: string;
  created_at: string;
}

export interface SpendingData {
  batches: SpendingBatch[];
  totals: { batch_id: string; month: string; category: string; cents: number }[];
  /** Month/category split of imported shared entries (active ones only). */
  breakdown: { entry_id: string; month: string; category: string; cents: number }[];
  /** The household's monthly budgets, by spending category. */
  budgets?: { category: string; cents: number }[];
  /** Net worth at a month's end (and the month before), sent from the desktop page. */
  net_worth?: { month: string; cents: number; previous_month: string | null; previous_cents: number | null } | null;
}
