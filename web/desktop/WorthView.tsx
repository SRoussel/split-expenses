// Net worth: what you both have and owe, month by month, and how much of your income you
// keep. Balances come from statements (matched by an account's last four digits) or are
// typed in, for accounts with no statements here. Everything stays in desktop-data/.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ASSET_GROUPS,
  balanceAt,
  monthOf,
  monthRange,
  pointsFor,
  savingsRate,
  shiftMonth,
  unlinked,
  worthByMonth,
  worthMonths,
  withoutHome,
  type Account,
  type Txn,
  type Worth,
} from "./analytics";
import Lede, { Fig } from "./Lede";
import { dayLabel, money, moneyRound, monthName, percent, personLabel } from "./format";
import { Sparkline } from "./MonthChart";
import WorthChart, { GROUP_LABEL } from "./WorthChart";

const TYPE_LABEL: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  investment: "Investment",
  retirement: "Retirement",
  property: "Property",
  other: "Other asset",
  "credit card": "Credit card",
  mortgage: "Mortgage",
  loan: "Loan",
};
const KIND_LABEL = { bank: "Bank account", card: "Card", investment: "Investment account" };
const KIND_DEFAULT = {
  bank: { name: "Checking", type: "checking" },
  card: { name: "Card", type: "credit card" },
  investment: { name: "Investments", type: "investment" },
};
const STALE_DAYS = 45;
const longDay = (d: string) => `${dayLabel(d)}, ${d.slice(0, 4)}`;

/** "12,345.67" -> cents; "" -> null; anything else -> undefined. */
function parseMoney(text: string): number | null | undefined {
  const s = text.replace(/[$,\s]/g, "");
  if (!s) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return undefined;
  return Math.round(Number(s) * 100);
}

type Editing = { account?: Account; prefill?: Partial<Account> } | null;

export default function WorthView({ txns, income }: { txns: Txn[]; income: string }) {
  const [worth, setWorth] = useState<Worth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [updating, setUpdating] = useState(false);
  const [withProperty, setWithProperty] = useState(true);

  useEffect(() => {
    fetch("/api/worth")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the server said ${r.status}`))))
      .then(setWorth)
      .catch((e: Error) => setError(`Couldn't load balances: ${e.message}`));
  }, []);

  async function change(body: Record<string, unknown>) {
    const r = await fetch("/api/worth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error ?? `Couldn't save (the server said ${r.status}).`);
    setWorth(data as Worth);
  }

  const months = useMemo(() => (worth ? worthMonths(worth) : []), [worth]);
  // Many people look at net worth without the home: property and mortgages can be left out together.
  const rows = useMemo(() => {
    const all = worth ? worthByMonth(worth, months, owner) : [];
    return withProperty ? all : withoutHome(all);
  }, [worth, months, owner, withProperty]);
  const lastTxnMonth = txns.length ? monthOf(txns[0].date) : null;
  const yearOfTxns = lastTxnMonth ? monthRange(shiftMonth(lastTxnMonth, -11), lastTxnMonth) : [];
  const saving = useMemo(() => savingsRate(txns, yearOfTxns, income), [txns, income, yearOfTxns.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p className="warn">{error}</p>;
  if (!worth) return <p className="muted">Reading balances from your statements…</p>;

  const me = worth.me;
  const who = (p: string) => (p === "joint" ? "Joint" : personLabel(p, me));
  const suggestions = unlinked(worth);
  const latest = rows[rows.length - 1];
  const before = rows.length > 1 ? rows[Math.max(0, rows.length - 13)] : null;
  const span = before ? rows.length - 1 - rows.indexOf(before) : 0;
  const assets = latest ? ASSET_GROUPS.reduce((n, g) => n + latest.groups[g], 0) : 0;
  const lastDate = [...worth.found.map((f) => f.date), ...worth.balances.map((b) => b.date)].sort().at(-1) ?? "";
  const accounts = worth.accounts.filter((a) => !owner || a.owner === owner);
  const subject = !owner
    ? "Together you're worth"
    : owner === "joint"
      ? "Your joint accounts come to"
      : owner === me
        ? "Your own accounts come to"
        : `${who(owner)}'s accounts come to`;
  const owners = [...worth.people.sort((a, b) => (a === me ? -1 : b === me ? 1 : a.localeCompare(b))), "joint"];

  return (
    <>
      <form className="filterbar" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
        <label>
          Whose
          <select value={owner ?? ""} onChange={(e) => setOwner(e.target.value || null)}>
            <option value="">Everyone</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {who(o)}
              </option>
            ))}
          </select>
        </label>
        <span className="grow" />
        <button type="button" className="btn" onClick={() => setEditing({})}>
          Add account
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!worth.accounts.length}
          onClick={() => setUpdating(true)}
        >
          Update balances
        </button>
      </form>

      {!worth.accounts.length ? (
        <section className="panel worth-start">
          <h2>Start with your accounts</h2>
          <p className="hint">
            Add each account once: checking and savings, investments and retirement, the house if you count it, and
            cards or loans. Accounts with statements or downloads here fill in their own history (statements go in
            statements/, brokerage and retirement downloads in balances/); the rest you update once a month.
          </p>
        </section>
      ) : (
        <>
          <Lede
            eyebrow={`Net worth · ${owner ? who(owner) : "both of you"}${latest ? ` · end of ${monthName(latest.month)}` : ""}`}
            stats={[
              `assets ${moneyRound(assets)}`,
              latest && `debts ${moneyRound(latest.groups.debt)}`,
              saving.rate !== null &&
                `kept ${percent(saving.rate)} of income over the last 12 months (${moneyRound(saving.kept)} of ${moneyRound(saving.earned)})`,
            ]}
          >
            {latest ? (
              <>
                {subject} <Fig>{moneyRound(latest.net)}</Fig>
                {before && (
                  <>
                    , {latest.net >= before.net ? "up" : "down"}{" "}
                    <Fig>{moneyRound(Math.abs(latest.net - before.net))}</Fig> in {span} month{span === 1 ? "" : "s"}
                  </>
                )}
                .
              </>
            ) : (
              "No balances yet."
            )}
          </Lede>

          {rows.length > 0 && (
            <section className="panel">
              <div className="panel-head">
                <h2>Month by month</h2>
                <label className="check-row small">
                  <input
                    id="with-property"
                    type="checkbox"
                    checked={withProperty}
                    onChange={(e) => setWithProperty(e.target.checked)}
                  />
                  Count the home and its mortgage
                </label>
                <div className="legend">
                  {[...ASSET_GROUPS, "debt" as const].map((g) => (
                    <span key={g}>
                      <span className={`swatch g-${g}`} />
                      {GROUP_LABEL[g]}
                    </span>
                  ))}
                  <span>
                    <span className="swatch g-net" />
                    Net worth
                  </span>
                </div>
              </div>
              <WorthChart rows={rows} />
            </section>
          )}

          <section className="panel">
            <div className="panel-head">
              <h2>Accounts</h2>
              <span className="muted">balance at the end of each month; the latest known one carries forward</span>
            </div>
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Whose</th>
                  <th className="num">Balance</th>
                  <th>As of</th>
                  <th className="spark-col">Trend</th>
                  <th aria-label="Edit" />
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const pts = pointsFor(a, worth);
                  const last = pts[pts.length - 1];
                  const debt = worth.types[a.type]?.debt;
                  const stale =
                    last && lastDate && (Date.parse(lastDate) - Date.parse(last.date)) / 86_400_000 > STALE_DAYS;
                  const trend = months.slice(-12).map((m) => balanceAt(pts, m) ?? 0);
                  return (
                    <tr key={a.id} className={a.closed ? "closed" : ""}>
                      <td>
                        <strong>{a.name}</strong>
                        <span className="cell-sub">
                          {TYPE_LABEL[a.type]}
                          {a.match ? ` · statements ••${a.match}` : ""}
                          {a.closed ? " · closed" : ""}
                        </span>
                      </td>
                      <td className="muted">{who(a.owner)}</td>
                      <td className="num">{last ? (debt ? `−${money(last.cents)}` : money(last.cents)) : "–"}</td>
                      <td className="muted nowrap">
                        {last ? longDay(last.date) : "no balance yet"}
                        {stale && !a.closed && <span className="pill up">update</span>}
                      </td>
                      <td className="spark-col">{pts.length > 1 && <Sparkline values={trend} />}</td>
                      <td>
                        <button className="link" onClick={() => setEditing({ account: a })}>
                          Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}

      {suggestions.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>In your statements and downloads, not added yet</h2>
          </div>
          <ul className="found">
            {suggestions.map((s) => (
              <li key={`${s.ref}|${s.person}`}>
                <span>
                  <strong>
                    {KIND_LABEL[s.kind]} ending {s.ref}
                  </strong>
                  <span className="cell-sub">
                    {s.person === me ? "Your" : `${who(s.person)}'s`} files · {s.count} file
                    {s.count === 1 ? "" : "s"} · latest {money(s.latest.cents)} on {longDay(s.latest.date)}
                  </span>
                </span>
                <button
                  className="btn"
                  onClick={() =>
                    setEditing({
                      prefill: {
                        name: `${KIND_DEFAULT[s.kind].name} ••${s.ref}`,
                        type: KIND_DEFAULT[s.kind].type,
                        owner: s.person,
                        match: s.ref,
                      },
                    })
                  }
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {worth.problems.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Downloads that couldn&apos;t be matched</h2>
          </div>
          <ul className="found">
            {worth.problems.map((p) => (
              <li key={p.file}>
                <span>
                  <code>{p.file}</code>
                  <span className="cell-sub">{p.reason}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing && (
        <AccountDialog
          worth={worth}
          editing={editing}
          owners={owners}
          who={who}
          onSave={change}
          onClose={() => setEditing(null)}
        />
      )}
      {updating && <BalancesDialog worth={worth} who={who} onSave={change} onClose={() => setUpdating(false)} />}
    </>
  );
}

function useModal() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return ref;
}

function AccountDialog({
  worth,
  editing,
  owners,
  who,
  onSave,
  onClose,
}: {
  worth: Worth;
  editing: NonNullable<Editing>;
  owners: string[];
  who: (p: string) => string;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const a = editing.account;
  const start = { ...(a ?? {}), ...(editing.prefill ?? {}) };
  const [name, setName] = useState(start.name ?? "");
  const [type, setType] = useState(start.type ?? "checking");
  const [owner, setOwner] = useState(start.owner ?? worth.me);
  const [match, setMatch] = useState(start.match ?? "");
  const [closed, setClosed] = useState(a?.closed ?? false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useModal();

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

  const fields = { name, type, owner, match: match.trim() || null };
  return (
    <dialog ref={dialog} className="export" onClose={onClose} aria-labelledby="acct-title">
      <div className="export-head">
        <h2 id="acct-title">{a ? "Edit account" : "Add an account"}</h2>
        <button className="link dismiss" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <form
        className="export-body"
        onSubmit={(e) => {
          e.preventDefault();
          void run(a ? { op: "edit", id: a.id, ...fields, closed } : { op: "add", ...fields });
        }}
      >
        <label className="field">
          Name
          <input
            id="acct-name"
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        <div className="field dates">
          <label>
            Kind
            <select id="acct-type" value={type} onChange={(e) => setType(e.target.value)}>
              {Object.keys(worth.types).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t] ?? t}
                </option>
              ))}
            </select>
          </label>
          <label>
            Whose
            <select id="acct-owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
              {owners.map((o) => (
                <option key={o} value={o}>
                  {who(o)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          Last four digits of the account number (optional)
          <input
            id="acct-match"
            inputMode="numeric"
            pattern="\d{4}"
            maxLength={4}
            placeholder="1234"
            value={match}
            onChange={(e) => setMatch(e.target.value.replace(/\D/g, ""))}
          />
          <span className="hint">
            With these, balances come from your statements. Without them, you type the balance in each month.
          </span>
        </label>
        {a && (
          <label className="check-row">
            <input id="acct-closed" type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
            Closed: keep its history, stop asking for balances
          </label>
        )}
        {error && <p className="warn">{error}</p>}
        <div className="export-actions">
          {a &&
            (confirmDelete ? (
              <button
                type="button"
                className="btn danger"
                disabled={busy}
                onClick={() => void run({ op: "delete", id: a.id })}
              >
                Delete it and its balances
              </button>
            ) : (
              <button type="button" className="link" onClick={() => setConfirmDelete(true)}>
                Delete…
              </button>
            ))}
          <button type="button" className="link" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || (match !== "" && match.length !== 4)}>
            {a ? "Save" : "Add account"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function BalancesDialog({
  worth,
  who,
  onSave,
  onClose,
}: {
  worth: Worth;
  who: (p: string) => string;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  // The end of last month, the usual moment to note balances.
  const now = new Date();
  const [date, setDate] = useState(new Date(Date.UTC(now.getFullYear(), now.getMonth(), 0)).toISOString().slice(0, 10));
  // Accounts linked to statements are here too: a typed balance fills a month the statements
  // miss, and wins over a statement balance on the same day.
  const typed = worth.accounts.filter((a) => !a.closed);
  const asMoney = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));
  const known = (a: Account) => {
    const exact = worth.balances.find((b) => b.account === a.id && b.date === date);
    if (exact) return asMoney(exact.cents);
    return a.match ? "" : asMoney(balanceAt(pointsFor(a, worth), monthOf(date)));
  };
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(typed.map((a) => [a.id, known(a)])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useModal();
  const parsed = Object.fromEntries(typed.map((a) => [a.id, parseMoney(values[a.id] ?? "")]));
  const bad = typed.filter((a) => parsed[a.id] === undefined);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave({ op: "balances", date, values: parsed });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="export" onClose={onClose} aria-labelledby="bal-title">
      <div className="export-head">
        <h2 id="bal-title">Update balances</h2>
        <button className="link dismiss" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <form
        className="export-body"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="field">
          Balances on
          <input id="bal-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        {typed.length ? (
          <table className="grid-table balances">
            <tbody>
              {typed.map((a) => (
                <tr key={a.id}>
                  <td>
                    <label htmlFor={`bal-${a.id}`}>{a.name}</label>
                    <span className="cell-sub">
                      {who(a.owner)} · {TYPE_LABEL[a.type]}
                      {worth.types[a.type]?.debt ? " (amount owed)" : ""}
                      {a.match ? " · from statements, type to override" : ""}
                    </span>
                  </td>
                  <td className="num">
                    <input
                      id={`bal-${a.id}`}
                      inputMode="decimal"
                      placeholder={a.match ? asMoney(balanceAt(pointsFor(a, worth), monthOf(date))) || "0.00" : "0.00"}
                      aria-invalid={parsed[a.id] === undefined}
                      value={values[a.id] ?? ""}
                      onChange={(e) => setValues({ ...values, [a.id]: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hint">Every account is closed, so there's nothing to update.</p>
        )}
        {typed.some((a) => a.match) && (
          <p className="hint">
            Accounts from statements fill in by themselves when you put new statements in statements/ (or brokerage and
            retirement downloads in balances/) and reload. Leave them blank unless a statement is missing or wrong.
          </p>
        )}
        {bad.length > 0 && <p className="warn">Amounts look like 12,345.67.</p>}
        {error && <p className="warn">{error}</p>}
        <div className="export-actions">
          <button type="button" className="link" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !typed.length || bad.length > 0}>
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
