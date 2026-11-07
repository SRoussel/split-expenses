// The one place that decides how much the other person owes for an entry.
// Used by both the browser (to show a preview) and the Worker (which is the
// authority and recomputes it, never trusting the client).

export type EntryKind = "expense" | "settlement" | "opening";

/**
 * Convert a percentage like 33.33 to whole basis points (3333) so the math is
 * exact integers. Returns null if it isn't a number in 0..100 with at most
 * two decimal places.
 */
export function pctToBasisPoints(pct: number): number | null {
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  const bp = Math.round(pct * 100);
  return Math.abs(pct * 100 - bp) < 1e-6 ? bp : null;
}

/**
 * How much the other person (the non-payer) owes payer_id because of this entry.
 *  - expense: the payer covered all of it and is responsible for payerSharePct.
 *    The other person owes the rest, rounded half up to the cent. Any odd half
 *    cent therefore goes to the non-payer; the payer gets the one-cent discount.
 *    (This is the Python script's rule: the non-payer's part is rounded, the
 *    payer's part is the remainder.)
 *  - settlement / opening: the whole amount.
 * Throws if the percentage is invalid.
 */
export function owedCents(kind: EntryKind, amountCents: number, payerSharePct = 50): number {
  if (kind !== "expense") return amountCents;
  const bp = pctToBasisPoints(payerSharePct);
  if (bp === null) throw new RangeError("Share must be between 0 and 100 with at most two decimals.");
  // Integer math: round_half_up(amount * (100 - pct) / 100) without floating point.
  return Math.floor((amountCents * (10_000 - bp) + 5_000) / 10_000);
}
