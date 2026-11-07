import { useState, type ChangeEvent } from "react";
import { addEntry } from "./api";
import { pctText } from "./forms";
import {
  fmt,
  MAX_SUMMARY_BYTES,
  owedCents,
  parseSummary,
  payerSharePct,
  SHARE_ERROR,
  summaryToEntry,
  todayLocal,
  type ImportSummary as Summary,
} from "./ledger";
import type { Entry, Member } from "./types";
import { ErrorText, Segmented } from "./ui";

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Imports a statement as one entry, from the split_summary.json made on your
 * computer by `uv run split-ledger summarize`. The detailed transactions file
 * is refused, so individual purchases never reach the app. Only the name and
 * total are saved; the category totals are shown here and nowhere else.
 */
export default function ImportSummary({
  me,
  partner,
  entries,
  onSaved,
}: {
  me: Member;
  partner: Member;
  entries: Entry[];
  onSaved: () => void;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [name, setName] = useState("");
  const [payer, setPayer] = useState<"me" | "partner">("me");
  const [myShare, setMyShare] = useState(pctText(me.share_pct));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // so choosing the same file again still triggers
    if (!file) return;
    setError(null);
    setSummary(null);
    try {
      // A summary is tiny; a big file is almost certainly the detailed one.
      if (file.size > MAX_SUMMARY_BYTES) {
        throw new Error(
          "That file is too big to be a statement summary. Run `uv run split-ledger summarize split_transactions.csv` and choose the split_summary.json it makes.",
        );
      }
      const s = parseSummary(await file.text());
      setSummary(s);
      setName(s.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file.");
    }
  }

  const payerShare = payerSharePct(myShare, payer);
  const duplicate = summary !== null && entries.some((e) => !e.voided_at && e.name === name.trim());

  async function save() {
    if (!summary) return;
    if (!name.trim()) return setError("Give the entry a name.");
    if (payerShare === null) return setError(SHARE_ERROR);
    if (duplicate) return setError("There's already an entry with that name. Change the name to add it anyway.");
    setBusy(true);
    setError(null);
    try {
      const payerId = payer === "me" ? me.user_id : partner.user_id;
      await addEntry(summaryToEntry({ ...summary, name: name.trim() }, payerId, payerShare, todayLocal()));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const owed = summary && payerShare !== null ? owedCents("expense", summary.totalCents, payerShare) : null;

  return (
    <div className="stack">
      <p className="muted">
        On your computer, run <code>uv run split-ledger summarize split_transactions.csv</code>, then choose the{" "}
        <code>split_summary.json</code> it makes. Your individual transactions stay on your computer.
      </p>
      <input type="file" accept=".json,application/json" onChange={onFile} />
      <ErrorText message={error} />

      {summary && (
        <>
          <div className="card stack">
            <strong>{summary.name}</strong>
            <span className="muted">
              {summary.count} transaction{summary.count === 1 ? "" : "s"}, {shortDate(summary.start)} – {shortDate(summary.end)}
            </span>
            <ul className="plain">
              {summary.byCategory &&
                Object.entries(summary.byCategory)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([cat, cents]) => (
                    <li key={cat} className="row">
                      <span>{cat}</span>
                      <span>{fmt(cents)}</span>
                    </li>
                  ))}
              <li className="row total">
                <span>Total</span>
                <span>{fmt(summary.totalCents)}</span>
              </li>
            </ul>
            <span className="muted small">Only the name and total are saved to the ledger.</span>
          </div>

          <label>
            Entry name
            <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </label>
          <div>
            <span className="label">Who paid?</span>
            <Segmented
              label="Who paid?"
              value={payer}
              onChange={setPayer}
              options={[
                { value: "me", label: "You" },
                { value: "partner", label: partner.display_name },
              ]}
            />
          </div>
          <label>
            Your share (%)
            <input inputMode="decimal" value={myShare} onChange={(e) => setMyShare(e.target.value)} />
          </label>

          {duplicate && (
            <p className="notice">
              There's already an entry with this name, so this statement may have been imported before. Change the
              name to add it anyway.
            </p>
          )}
          {owed !== null && (
            <p className="preview">
              {payer === "me"
                ? `${partner.display_name} will owe you ${fmt(owed)}`
                : `You will owe ${partner.display_name} ${fmt(owed)}`}
            </p>
          )}
          <button className="primary" disabled={busy || duplicate} onClick={() => void save()}>
            {busy ? "Saving…" : "Add to ledger"}
          </button>
        </>
      )}
    </div>
  );
}
