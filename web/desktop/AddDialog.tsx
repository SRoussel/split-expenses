// Typing in a transaction yourself: cash, or anything no statement will show. split-insights
// keeps these in desktop-data/added.json, and they count everywhere the others do.

import { useEffect, useRef, useState } from "react";
import type { Kind, Txn } from "./analytics";
import { categoryLabel, monthName, personLabel } from "./format";

export type Added = {
  date: string;
  cents: number;
  vendor: string;
  category: string;
  kind: Kind;
  person: string;
};

/** "12,345.67" -> cents; anything else -> null. */
function parseAmount(text: string): number | null {
  const s = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return cents > 0 ? cents : null;
}

const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export default function AddDialog({
  txn,
  seriesSize,
  me,
  people,
  income,
  categories,
  merchants,
  onSave,
  onClose,
}: {
  /** The typed-in transaction being changed, or null to add one. */
  txn: Txn | null;
  /** How many typed-in transactions share this one's series (repeats added together), 0 if none. */
  seriesSize: number;
  me: string;
  people: string[];
  income: string;
  categories: string[];
  merchants: string[];
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    d?.showModal();
    return () => d?.close();
  }, []);

  const [date, setDate] = useState(txn?.date ?? today());
  const [vendor, setVendor] = useState(txn?.vendor ?? "");
  const [amount, setAmount] = useState(txn ? (Math.abs(txn.cents) / 100).toFixed(2) : "");
  const [refund, setRefund] = useState(txn ? txn.cents < 0 : false);
  const [category, setCategory] = useState(txn?.category ?? "");
  const [kind, setKind] = useState<Kind>(txn?.kind ?? "personal");
  const [person, setPerson] = useState(txn?.person ?? me);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [until, setUntil] = useState("");

  const isIncome = category === income;
  const cents = parseAmount(amount);
  // Repeats: the same day each month, from the date's month through `until`.
  const startMonth = date.slice(0, 7);
  const months =
    repeat && /^\d{4}-\d{2}$/.test(until) && until >= startMonth
      ? (Number(until.slice(0, 4)) - Number(startMonth.slice(0, 4))) * 12 +
        Number(until.slice(5)) -
        Number(startMonth.slice(5)) +
        1
      : 1;
  const repeatBad = repeat && (months < 2 || months > 120);
  const ready = !!date && !!vendor.trim() && !!category && cents !== null && !repeatBad;

  async function run(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await onSave(body);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
      setBusy(false);
    }
  }

  function submit() {
    if (!ready || cents === null) return;
    const fields: Added = {
      date,
      cents: refund && !isIncome ? -cents : cents,
      vendor: vendor.trim(),
      category,
      kind: isIncome ? "personal" : kind,
      person,
    };
    void run(txn ? { op: "edit", id: txn.id, ...fields } : { op: "add", ...fields, months });
  }

  return (
    <dialog ref={dialog} className="export" onClose={onClose} aria-labelledby="add-title">
      <div className="export-head">
        <h2 id="add-title">{txn ? "Change this transaction" : "Add a transaction"}</h2>
        <button className="link dismiss" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <form
        className="export-body"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="hint">
          For cash, or anything no statement will show. If it later turns up on a statement too, delete this one so it
          isn't counted twice.
        </p>
        <div className="field dates">
          <label>
            Date
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Amount
            <input
              inputMode="decimal"
              required
              placeholder="0.00"
              autoFocus={!txn}
              aria-invalid={amount !== "" && cents === null}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
        </div>
        <label className="field">
          Merchant
          <input
            list="add-merchants"
            required
            maxLength={80}
            autoComplete="off"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
          />
          <datalist id="add-merchants">
            {merchants.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <div className="field dates">
          <label>
            Category
            <select required value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="" disabled>
                Pick one…
              </option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
              <option value={income}>{categoryLabel(income)} (money in)</option>
            </select>
          </label>
          <label>
            Type
            <select
              value={isIncome ? "personal" : kind}
              disabled={isIncome}
              onChange={(e) => setKind(e.target.value as Kind)}
            >
              <option value="shared">Shared</option>
              <option value="personal">Personal</option>
            </select>
          </label>
          {people.length > 1 && (
            <label>
              Who paid
              <select value={person} onChange={(e) => setPerson(e.target.value)}>
                {people.map((p) => (
                  <option key={p} value={p}>
                    {personLabel(p, me)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {!isIncome && (
          <label className="check-row">
            <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} />
            Money back (a refund or return)
          </label>
        )}
        {!txn && (
          <div className="field">
            <label className="check-row">
              <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
              Repeat every month, like rent
            </label>
            {repeat && (
              <label className="repeat-until">
                Through
                <input type="month" min={startMonth} value={until} onChange={(e) => setUntil(e.target.value)} />
                <span className="hint">
                  {months >= 2 && months <= 120
                    ? `Adds ${months}, one on day ${Number(date.slice(8))} of each month from ${monthName(startMonth)} to ${monthName(until)} (or the month's last day).`
                    : months > 120
                      ? "Up to 120 months at a time."
                      : "Pick the last month."}
                </span>
              </label>
            )}
          </div>
        )}
        {txn && seriesSize > 1 && (
          <p className="hint">One of {seriesSize} added together as a monthly repeat. Saving changes only this one.</p>
        )}
        {amount !== "" && cents === null && <p className="warn">Amounts look like 12.50.</p>}
        {error && <p className="warn">{error}</p>}
        <div className="export-actions">
          {txn &&
            (confirmDelete ? (
              <>
                <button
                  type="button"
                  className="btn danger"
                  disabled={busy}
                  onClick={() => void run({ op: "delete", id: txn.id })}
                >
                  {seriesSize > 1 ? "Delete this one" : "Delete it"}
                </button>
                {seriesSize > 1 && (
                  <button
                    type="button"
                    className="btn danger"
                    disabled={busy}
                    onClick={() => void run({ op: "delete", id: txn.id, series: true })}
                  >
                    Delete all {seriesSize}
                  </button>
                )}
              </>
            ) : (
              <button type="button" className="link" onClick={() => setConfirmDelete(true)}>
                Delete…
              </button>
            ))}
          <button type="button" className="link" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !ready}>
            {txn ? "Save" : months > 1 ? `Add ${months}` : "Add it"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
