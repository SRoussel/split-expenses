import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  applyFilters,
  byCategory,
  byMerchant,
  byMonth,
  change,
  monthOf,
  monthRange,
  presetRange,
  similarNames,
  previousPeriod,
  totals,
  type Data,
  type Filters,
  type Kind,
  type Preset,
  type Txn,
} from "./analytics";
import { categoryLabel, dayLabel, money, moneyRound, monthName, percent, personLabel, rangeLabel } from "./format";
import ExportDialog from "./ExportDialog";
import MonthChart, { Sparkline } from "./MonthChart";

const PRESETS: { id: Preset; label: string }[] = [
  { id: "12m", label: "Last 12 months" },
  { id: "ytd", label: "This year" },
  { id: "last-year", label: "Last year" },
  { id: "all", label: "All time" },
];

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("insights-theme") as Theme) || "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      localStorage.setItem("insights-theme", theme);
    } catch {
      /* private window: the choice just isn't remembered */
    }
  }, [theme]);
  return [theme, setTheme];
}

export default function App() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/data")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`The server said ${r.status}.`))))
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="splash">
        <h1>Couldn't load your transactions</h1>
        <p>{error}</p>
        <p className="muted">
          Is <code>uv run split-insights</code> still running? Start it again, then reload this page.
        </p>
      </div>
    );
  }
  if (!data) return <div className="splash muted">Loading…</div>;
  if (!data.transactions.length) {
    return (
      <div className="splash">
        <h1>No transactions yet</h1>
        <p className="muted">
          Go through a statement with <code>uv run split-statements</code>, then reload.
        </p>
      </div>
    );
  }
  return <Workspace data={data} onData={setData} />;
}

function Workspace({ data, onData }: { data: Data; onData: (d: Data) => void }) {
  const { transactions: txns, income, me } = data;
  const first = monthOf(txns[txns.length - 1].date);
  const last = monthOf(txns[0].date);
  // You first, then everyone else by name.
  const people = useMemo(
    () => [...new Set(txns.map((t) => t.person))].sort((a, b) => (a === me ? -1 : b === me ? 1 : a.localeCompare(b))),
    [txns, me],
  );

  const [preset, setPreset] = useState<Preset>("12m");
  const [f, setF] = useState<Filters>(() => ({
    ...presetRange("12m", first, last),
    person: null,
    kind: null,
    category: null,
    merchant: null,
    month: null,
    query: "",
  }));
  const [theme, setTheme] = useTheme();
  const [exporting, setExporting] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Filters>) => setF((prev) => ({ ...prev, ...patch }));

  function choosePreset(p: Preset) {
    setPreset(p);
    const range = presetRange(p, first, last);
    setF((prev) => ({
      ...prev,
      ...range,
      month: prev.month && prev.month >= range.from && prev.month <= range.to ? prev.month : null,
    }));
  }

  // "/" jumps to search; Esc clears the search, then the selections.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (document.querySelector("dialog[open]")) return; // the dialog handles its own keys
      const typing = e.target instanceof HTMLInputElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        search.current?.focus();
      } else if (e.key === "Escape") {
        setF((prev) =>
          prev.query
            ? { ...prev, query: "" }
            : { ...prev, month: null, category: null, merchant: null, person: null, kind: null },
        );
        if (typing) (e.target as HTMLInputElement).blur();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const months = useMemo(() => monthRange(f.from, f.to), [f.from, f.to]);
  const view = useMemo(() => applyFilters(txns, f), [txns, f]);
  const now = useMemo(() => totals(view, income), [view, income]);
  // Only compare with a period the files fully cover; a half-loaded one makes every change look huge.
  const before = useMemo(() => {
    const prev = previousPeriod(f);
    return prev.from < first ? null : totals(applyFilters(txns, prev), income);
  }, [txns, f, income, first]);
  const delta = (key: "spent" | "shared" | "personal" | "income") => (before ? change(now[key], before[key]) : null);
  const monthRows = useMemo(() => byMonth(applyFilters(txns, f, "month"), months, income), [txns, f, months, income]);
  const categories = useMemo(
    () => byCategory(applyFilters(txns, f, "category"), months, income),
    [txns, f, months, income],
  );
  // Sparklines show the whole period even when one month is picked.
  const trend = useMemo(() => {
    const rows = byCategory(applyFilters(txns, { ...f, month: null }, "category"), months, income);
    return new Map(rows.map((r) => [r.category, r.perMonth]));
  }, [txns, f, months, income]);
  // Every merchant name on the page, and the cleaned-up names each one covers.
  const autosByMerchant = useMemo(() => {
    const out = new Map<string, Set<string>>();
    for (const t of txns) {
      if (!out.has(t.merchant)) out.set(t.merchant, new Set());
      out.get(t.merchant)!.add(t.auto);
    }
    return out;
  }, [txns]);

  /** Show the merchants in `names` (cleaned-up names) as `to`; null puts them back. Saved by split-insights. */
  /** Send a change to split-insights, which saves it and answers with the updated data. */
  async function post(path: string, payload: unknown) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error(body?.error ?? `Couldn't save (the server said ${r.status}).`);
    onData(body as Data);
  }

  async function rename(names: string[], to: string | null) {
    await post("/api/merchants", { names, to });
    set({ merchant: to ?? (names.length === 1 ? names[0] : null) });
  }

  const merchants = useMemo(() => byMerchant(applyFilters(txns, f, "merchant"), income), [txns, f, income]);

  const refiled = useMemo(() => txns.filter((t) => t.original).length, [txns]);
  const scope = f.month ? monthName(f.month) : rangeLabel(f.from, f.to);
  const what = f.category ? categoryLabel(f.category) : f.merchant ? f.merchant : "Spending";
  const vs = f.month ? "vs the month before" : "vs the period before";
  const chips: { label: string; clear: () => void }[] = [
    f.month && { label: monthName(f.month), clear: () => set({ month: null }) },
    f.category && { label: categoryLabel(f.category), clear: () => set({ category: null }) },
    f.merchant && { label: f.merchant, clear: () => set({ merchant: null }) },
    f.person && { label: personLabel(f.person, me), clear: () => set({ person: null }) },
    f.kind && { label: f.kind === "shared" ? "Shared only" : "Personal only", clear: () => set({ kind: null }) },
    f.query && { label: `“${f.query}”`, clear: () => set({ query: "" }) },
  ].filter((c): c is { label: string; clear: () => void } => !!c);

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          Split <span className="brand-sub">Insights</span>
        </div>

        <NavGroup title="Period">
          {PRESETS.map((p) => (
            <NavItem key={p.id} on={preset === p.id} onClick={() => choosePreset(p.id)}>
              {p.label}
            </NavItem>
          ))}
        </NavGroup>

        {people.length > 1 && (
          <NavGroup title="Whose">
            <NavItem on={!f.person} onClick={() => set({ person: null })}>
              Both of you
            </NavItem>
            {people.map((p) => (
              <NavItem key={p} on={f.person === p} onClick={() => set({ person: p })}>
                {personLabel(p, me)}
              </NavItem>
            ))}
          </NavGroup>
        )}

        <NavGroup title="Type">
          <NavItem on={!f.kind} onClick={() => set({ kind: null })}>
            Everything
          </NavItem>
          {(["shared", "personal"] as Kind[]).map((k) => (
            <NavItem key={k} on={f.kind === k} onClick={() => set({ kind: k })}>
              <span className={`swatch ${k}`} />
              {k === "shared" ? "Shared" : "Personal"}
            </NavItem>
          ))}
        </NavGroup>

        <div className="side-foot">
          {refiled > 0 && (
            <div>
              {refiled} refiled here (kept in <code>desktop-data/</code>)
            </div>
          )}
          <details>
            <summary>
              {txns.length.toLocaleString()} transactions · {rangeLabel(first, last)}
            </summary>
            <ul>
              {data.sources.map((s) => (
                <li key={s.dir}>
                  <code>{s.dir}</code>
                  <span>
                    {s.kept} used{s.rows > s.kept ? `, ${s.rows - s.kept} already in newer files` : ""}
                    {s.skipped ? `, ${s.skipped} unreadable` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          <div className="theme" role="group" aria-label="Theme">
            {(["system", "light", "dark"] as Theme[]).map((t) => (
              <button key={t} className={theme === t ? "on" : ""} onClick={() => setTheme(t)}>
                {t === "system" ? "Auto" : t === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="top">
          <div>
            <h1>Where the money goes</h1>
            <p className="sub">{scope}</p>
          </div>
          <div className="top-actions">
            <label className="search">
              <span className="sr-only">Search transactions</span>
              <input
                ref={search}
                type="search"
                placeholder="Search merchants, categories, amounts"
                value={f.query}
                onChange={(e) => set({ query: e.target.value })}
              />
              <kbd>/</kbd>
            </label>
            <button className="btn" onClick={() => setExporting(true)}>
              Export for phone app
            </button>
          </div>
        </header>

        {chips.length > 0 && (
          <div className="chips">
            {chips.map((c) => (
              <button key={c.label} className="chip" onClick={c.clear} title="Remove this filter">
                {c.label} <span aria-hidden="true">×</span>
              </button>
            ))}
            <button
              className="link"
              onClick={() => set({ month: null, category: null, merchant: null, person: null, kind: null, query: "" })}
            >
              Clear all <kbd>Esc</kbd>
            </button>
          </div>
        )}

        <section className="kpis">
          <Kpi label="Spent" value={now.spent} delta={delta("spent")} vs={vs} />
          <Kpi label="Shared" value={now.shared} delta={delta("shared")} vs={vs} swatch="shared" />
          <Kpi label="Personal" value={now.personal} delta={delta("personal")} vs={vs} swatch="personal" />
          {f.month ? (
            <div className="kpi">
              <div className="kpi-label">Transactions</div>
              <div className="kpi-value">{now.count}</div>
            </div>
          ) : (
            <Kpi label="Per month" value={Math.round(now.spent / months.length)} />
          )}
          {f.category || f.merchant ? (
            <Kpi label="Average transaction" value={now.count ? Math.round(now.spent / now.count) : 0} />
          ) : (
            <Kpi label="Money in" value={now.income} delta={delta("income")} vs={vs} />
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>{what} by month</h2>
            <div className="legend">
              <span>
                <span className="swatch shared" />
                Shared
              </span>
              <span>
                <span className="swatch personal" />
                Personal
              </span>
            </div>
          </div>
          <MonthChart rows={monthRows} selected={f.month} onSelect={(month) => set({ month })} />
        </section>

        <div className="split">
          <section className="panel">
            <div className="panel-head">
              <h2>Categories</h2>
              <span className="muted">click to filter</span>
            </div>
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="bar-col" aria-label="Share" />
                  <th className="num">Share</th>
                  <th className="num">Amount</th>
                  <th className="spark-col">Trend</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr
                    key={c.category}
                    className={`clickable${f.category === c.category ? " on" : ""}${f.category && f.category !== c.category ? " dim" : ""}`}
                    onClick={() => set({ category: f.category === c.category ? null : c.category })}
                  >
                    <td>
                      <button className="row-button" aria-pressed={f.category === c.category}>
                        {categoryLabel(c.category)}
                      </button>
                    </td>
                    <td className="bar-col">
                      <span
                        className="hbar"
                        style={{ width: `${(Math.max(0, c.total) / Math.max(1, categories[0]?.total ?? 1)) * 100}%` }}
                      />
                    </td>
                    <td className="num muted">{percent(c.share)}</td>
                    <td className="num">{moneyRound(c.total)}</td>
                    <td className="spark-col">
                      <Sparkline values={trend.get(c.category) ?? []} />
                    </td>
                  </tr>
                ))}
                {categories.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">
                      Nothing here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          <MerchantsPanel
            rows={merchants}
            selected={f.merchant}
            onSelect={(merchant) => set({ merchant })}
            autosByMerchant={autosByMerchant}
            onRename={rename}
          />
        </div>

        <TransactionsPanel
          txns={view}
          all={txns}
          me={me}
          income={income}
          categories={data.categories}
          onMerchant={(merchant) => set({ merchant })}
          onClassify={(changes) => post("/api/classify", { changes })}
          onRemember={(rules) => post("/api/rules", { rules })}
        />
      </main>
      {exporting && <ExportDialog data={data} onData={onData} onClose={() => setExporting(false)} />}
    </div>
  );
}

function NavGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <nav className="nav-group" aria-label={title}>
      <div className="nav-title">{title}</div>
      {children}
    </nav>
  );
}

function NavItem({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button className={`nav-item${on ? " on" : ""}`} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

function Kpi({
  label,
  value,
  delta,
  vs,
  swatch,
}: {
  label: string;
  value: number;
  delta?: number | null;
  vs?: string;
  swatch?: Kind;
}) {
  return (
    <div className="kpi">
      <div className="kpi-label">
        {swatch && <span className={`swatch ${swatch}`} />}
        {label}
      </div>
      <div className="kpi-value">{moneyRound(value)}</div>
      {delta !== undefined && (
        <div className="kpi-delta">
          {delta === null ? (
            <span className="muted">no earlier data to compare</span>
          ) : (
            <>
              <span aria-hidden="true">{delta > 0 ? "▲" : delta < 0 ? "▼" : "•"}</span> {percent(Math.abs(delta))}{" "}
              <span className="muted">{vs}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MerchantsPanel({
  rows,
  selected,
  onSelect,
  autosByMerchant,
  onRename,
}: {
  rows: ReturnType<typeof byMerchant>;
  selected: string | null;
  onSelect: (m: string | null) => void;
  autosByMerchant: Map<string, Set<string>>;
  onRename: (names: string[], to: string | null) => Promise<void>;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 12);
  const top = Math.max(1, ...rows.map((r) => r.total));
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Merchants</h2>
        <span className="muted">{selected ? "" : "pick one to rename or merge it"}</span>
      </div>
      {selected && autosByMerchant.has(selected) && (
        <MerchantEditor key={selected} name={selected} autosByMerchant={autosByMerchant} onRename={onRename} />
      )}
      <table className="grid-table">
        <thead>
          <tr>
            <th>Merchant</th>
            <th className="bar-col" aria-label="Relative amount" />
            <th className="num">Visits</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((m) => (
            <tr
              key={m.merchant}
              className={`clickable${selected === m.merchant ? " on" : ""}${selected && selected !== m.merchant ? " dim" : ""}`}
              onClick={() => onSelect(selected === m.merchant ? null : m.merchant)}
            >
              <td>
                <button className="row-button" aria-pressed={selected === m.merchant}>
                  {m.merchant}
                </button>
                <span className="cell-sub">{categoryLabel(m.category)}</span>
              </td>
              <td className="bar-col">
                <span className="hbar" style={{ width: `${(Math.max(0, m.total) / top) * 100}%` }} />
              </td>
              <td className="num muted">{m.count}</td>
              <td className="num">{moneyRound(m.total)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                Nothing here.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {rows.length > 12 && (
        <button className="link more" onClick={() => setAll(!all)}>
          {all ? "Show top 12" : `Show all ${rows.length}`}
        </button>
      )}
    </section>
  );
}

type SortKey = "date" | "merchant" | "amount";
type Change = { id: string; category: string; kind: Kind };
type Rule = { vendor: string; person: string; category: string; kind: Kind };
type Notice = { text: string; undo?: Change[]; offer?: { text: string; rules: Rule[] } };

const kindLabel = (k: Kind) => (k === "shared" ? "shared" : "personal");

function TransactionsPanel({
  txns,
  all,
  me,
  income,
  categories,
  onMerchant,
  onClassify,
  onRemember,
}: {
  txns: Txn[];
  all: Txn[];
  me: string;
  income: string;
  categories: string[];
  onMerchant: (m: string) => void;
  onClassify: (changes: Change[]) => Promise<void>;
  onRemember: (rules: Rule[]) => Promise<void>;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "date", desc: true });
  const [limit, setLimit] = useState(100);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastClicked = useRef<number | null>(null);

  const sorted = useMemo(() => {
    const out = [...txns];
    const dir = sort.desc ? -1 : 1;
    out.sort((a, b) => {
      if (sort.key === "amount") return (a.cents - b.cents) * dir;
      if (sort.key === "merchant") return a.merchant.localeCompare(b.merchant) * dir;
      return a.date.localeCompare(b.date) * dir;
    });
    return out;
  }, [txns, sort]);
  const net = txns.reduce((n, t) => n + (t.category === income ? 0 : t.cents), 0);
  const picked = sorted.filter((t) => selected.has(t.id));
  const allPicked = sorted.length > 0 && picked.length === sorted.length;

  function toggle(index: number, shift: boolean) {
    const id = sorted[index].id;
    // Shift-click picks everything between this row and the last one clicked.
    const anchor = shift && lastClicked.current !== null ? lastClicked.current : index;
    const range = sorted.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map((t) => t.id);
    lastClicked.current = index;
    setSelected((prev) => {
      const next = new Set(prev);
      const on = !prev.has(id);
      for (const r of range) {
        if (on) next.add(r);
        else next.delete(r);
      }
      return next;
    });
  }

  /** Refile transactions; then offer to undo, and to teach split-statements if it was one merchant. */
  type Patch = { category?: string; kind?: Kind };
  async function refile(targets: Txn[], patch: Patch | ((t: Txn) => Patch), label: string) {
    const changes: Change[] = [];
    const before: Change[] = [];
    for (const t of targets) {
      const p = typeof patch === "function" ? patch(t) : patch;
      const next = { id: t.id, category: p.category ?? t.category, kind: p.kind ?? t.kind };
      if (next.category === income && next.kind === "shared") continue; // income is never shared
      if (next.category === t.category && next.kind === t.kind) continue;
      changes.push(next);
      before.push({ id: t.id, category: t.category, kind: t.kind });
    }
    if (!changes.length) {
      setNotice({ text: "Nothing to change." });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onClassify(changes);
      const n = changes.length === 1 ? "1 transaction" : `${changes.length} transactions`;
      setNotice({ text: `${label}: ${n}.`, undo: before, offer: offerFor(targets, changes) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  /** "Always file Freshway as Groceries, shared?" when everything changed is one merchant's spending, filed one way. */
  function offerFor(targets: Txn[], changes: Change[]): Notice["offer"] {
    const merchants = new Set(targets.map((t) => t.merchant));
    const filings = new Set(changes.map((c) => `${c.category}|${c.kind}`));
    if (merchants.size !== 1 || filings.size !== 1) return undefined;
    const { category, kind } = changes[0];
    if (category === income || targets.some((t) => t.cents < 0)) return undefined;
    const merchant = [...merchants][0];
    // Every spelling of the merchant, for whoever's transactions you changed.
    const people = new Set(targets.map((t) => t.person));
    const rules = new Map<string, Rule>();
    for (const t of all) {
      if (t.merchant === merchant && people.has(t.person) && t.cents > 0 && t.category !== income) {
        rules.set(`${t.person}|${t.vendor}`, { vendor: t.vendor, person: t.person, category, kind });
      }
    }
    return {
      text: `Always file ${merchant} as ${categoryLabel(category)}, ${kindLabel(kind)}, in future statements?`,
      rules: [...rules.values()],
    };
  }

  async function undo(changes: Change[]) {
    setBusy(true);
    try {
      await onClassify(changes);
      setNotice({ text: "Undone." });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't undo.");
    } finally {
      setBusy(false);
    }
  }

  async function remember(offer: NonNullable<Notice["offer"]>) {
    setBusy(true);
    try {
      await onRemember(offer.rules);
      setNotice({ text: "Saved. split-statements will file it this way from now on." });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the rule.");
    } finally {
      setBusy(false);
    }
  }

  const putBack = (targets: Txn[]) =>
    refile(
      targets.filter((t) => t.original),
      (t) => t.original ?? {},
      "Put back",
    );

  const header = (key: SortKey, label: string, className = "") => (
    <th className={className} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button
        className="sort"
        onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "merchant" }))}
      >
        {label}
        {sort.key === key && <span aria-hidden="true">{sort.desc ? " ↓" : " ↑"}</span>}
      </button>
    </th>
  );

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Transactions</h2>
        <span className="muted">
          {txns.length.toLocaleString()} · {money(net)} spent
        </span>
      </div>

      {picked.length > 0 && (
        <div className="bulk" role="toolbar" aria-label="Change the selected transactions">
          <strong>{picked.length} selected</strong>
          <select
            aria-label="Set category"
            value=""
            disabled={busy}
            onChange={(e) =>
              e.target.value &&
              void refile(picked, { category: e.target.value }, `Filed as ${categoryLabel(e.target.value)}`)
            }
          >
            <option value="">Set category…</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
          <button
            className="btn"
            disabled={busy}
            onClick={() => void refile(picked, { kind: "shared" }, "Made shared")}
          >
            <span className="swatch shared" />
            Shared
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => void refile(picked, { kind: "personal" }, "Made personal")}
          >
            <span className="swatch personal" />
            Personal
          </button>
          {picked.some((t) => t.original) && (
            <button className="link" disabled={busy} onClick={() => void putBack(picked)}>
              Put back as the statement had it
            </button>
          )}
          <button className="link" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {(notice || error) && (
        <div className={`notice${error ? " bad" : ""}`} role="status">
          <span>{error ?? notice?.text}</span>
          {!error && notice?.undo && (
            <button className="link" disabled={busy} onClick={() => void undo(notice.undo!)}>
              Undo
            </button>
          )}
          {!error && notice?.offer && (
            <span className="offer">
              {notice.offer.text}
              <button className="btn" disabled={busy} onClick={() => void remember(notice.offer!)}>
                Yes, always
              </button>
              <button className="link" onClick={() => setNotice({ ...notice, offer: undefined })}>
                Not now
              </button>
            </span>
          )}
          <button className="link dismiss" aria-label="Dismiss" onClick={() => (setNotice(null), setError(null))}>
            ×
          </button>
        </div>
      )}

      <table className="grid-table txns">
        <thead>
          <tr>
            <th className="check">
              <input
                type="checkbox"
                aria-label={`Select all ${sorted.length}`}
                title={`Select all ${sorted.length}`}
                checked={allPicked}
                onChange={() => setSelected(allPicked ? new Set() : new Set(sorted.map((t) => t.id)))}
              />
            </th>
            {header("date", "Date")}
            {header("merchant", "Merchant")}
            <th>Category</th>
            <th>Type</th>
            {header("amount", "Amount", "num")}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, limit).map((t, i) => (
            <tr key={t.id} className={selected.has(t.id) ? "picked" : ""}>
              <td className="check">
                <input
                  type="checkbox"
                  aria-label={`Select ${t.merchant}, ${dayLabel(t.date)}`}
                  checked={selected.has(t.id)}
                  onChange={() => {}}
                  onClick={(e) => toggle(i, e.shiftKey)}
                />
              </td>
              <td className="muted nowrap">{dayLabel(t.date)}</td>
              <td title={t.vendor}>
                <button className="row-button" onClick={() => onMerchant(t.merchant)}>
                  {t.merchant}
                </button>
              </td>
              <td className="nowrap">
                <select
                  className="cell-select"
                  aria-label={`Category for ${t.merchant}`}
                  value={t.category}
                  disabled={busy}
                  onChange={(e) =>
                    void refile([t], { category: e.target.value }, `Filed as ${categoryLabel(e.target.value)}`)
                  }
                >
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {categoryLabel(c)}
                    </option>
                  ))}
                  {(t.kind === "personal" || t.category === income) && (
                    <option value={income}>{categoryLabel(income)}</option>
                  )}
                </select>
                {t.original && (
                  <button
                    className="edited"
                    disabled={busy}
                    title={`The statement had ${categoryLabel(t.original.category)}, ${kindLabel(t.original.kind)}. Click to put it back.`}
                    onClick={() => void putBack([t])}
                  >
                    edited
                  </button>
                )}
              </td>
              <td className="nowrap">
                <span className={`swatch ${t.kind}`} />
                <select
                  className="cell-select"
                  aria-label={`Shared or personal for ${t.merchant}`}
                  value={t.kind}
                  disabled={busy}
                  onChange={(e) =>
                    void refile(
                      [t],
                      { kind: e.target.value as Kind },
                      e.target.value === "shared" ? "Made shared" : "Made personal",
                    )
                  }
                >
                  <option value="shared" disabled={t.category === income}>
                    Shared
                  </option>
                  <option value="personal">Personal</option>
                </select>
                {t.person !== me && <span className="muted"> · {personLabel(t.person, me)}</span>}
              </td>
              <td className={`num${t.cents < 0 || t.category === income ? " credit" : ""}`}>
                {t.category === income ? `+${money(t.cents)}` : money(t.cents)}
              </td>
            </tr>
          ))}
          {txns.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">
                No transactions match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {txns.length > limit && (
        <button className="link more" onClick={() => setLimit(txns.length)}>
          Show all {txns.length.toLocaleString()}
        </button>
      )}
    </section>
  );
}

function MerchantEditor({
  name,
  autosByMerchant,
  onRename,
}: {
  name: string;
  autosByMerchant: Map<string, Set<string>>;
  onRename: (names: string[], to: string | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autos = [...(autosByMerchant.get(name) ?? [])].sort();
  const renamed = autos.some((a) => a !== name);
  const similar = useMemo(() => similarNames(name, autosByMerchant.keys()), [name, autosByMerchant]);
  const next = draft.trim().replace(/\s+/g, " ");
  const merging = next !== name && autosByMerchant.has(next);

  async function run(names: string[], to: string | null) {
    setBusy(true);
    setError(null);
    try {
      await onRename(names, to);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      // A merge keeps this merchant selected, so the editor stays and must be usable again.
      setBusy(false);
    }
  }

  return (
    <div className="merchant-edit">
      <form
        className="edit-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (next && next !== name) void run(autos, next);
        }}
      >
        <label htmlFor="merchant-name">Call it</label>
        <input
          id="merchant-name"
          list="merchant-names"
          value={draft}
          maxLength={80}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
        />
        <datalist id="merchant-names">
          {[...autosByMerchant.keys()].sort().map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <button className="btn" disabled={busy || !next || next === name}>
          {merging ? "Merge" : "Rename"}
        </button>
      </form>
      <p className="edit-hint">
        {merging
          ? `“${next}” already exists, so these become one merchant.`
          : "Type an existing merchant's name to merge the two."}
      </p>
      {similar.length > 0 && (
        <div className="edit-similar">
          <span className="muted">Looks similar:</span>
          {similar.map((m) => (
            <button
              key={m}
              className="chip"
              disabled={busy}
              title={`Merge “${m}” into “${name}”`}
              onClick={() => void run([...(autosByMerchant.get(m) ?? [])], name)}
            >
              + {m}
            </button>
          ))}
        </div>
      )}
      {renamed && (
        <p className="edit-hint">
          Covers {autos.map((a) => `“${a}”`).join(", ")}.{" "}
          <button className="link" disabled={busy} onClick={() => void run(autos, null)}>
            Undo rename
          </button>
        </p>
      )}
      {error && <p className="edit-error">{error}</p>}
    </div>
  );
}
