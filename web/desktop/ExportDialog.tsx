// "Export for the phone app": one person's transactions between two dates, as the same
// split_summary.json that `split-ledger finish` writes. The phone app imports it under
// More > Import statement summary.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Data, Txn } from "./analytics";
import { dayLabel, money, personLabel } from "./format";

const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const longDay = (d: string) => `${dayLabel(d)}, ${d.slice(0, 4)}`;
const shortDate = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(2, 4)}`;

/** Where to start by default: the day after the last thing sent for this person, or their first transaction. */
function defaults(data: Data, person: string) {
  const theirs = data.transactions.filter((t) => t.person === person);
  const first = theirs.length ? theirs[theirs.length - 1].date : "";
  const last = theirs.length ? theirs[0].date : "";
  const lastSent = data.sent.filter((e) => e.person === person).map((e) => e.end)[0];
  return { from: lastSent && lastSent >= first ? nextDay(lastSent) : first, to: last };
}

export default function ExportDialog({
  data,
  onClose,
  onData,
}: {
  data: Data;
  onClose: () => void;
  onData: (d: Data) => void;
}) {
  const { me, income } = data;
  const people = useMemo(
    () =>
      [...new Set(data.transactions.map((t) => t.person))].sort((a, b) =>
        a === me ? -1 : b === me ? 1 : a.localeCompare(b),
      ),
    [data.transactions, me],
  );
  const [person, setPerson] = useState(people[0]);
  const [range, setRange] = useState(() => defaults(data, people[0]));
  const [personal, setPersonal] = useState(true);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The file just saved, and what it overlapped before it was saved (not counting itself).
  const [saved, setSaved] = useState<{ filename: string; overlaps: Data["sent"] } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    d?.showModal();
    d?.querySelector<HTMLButtonElement>(".btn.primary")?.focus(); // not the close button
    return () => d?.close();
  }, []);

  function choosePerson(p: string) {
    setPerson(p);
    setRange(defaults(data, p));
    setSaved(null);
  }

  // What the file will hold, worked out the same way the export does.
  const picked = useMemo(
    () => data.transactions.filter((t) => t.person === person && t.date >= range.from && t.date <= range.to),
    [data.transactions, person, range],
  );
  const shared = picked.filter((t) => t.kind === "shared");
  const mine = personal ? picked.filter((t) => t.kind === "personal") : [];
  const sum = (rows: Txn[]) => rows.reduce((n, t) => n + t.cents, 0);
  const sharedTotal = sum(shared);
  const spentMine = sum(mine.filter((t) => t.category !== income));
  const income_ = sum(mine.filter((t) => t.category === income));
  const sharedGoes = shared.length > 0 && sharedTotal > 0;
  const refiled = [...(sharedGoes ? shared : []), ...mine].filter((t) => t.original).length;
  const dates = [...(sharedGoes ? shared : []), ...mine].map((t) => t.date).sort();
  const defaultName = dates.length ? `Expenses ${shortDate(dates[0])}-${shortDate(dates[dates.length - 1])}` : "";
  const overlaps = data.sent.filter((e) => e.person === person && !(e.end < range.from || e.start > range.to));
  const whose = person === me ? "your" : `${personLabel(person, me)}'s`;
  const nothing = !sharedGoes && mine.length === 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ person, start: range.from, end: range.to, personal, name: name.trim() || null }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error ?? `Couldn't export (the server said ${r.status}).`);
      const blob = new Blob([JSON.stringify(body.summary, null, 2) + "\n"], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = body.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setSaved({ filename: body.filename, overlaps });
      onData(body.data as Data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't export.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="export" onClose={onClose} aria-labelledby="export-title">
      <div className="export-head">
        <h2 id="export-title">Export for the phone app</h2>
        <button className="link dismiss" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      {saved ? (
        <div className="export-body">
          <p>
            Saved <code>{saved.filename}</code> to your downloads.
          </p>
          <ol className="steps">
            <li>Get it to your phone (AirDrop works).</li>
            <li>
              In the app: <strong>More › Import statement summary</strong>, pick the file, and say it's {whose}{" "}
              statement.
            </li>
          </ol>
          {saved.overlaps.length > 0 && (
            <p className="warn">
              Before importing, delete the earlier upload that covers these dates ({saved.overlaps[0].name}), or those
              days get counted twice.
            </p>
          )}
          <div className="export-actions">
            <button className="btn" autoFocus onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="export-body"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {people.length > 1 && (
            <fieldset className="field">
              <legend>Whose statement</legend>
              <div className="seg">
                {people.map((p) => (
                  <label key={p} className={person === p ? "on" : ""}>
                    <input type="radio" name="person" checked={person === p} onChange={() => choosePerson(p)} />
                    {personLabel(p, me)}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <div className="field dates">
            <label>
              From
              <input
                id="export-from"
                type="date"
                required
                value={range.from}
                onChange={(e) => setRange({ ...range, from: e.target.value })}
              />
            </label>
            <label>
              To
              <input
                id="export-to"
                type="date"
                required
                value={range.to}
                onChange={(e) => setRange({ ...range, to: e.target.value })}
              />
            </label>
          </div>

          {data.sent.some((e) => e.person === person) && (
            <p className="hint">
              Already sent for {person === me ? "you" : personLabel(person, me)}:{" "}
              {data.sent
                .filter((e) => e.person === person)
                .slice(0, 3)
                .map((e) => `${longDay(e.start)} – ${longDay(e.end)} (${e.from})`)
                .join("; ")}
              .
            </p>
          )}
          {overlaps.length > 0 && (
            <p className="warn">
              These dates overlap something already sent ({overlaps.map((e) => e.name).join(", ")}). If it's in the app,
              delete that upload there first, or those days get counted twice.
            </p>
          )}

          <label className="check-row">
            <input
              id="export-personal"
              type="checkbox"
              checked={personal}
              onChange={(e) => setPersonal(e.target.checked)}
            />
            Include personal spending and income (for the app's spending reports)
          </label>

          <table className="grid-table preview">
            <tbody>
              <tr>
                <td>
                  <span className="swatch shared" />
                  Shared
                </td>
                <td className="num muted">{shared.length}</td>
                <td className="num">{money(sharedTotal)}</td>
                <td className="muted small">
                  {sharedGoes
                    ? `added to the ledger as paid by ${person === me ? "you" : personLabel(person, me)}`
                    : shared.length
                      ? "returns only, so left out"
                      : "none"}
                </td>
              </tr>
              {personal && (
                <tr>
                  <td>
                    <span className="swatch personal" />
                    Personal
                  </td>
                  <td className="num muted">{mine.length}</td>
                  <td className="num">{money(spentMine)}</td>
                  <td className="muted small">
                    {income_ ? `plus ${money(income_)} money in` : "spending reports only"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {refiled > 0 && <p className="hint">Includes {refiled} you refiled here, the way you filed them.</p>}

          <label className="field">
            Name in the app
            <input
              id="export-name"
              value={name}
              maxLength={200}
              placeholder={defaultName}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          {error && <p className="warn">{error}</p>}
          <div className="export-actions">
            <span className="hint">Only totals per month and category go in the file.</span>
            <button type="button" className="link" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || nothing || range.from > range.to}>
              {nothing ? "Nothing to export" : busy ? "Saving…" : "Save file"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
