// Dates for recurring expenses. Used by the Worker (to create entries) and the app
// (to show "next on ..."), so both always agree. Dates are plain YYYY-MM-DD days.

export type Frequency = "weekly" | "monthly" | "yearly";
export const FREQUENCIES: Frequency[] = ["weekly", "monthly", "yearly"];

/** Most past-due occurrences created in one go (a safety cap, ~5 years of monthly). */
export const MAX_CATCH_UP = 60;

const pad = (n: number) => String(n).padStart(2, "0");
const daysInMonth = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

function parse(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

function format(utc: Date): string {
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
}

/**
 * The date of occurrence number `k` (0 = the start date). Always counted from the
 * start date, so a rule on the 31st goes Jan 31, Feb 28, Mar 31 rather than
 * drifting to the 28th forever. Feb 29 yearly becomes Feb 28 in other years.
 */
export function occurrenceDate(start: string, frequency: Frequency, k: number): string {
  const [y, m, d] = parse(start);
  if (frequency === "weekly") return format(new Date(Date.UTC(y, m - 1, d + 7 * k)));
  const month0 = frequency === "monthly" ? m - 1 + k : m - 1;
  const year = frequency === "monthly" ? y + Math.floor(month0 / 12) : y + k;
  const m0 = ((month0 % 12) + 12) % 12;
  return format(new Date(Date.UTC(year, m0, Math.min(d, daysInMonth(year, m0)))));
}

/** Occurrences from index `from` whose date is on or before `today`, oldest first (capped). */
export function dueOccurrences(start: string, frequency: Frequency, from: number, today: string) {
  const due: { index: number; date: string }[] = [];
  for (let k = from; due.length < MAX_CATCH_UP; k++) {
    const date = occurrenceDate(start, frequency, k);
    if (date > today) break;
    due.push({ index: k, date });
  }
  return due;
}

/** The first occurrence index whose date is on or after `today` (used when resuming). */
export function firstIndexOnOrAfter(start: string, frequency: Frequency, from: number, today: string): number {
  let k = from;
  while (occurrenceDate(start, frequency, k) < today) k++;
  return k;
}

const ORDINAL = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/** "Monthly on the 1st", "Weekly on Mondays", "Yearly on Mar 5". */
export function describeSchedule(start: string, frequency: Frequency): string {
  const [y, m, d] = parse(start);
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (frequency === "weekly") {
    return `Weekly on ${utc.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}s`;
  }
  if (frequency === "monthly") return `Monthly on the ${ORDINAL(d)}${d > 28 ? " (or the last day)" : ""}`;
  return `Yearly on ${utc.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}
