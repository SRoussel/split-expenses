import { useState, type ChangeEvent } from "react";
import { addEntry } from "./api";
import {
  fmt,
  owedCents,
  payerSharePct,
  SHARE_ERROR,
  summarizeImport,
  todayLocal,
  type ImportSummary,
} from "./ledger";
import { pctText } from "./forms";
import type { Entry, Member } from "./types";
import { ErrorText, Segmented } from "./ui";

/**
 * Takes the split_transactions.csv from split_statements.py, totals it, and
 * adds it as one entry named "Expenses mm/dd/yy-mm/dd/yy".
 */
export default function ImportCsv({
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
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [fileName, setFileName] = useState("");
  const [name, setName] = useState("");
  const [payer, setPayer] = useState<"me" | "partner">("me");
  const [myShare, setMyShare] = useState(pctText(me.share_pct));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setSummary(null);
    try {
      const s = summarizeImport(await file.text());
      setSummary(s);
      setName(s.name);
      setFileName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file.");
    }
  }

  const payerShare = payerSharePct(myShare, payer);
  const duplicate =
    summary !== null && entries.some((e) => !e.voided_at && e.name === name.trim());

  async function save() {
    if (!summary) return;
    if (!name.trim()) return setError("Give the entry a name.");
    if (payerShare === null) return setError(SHARE_ERROR);
    if (duplicate) return setError("There's already an entry with that name. Change the name to add it anyway.");
    setBusy(true);
    setError(null);
    try {
      await addEntry({
        kind: "expense",
        entry_date: todayLocal(),
        name: name.trim(),
        amount_cents: summary.totalCents,
        payer_id: payer === "me" ? me.user_id : partner.user_id,
        payer_share_pct: payerShare,
      });
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
        Choose the <code>split_transactions.csv</code> from the statement script. Only the total is
        saved, not the individual transactions.
      </p>
      <input type="file" accept=".csv,text/csv" onChange={onFile} />
      <ErrorText message={error} />

      {summary && (
        <>
          <div className="card stack">
            <strong>{fileName}</strong>
            <span className="muted">
              {summary.count} transaction{summary.count === 1 ? "" : "s"}
              {summary.skipped > 0 ? `, ${summary.skipped} skipped as invalid` : ""}
            </span>
            <ul className="plain">
              {Object.entries(summary.byCategory)
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
          </div>

          <label>
            Entry name
            <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </label>
          <div>
            <span className="label">Who paid?</span>
            <Segmented
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
            <input
              inputMode="decimal"
              value={myShare}
              onChange={(e) => setMyShare(e.target.value)}
            />
          </label>

          {duplicate && (
            <p className="notice">
              There's already an entry with this name, so this file may have been imported before.
              Change the name to add it anyway.
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
