// "Redact amounts" (More menu): every amount on screen shows as dots, for showing the app to
// someone without showing them your numbers. It only changes what's displayed: exports, the
// balance and everything sent to the server are untouched. Remembered on this device only.

const KEY = "split.redact";
/** What a redacted amount looks like. Always the same length, so it gives nothing away. */
export const DOTS = "•••••";

let on = false;
try {
  on = typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "1";
} catch {
  // Storage blocked (private mode): start unredacted.
}
mark();

export const isRedacted = () => on;

/** A percentage worked out from your amounts ("kept 22%", "▲ 12% vs avg"), hidden while redacted. */
export const moneyPercent = (whole: number) => (on ? "••%" : `${whole}%`);

export function setRedacted(value: boolean) {
  on = value;
  try {
    if (value) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // Not remembered, but still applies until the app is closed.
  }
  mark();
}

// Lets the stylesheet hide what's typed in amount fields too.
function mark() {
  if (typeof document !== "undefined") document.documentElement.classList.toggle("redacted", on);
}
