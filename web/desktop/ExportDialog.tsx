// "Export for the phone app": each person's transactions between two dates, as the same
// split_summary.json that `split-ledger finish` writes, one per person. Either saved as files
// to import on the phone (More > Import statement summary), or, with a desktop key from
// `npm run desktop-key`, sent straight to the app by split-insights. You and your partner go
// together, so what they paid (their statements, or what you typed in for them) isn't left out.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_UPLOAD_MONTHS as MAX_MONTHS } from "../shared/limits";
import {
  latestNetWorth,
  monthOf,
  monthRange,
  shiftMonth,
  type Data,
  type NetWorthNote,
  type Txn,
  type Worth,
} from "./analytics";
import { dayLabel, money, monthName, moneyRound, personLabel } from "./format";

// The desktop app opens the page with ?app; there the server saves the file, since the
// app's window doesn't do browser downloads.
const IN_APP = new URLSearchParams(location.search).has("app");

const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const longDay = (d: string) => `${dayLabel(d)}, ${d.slice(0, 4)}`;
const shortDate = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(2, 4)}`;

/** An upload in the app, as split-insights reports it ("me" is the key's owner). */
interface AppUpload {
  id: string;
  name: string;
  start: string;
  end: string;
  person: "me" | "partner";
  has_shared: boolean;
}
type AppStatus = { connected: false } | { connected: true; url: string; uploads?: AppUpload[]; error?: string };

/** One person's part of the export, as their section reports it; null when it's left out. */
interface Plan {
  person: string;
  start: string;
  end: string;
  personal: boolean;
  name: string | null;
  replace: string[];
  /** What it overlaps among what this computer has sent (for a saved file's warning). */
  overlaps: Data["sent"];
  ok: boolean;
}

type Done = {
  person: string;
  name: string;
  replaced: number;
  file?: { filename: string; path: string | null };
  overlaps?: Data["sent"];
};

/**
 * Where to start by default: the day after the last thing sent for this person (what the
 * app has, when it can be asked; otherwise what this computer remembers), or their first transaction.
 */
function defaults(data: Data, person: string, inApp: AppUpload[] | null) {
  const theirs = data.transactions.filter((t) => t.person === person);
  const first = theirs.length ? theirs[theirs.length - 1].date : "";
  const last = theirs.length ? theirs[0].date : "";
  const ends = inApp ? inApp.map((u) => u.end) : data.sent.filter((e) => e.person === person).map((e) => e.end);
  const lastSent = ends.sort().at(-1);
  const from = lastSent && lastSent >= first ? nextDay(lastSent.slice(0, 10)) : first;
  // No further back than one upload can hold.
  const earliest = last ? `${shiftMonth(monthOf(last), -(MAX_MONTHS - 1))}-01` : from;
  return { from: from < earliest ? earliest : from, to: last };
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
  const { me } = data;
  const people = useMemo(
    () =>
      [...new Set(data.transactions.map((t) => t.person))].sort((a, b) =>
        a === me ? -1 : b === me ? 1 : a.localeCompare(b),
      ),
    [data.transactions, me],
  );
  const [app, setApp] = useState<AppStatus | null>(null);
  const [plans, setPlans] = useState<Record<string, Plan | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ how: "sent" | "saved"; items: Done[] } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    d?.showModal();
    d?.querySelector<HTMLButtonElement>(".btn.primary")?.focus(); // not the close button
    return () => d?.close();
  }, []);

  // Net worth goes along too, as one number for the phone's Home (not the accounts).
  const [netWorth, setNetWorth] = useState<NetWorthNote | null>(null);
  useEffect(() => {
    fetch("/api/worth")
      .then((r) => (r.ok ? r.json() : null))
      .then((w: Worth | null) => setNetWorth(w ? latestNetWorth(w) : null))
      .catch(() => setNetWorth(null));
  }, []);

  // Ask split-insights whether a desktop key is set up, and what the app already has.
  useEffect(() => {
    fetch("/api/app")
      .then((r) => r.json())
      .then((status: AppStatus) => setApp(status))
      .catch(() => setApp({ connected: false }));
  }, []);
  const live = app?.connected && !app.error && app.uploads ? app.uploads : null;

  const onPlan = useCallback((person: string, plan: Plan | null) => {
    setPlans((prev) => (JSON.stringify(prev[person]) === JSON.stringify(plan) ? prev : { ...prev, [person]: plan }));
  }, []);
  const chosen = people.map((p) => plans[p]).filter((p): p is Plan => !!p);
  const blocked = busy || chosen.length === 0 || chosen.some((p) => !p.ok);

  async function post(path: string, plan: Plan, extra: Record<string, unknown>) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        person: plan.person,
        start: plan.start,
        end: plan.end,
        personal: plan.personal,
        name: plan.name,
        net_worth: netWorth,
        ...extra,
      }),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error(body?.error ?? `the server said ${r.status}`);
    return body;
  }

  /** One after the other, so if one fails, the ones before it are done and the rest aren't. */
  async function run(how: "sent" | "saved") {
    setBusy(true);
    setError(null);
    const items: Done[] = [];
    try {
      for (const plan of chosen) {
        const who = personLabel(plan.person, me);
        try {
          if (how === "sent") {
            const body = await post("/api/app/send", plan, { replace: plan.replace });
            items.push({ person: plan.person, name: body.summary.name, replaced: plan.replace.length });
            onData(body.data as Data);
            setApp(body.app as AppStatus);
          } else {
            const body = await post("/api/export", plan, { save: IN_APP });
            if (!body.saved) {
              // In a browser: hand it over as a download.
              const blob = new Blob([JSON.stringify(body.summary, null, 2) + "\n"], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = body.filename;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 10_000);
            }
            items.push({
              person: plan.person,
              name: body.summary.name,
              replaced: 0,
              file: { filename: body.filename, path: body.saved },
              overlaps: plan.overlaps,
            });
            onData(body.data as Data);
          }
        } catch (e) {
          const why = e instanceof Error ? e.message : "it failed";
          const before = items.length
            ? ` (${items.map((i) => personLabel(i.person, me)).join(" and ")} went through)`
            : "";
          throw new Error(`${who}: not ${how === "sent" ? "sent" : "saved"}, ${why}${before}.`, { cause: e });
        }
      }
      setDone({ how, items });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't export.");
      if (items.length) setDone({ how, items });
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

      {done ? (
        <div className="export-body">
          {done.items.map((d) => (
            <p key={d.person}>
              {done.how === "sent" ? (
                <>
                  {personLabel(d.person, me) === "You" ? "Yours" : `${personLabel(d.person, me)}'s`}: sent as{" "}
                  <strong>{d.name}</strong>
                  {d.replaced ? `, in place of ${d.replaced === 1 ? "the earlier upload" : "the earlier uploads"}` : ""}
                  .
                </>
              ) : (
                <>
                  {personLabel(d.person, me) === "You" ? "Yours" : `${personLabel(d.person, me)}'s`}: saved{" "}
                  <code>{d.file?.path ?? d.file?.filename}</code>
                  {d.file?.path ? "." : " to your downloads."}
                  {d.overlaps?.length ? (
                    <span className="warn">
                      {" "}
                      Before importing, delete the earlier upload that covers these dates ({d.overlaps[0].name}), or
                      those days get counted twice.
                    </span>
                  ) : null}
                </>
              )}
            </p>
          ))}
          {error && <p className="warn">{error}</p>}
          {done.how === "saved" ? (
            <ol className="steps">
              <li>Get the file{done.items.length > 1 ? "s" : ""} to your phone (AirDrop works).</li>
              <li>
                In the app: <strong>More › Import statement summary</strong>, once per file, and say whose statement
                each one is (the file name says).
              </li>
            </ol>
          ) : (
            <p className="hint">
              Shared parts are in the ledger as paid by whoever they're for; personal totals are under Spending.
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
            void run(live ? "sent" : "saved");
          }}
        >
          {people.map((p) => (
            <PersonPart
              key={p}
              data={data}
              person={p}
              solo={people.length === 1}
              inApp={live ? live.filter((u) => u.person === (p === me ? "me" : "partner")) : null}
              onPlan={onPlan}
            />
          ))}
          {app?.connected && app.error && <p className="warn">Couldn't check the app: {app.error}</p>}

          {netWorth && (
            <p className="hint">
              Also takes your net worth at the end of {monthName(netWorth.month)}, {moneyRound(netWorth.cents)}, for the
              phone&apos;s Home: just that total, not your accounts.
            </p>
          )}
          {error && <p className="warn">{error}</p>}
          <p className="hint">
            Only totals per month and category go to the app, no merchants. Each person goes as their own upload.
          </p>
          <div className="export-actions">
            <button type="button" className="link" onClick={onClose}>
              Cancel
            </button>
            {live ? (
              <>
                <button type="button" className="btn" disabled={blocked} onClick={() => void run("saved")}>
                  Save {chosen.length > 1 ? "files" : "file"}
                </button>
                <button className="btn primary" disabled={blocked}>
                  {chosen.length === 0 ? "Nothing to send" : busy ? "Sending…" : "Send to the app"}
                </button>
              </>
            ) : (
              <button className="btn primary" disabled={blocked}>
                {chosen.length === 0
                  ? "Nothing to export"
                  : busy
                    ? "Saving…"
                    : `Save ${chosen.length > 1 ? "files" : "file"}`}
              </button>
            )}
          </div>
          {app && !app.connected && (
            <p className="hint">
              To send straight to the app instead of files, run <code>npm run desktop-key</code> once (see the README).
            </p>
          )}
        </form>
      )}
    </dialog>
  );
}

/** One person's dates, what overlaps, and what their summary will hold. */
function PersonPart({
  data,
  person,
  solo,
  inApp,
  onPlan,
}: {
  data: Data;
  person: string;
  /** The only person: no checkbox to leave them out. */
  solo: boolean;
  inApp: AppUpload[] | null;
  onPlan: (person: string, plan: Plan | null) => void;
}) {
  const { me, income } = data;
  const who = personLabel(person, me);
  const whoLower = person === me ? "you" : who;
  const [range, setRange] = useState(() => defaults(data, person, inApp));
  const [touched, setTouched] = useState(false);
  const [replace, setReplace] = useState<Set<string>>(() => new Set());
  const [personal, setPersonal] = useState(true);
  const [name, setName] = useState("");
  const [include, setInclude] = useState<boolean | null>(null); // null until they choose: on when there's something new

  // Once the app has said what it has, start after that (unless the dates were already changed).
  useEffect(() => {
    if (inApp && !touched) setRange(defaults(data, person, inApp));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inApp ? inApp.map((u) => u.id).join() : null]);
  const setDates = (next: { from: string; to: string }) => {
    setTouched(true);
    setRange(next);
  };

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
  const ownSplit = shared.filter((t) => t.share != null);
  const dates = [...(sharedGoes ? shared : []), ...mine].map((t) => t.date).sort();
  const defaultName = dates.length ? `Expenses ${shortDate(dates[0])}-${shortDate(dates[dates.length - 1])}` : "";
  const overlaps = data.sent.filter((e) => e.person === person && !(e.end < range.from || e.start > range.to));
  const appOverlaps = (inApp ?? []).filter((u) => !(u.end < range.from || u.start > range.to));
  const nothing = !sharedGoes && mine.length === 0 && ownSplit.length === 0;
  const tooLong =
    range.from && range.to && range.from <= range.to
      ? monthRange(monthOf(range.from), monthOf(range.to)).length > MAX_MONTHS
      : false;
  const on = solo || (include ?? !nothing);

  useEffect(() => {
    onPlan(
      person,
      on
        ? {
            person,
            start: range.from,
            end: range.to,
            personal,
            name: name.trim() || null,
            replace: appOverlaps.filter((u) => replace.has(u.id)).map((u) => u.id),
            overlaps,
            ok: !nothing && !tooLong && range.from <= range.to,
          }
        : null,
    );
  });

  return (
    <fieldset className="export-person">
      <legend>
        {solo ? (
          <strong>{who === "You" ? "Yours" : `${who}'s`}</strong>
        ) : (
          <label className="check-row">
            <input type="checkbox" checked={on} onChange={(e) => setInclude(e.target.checked)} />
            <strong>{who === "You" ? "Yours" : `${who}'s`}</strong>
            {nothing && <span className="muted"> · nothing new</span>}
          </label>
        )}
      </legend>
      {on && (
        <>
          <div className="field dates">
            <label>
              From
              <input
                type="date"
                required
                value={range.from}
                onChange={(e) => setDates({ ...range, from: e.target.value })}
              />
            </label>
            <label>
              To
              <input
                type="date"
                required
                value={range.to}
                onChange={(e) => setDates({ ...range, to: e.target.value })}
              />
            </label>
          </div>

          {inApp ? (
            <>
              <p className="hint">
                {inApp.length
                  ? `In the app for ${whoLower}: ` +
                    [...inApp]
                      .sort((a, b) => b.end.localeCompare(a.end))
                      .slice(0, 3)
                      .map((u) => `${u.name} (${longDay(u.start)} – ${longDay(u.end.slice(0, 10))})`)
                      .join("; ") +
                    "."
                  : `Nothing in the app for ${whoLower} yet.`}
              </p>
              {appOverlaps.length > 0 && (
                <div className="warn">
                  <p>
                    These dates overlap what's already in the app, so those days would count twice. Take it out first:
                  </p>
                  {appOverlaps.map((u) => (
                    <label key={u.id} className="check-row">
                      <input
                        type="checkbox"
                        checked={replace.has(u.id)}
                        onChange={(e) => {
                          const next = new Set(replace);
                          if (e.target.checked) next.add(u.id);
                          else next.delete(u.id);
                          setReplace(next);
                        }}
                      />
                      {u.name}
                      {u.has_shared ? " (its shared expense is voided, and stays visible crossed out)" : ""}
                    </label>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {data.sent.some((e) => e.person === person) && (
                <p className="hint">
                  Already sent for {whoLower}:{" "}
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
                  These dates overlap something already sent ({overlaps.map((e) => e.name).join(", ")}). If it's in the
                  app, delete that upload there first, or those days get counted twice.
                </p>
              )}
            </>
          )}

          <label className="check-row">
            <input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} />
            Include personal spending and income (for the app&apos;s spending reports)
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
                    ? `added to the ledger as paid by ${whoLower}`
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
          {ownSplit.length > 0 && (
            <p className="hint">
              {ownSplit.length} shared at their own split go as their own entries in the Ledger, one per split (
              {[...new Set(ownSplit.map((t) => `${t.share}/${Math.round((100 - t.share!) * 100) / 100}`))].join(", ")}).
            </p>
          )}

          <label className="field">
            Name in the app
            <input value={name} maxLength={200} placeholder={defaultName} onChange={(e) => setName(e.target.value)} />
          </label>
          {tooLong && (
            <p className="warn">
              One upload can cover at most {MAX_MONTHS} months. Pick a shorter range, and send the rest separately.
            </p>
          )}
        </>
      )}
    </fieldset>
  );
}
