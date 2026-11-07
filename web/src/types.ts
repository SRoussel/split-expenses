export type { EntryKind } from "../shared/owed";
import type { EntryKind } from "../shared/owed";

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
}

export interface NewEntry {
  household_id: string;
  kind: EntryKind;
  entry_date: string;
  name: string;
  amount_cents: number;
  payer_id: string;
  payer_share_pct: number | null;
  owed_cents: number;
}

export interface Member {
  user_id: string;
  display_name: string;
}
