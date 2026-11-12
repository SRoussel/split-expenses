const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdRound = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** "$1,234.56"; negatives get a real minus sign. */
export const money = (cents: number) => (cents < 0 ? "−" : "") + usd.format(Math.abs(cents) / 100);

/** "$1,235": for headline figures, where cents are noise. */
export const moneyRound = (cents: number) => (cents < 0 ? "−" : "") + usdRound.format(Math.abs(cents) / 100);

/** "$1.2K", "$12K", "$1.5M": axis labels only. */
export function moneyCompact(cents: number): string {
  const d = Math.abs(cents) / 100;
  const sign = cents < 0 ? "−" : "";
  if (d >= 10_000_000) return `${sign}$${Math.round(d / 1_000_000)}M`;
  if (d >= 1_000_000) return `${sign}$${(d / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (d >= 10_000) return `${sign}$${Math.round(d / 1000)}K`;
  if (d >= 1000) return `${sign}$${(d / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${sign}$${Math.round(d)}`;
}

export const percent = (x: number) => `${Math.round(x * 100)}%`;

const monthShort = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const monthLong = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const asDate = (s: string) => new Date(`${s.length === 7 ? `${s}-01` : s}T00:00:00Z`);

/** "2026-03" -> "Mar" */
export const monthLabel = (m: string) => monthShort.format(asDate(m));
/** "2026-03" -> "March 2026" */
export const monthName = (m: string) => monthLong.format(asDate(m));
/** "2026-03-14" -> "Mar 14" */
export const dayLabel = (d: string) => dayFmt.format(asDate(d));

/** "Mar 2026 – Oct 2026", or "Mar – Oct 2026" within a year. */
export function rangeLabel(from: string, to: string): string {
  if (from === to) return monthName(from);
  const [fy, ty] = [from.slice(0, 4), to.slice(0, 4)];
  return fy === ty
    ? `${monthLabel(from)} – ${monthLabel(to)} ${ty}`
    : `${monthLabel(from)} ${fy} – ${monthLabel(to)} ${ty}`;
}

export const categoryLabel = (c: string) => c.charAt(0).toUpperCase() + c.slice(1);

export const personLabel = (p: string, me: string) => (p === me ? "You" : p.charAt(0).toUpperCase() + p.slice(1));
