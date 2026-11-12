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
import AddDialog from "./AddDialog";
import ChangesView from "./ChangesView";
import ExportDialog from "./ExportDialog";
import Lede, { Fig } from "./Lede";
import FlowChart from "./FlowChart";
import MonthChart from "./MonthChart";
import RecurringView from "./RecurringView";
import WorthView from "./WorthView";
import YearView from "./YearView";

const PRESETS: { id: Preset; label: string }[] = [
  { id: "12m", label: "Last 12 months" },
  { id: "ytd", label: "This year" },
  { id: "last-year", label: "Last year" },
  { id: "all", label: "All time" },
];

type Theme = "system" | "light" | "dark";
type Screen = "overview" | "changes" | "recurring" | "year" | "worth";

const SCREENS: { id: Screen; label: string }[] = [
  { id: "overview", label: "Where the money goes" },
  { id: "changes", label: "What changed" },
  { id: "recurring", label: "Recurring charges" },
  { id: "year", label: "Year in review" },
  { id: "worth", label: "Net worth" },
];

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

  // null when the months shown aren't one of the presets (opened from Year in review).
  const [preset, setPreset] = useState<Preset | null>("12m");
  const [screen, setScreen] = useState<Screen>("overview");
  const [changesMonth, setChangesMonth] = useState<string | null>(null);
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
  // The typed-in transaction being changed; null while adding one; undefined when closed.
  const [adding, setAdding] = useState<Txn | null | undefined>(undefined);
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

  // The flow shows every category, so a picked category only highlights its line.
  const flowTxns = useMemo(() => applyFilters(txns, f, "category"), [txns, f]);
  const merchants = useMemo(() => byMerchant(applyFilters(txns, f, "merchant"), income), [txns, f, income]);

  // The other views use only who and what type; they pick their own months.
  const scoped = useMemo(
    () => txns.filter((t) => (!f.person || t.person === f.person) && (!f.kind || t.kind === f.kind)),
    [txns, f.person, f.kind],
  );

  /** From another view to the overview, showing what was clicked across all time. */
  function openInOverview(patch: Partial<Filters>) {
    setScreen("overview");
    const range = {
      ...presetRange("all", first, last),
      ...(patch.from && patch.to ? { from: patch.from, to: patch.to } : {}),
    };
    const match = PRESETS.find((p) => {
      const r = presetRange(p.id, first, last);
      return r.from === range.from && r.to === range.to;
    });
    setPreset(match?.id ?? null);
    setF((prev) => ({
      ...prev,
      ...presetRange("all", first, last),
      month: null,
      category: null,
      merchant: null,
      query: "",
      ...patch,
    }));
    window.scrollTo(0, 0);
  }

  const refiled = useMemo(() => txns.filter((t) => t.original).length, [txns]);
  const scope = f.month ? monthName(f.month) : rangeLabel(f.from, f.to);
  const what = f.category ? categoryLabel(f.category) : f.merchant ? f.merchant : "Spending";
  const when = f.month
    ? `in ${monthName(f.month)}`
    : preset === "12m"
      ? "in the last 12 months"
      : preset === "ytd"
        ? "so far this year"
        : preset === "last-year"
          ? "last year"
          : preset === "all"
            ? "in all"
            : `from ${rangeLabel(f.from, f.to)}`;
  const spentChange = delta("spent");
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
          <span className="logo" aria-hidden="true">
            S
          </span>
          SPLIT
        </div>

        <nav className="nav-group" aria-label="Views">
          {SCREENS.map((v) => (
            <NavItem key={v.id} on={screen === v.id} onClick={() => setScreen(v.id)}>
              {v.label}
            </NavItem>
          ))}
        </nav>

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
        <div className="sheet">
          {screen !== "worth" && (
            <form className="filterbar" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
              {screen === "overview" && (
                <label>
                  Period
                  <select
                    value={preset ?? "custom"}
                    onChange={(e) => e.target.value !== "custom" && choosePreset(e.target.value as Preset)}
                  >
                    {PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                    {preset === null && <option value="custom">{rangeLabel(f.from, f.to)}</option>}
                  </select>
                </label>
              )}
              {people.length > 1 && (
                <label>
                  Whose
                  <select value={f.person ?? ""} onChange={(e) => set({ person: e.target.value || null })}>
                    <option value="">Both of you</option>
                    {people.map((p) => (
                      <option key={p} value={p}>
                        {personLabel(p, me)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Type
                <select value={f.kind ?? ""} onChange={(e) => set({ kind: (e.target.value || null) as Kind | null })}>
                  <option value="">Shared and personal</option>
                  <option value="shared">Shared</option>
                  <option value="personal">Personal</option>
                </select>
              </label>
              {screen === "overview" && (
                <label className="grow">
                  Search
                  <span className="search">
                    <input
                      ref={search}
                      type="search"
                      placeholder="merchant, category or amount"
                      value={f.query}
                      onChange={(e) => set({ query: e.target.value })}
                    />
                    <kbd>/</kbd>
                  </span>
                </label>
              )}
              <button type="button" className="btn primary" onClick={() => setExporting(true)}>
                Export for the phone
              </button>
            </form>
          )}
          {screen === "changes" ? (
            <ChangesView
              txns={scoped}
              income={income}
              month={changesMonth}
              onMonth={setChangesMonth}
              onOpen={openInOverview}
            />
          ) : screen === "worth" ? (
            <WorthView txns={txns} income={income} />
          ) : screen === "year" ? (
            <YearView txns={scoped} income={income} onOpen={openInOverview} />
          ) : screen === "recurring" ? (
            <RecurringView txns={scoped} income={income} today={txns[0].date} onOpen={openInOverview} />
          ) : (
            <>
              <Lede
                eyebrow={`${scope} · ${f.person ? personLabel(f.person, me) : "both of you"}`}
                stats={[
                  !f.kind && `shared ${moneyRound(now.shared)}`,
                  !f.kind && `personal ${moneyRound(now.personal)}`,
                  now.income > 0 && `money in ${moneyRound(now.income)}`,
                  now.income > 0 &&
                    !f.category &&
                    !f.merchant &&
                    `kept ${percent((now.income - now.spent) / now.income)}`,
                  `${now.count.toLocaleString()} purchases`,
                ]}
              >
                {f.person && f.person !== me ? personLabel(f.person, me) : "You"} spent{" "}
                <Fig>{moneyRound(now.spent)}</Fig>
                {f.category
                  ? ` on ${categoryLabel(f.category).toLowerCase()}`
                  : f.merchant
                    ? ` at ${f.merchant}`
                    : ""}{" "}
                {when}
                {!f.month && months.length > 1 && (
                  <>
                    , <Fig>{moneyRound(now.spent / months.length)}</Fig> a month
                  </>
                )}
                {spentChange !== null && (
                  <>
                    , <Fig>{percent(Math.abs(spentChange))}</Fig> {spentChange >= 0 ? "more" : "less"} than the{" "}
                    {f.month ? "month" : "period"} before
                  </>
                )}
                .
              </Lede>

              {chips.length > 0 && (
                <div className="chips">
                  {chips.map((c) => (
                    <button key={c.label} className="chip" onClick={c.clear} title="Remove this filter">
                      {c.label} <span aria-hidden="true">×</span>
                    </button>
                  ))}
                  <button
                    className="link"
                    onClick={() =>
                      set({ month: null, category: null, merchant: null, person: null, kind: null, query: "" })
                    }
                  >
                    Clear all <kbd>Esc</kbd>
                  </button>
                </div>
              )}

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

              <section className="panel">
                <div className="panel-head">
                  <h2>Where it went</h2>
                  <div className="legend">
                    <span>
                      <span className="swatch shared" />
                      Shared
                    </span>
                    <span>
                      <span className="swatch personal" />
                      Personal
                    </span>
                    <span>
                      <span className="swatch kept" />
                      Kept
                    </span>
                  </div>
                </div>
                <FlowChart
                  txns={flowTxns}
                  income={income}
                  selected={f.category}
                  onSelect={(category) => set({ category })}
                />
              </section>

              <div className="split">
                <section className="panel">
                  <div className="panel-head">
                    <h2>By category</h2>
                  </div>
                  <ul className="ledger">
                    {categories.map((c) => (
                      <li
                        key={c.category}
                        className={`${f.category === c.category ? "on" : ""}${f.category && f.category !== c.category ? " dim" : ""}`}
                      >
                        <button
                          className="ledger-row"
                          aria-pressed={f.category === c.category}
                          onClick={() => set({ category: f.category === c.category ? null : c.category })}
                        >
                          <span className="ledger-name">{categoryLabel(c.category)}</span>
                          <span className="leader" aria-hidden="true" />
                          <span className="ledger-meta">{percent(c.share)}</span>
                          <span className="ledger-amount">{moneyRound(c.total)}</span>
                        </button>
                      </li>
                    ))}
                    {categories.length === 0 && <li className="empty">Nothing here.</li>}
                  </ul>
                  {categories.length > 0 && (
                    <div className="ledger-total">
                      <span>Total</span>
                      <span>{moneyRound(categories.reduce((n, c) => n + c.total, 0))}</span>
                    </div>
                  )}
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
                onAdd={setAdding}
                onClassify={(changes) => post("/api/classify", { changes })}
                onRemember={(rules) => post("/api/rules", { rules })}
              />
            </>
          )}
        </div>
        <div className="torn" aria-hidden="true" />
      </main>
      {exporting && <ExportDialog data={data} onData={onData} onClose={() => setExporting(false)} />}
      {adding !== undefined && (
        <AddDialog
          txn={adding}
          me={me}
          people={people}
          income={income}
          categories={data.categories}
          merchants={[...autosByMerchant.keys()].sort()}
          onSave={(body) => post("/api/added", body)}
          onClose={() => setAdding(undefined)}
        />
      )}
    </div>
  );
}

function NavItem({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button className={`nav-item${on ? " on" : ""}`} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
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
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Top merchants</h2>
        <span className="muted">{selected ? "" : "select one to rename or merge it"}</span>
      </div>
      {selected && autosByMerchant.has(selected) && (
        <MerchantEditor key={selected} name={selected} autosByMerchant={autosByMerchant} onRename={onRename} />
      )}
      <ul className="ledger">
        {shown.map((m) => (
          <li
            key={m.merchant}
            className={`${selected === m.merchant ? "on" : ""}${selected && selected !== m.merchant ? " dim" : ""}`}
          >
            <button
              className="ledger-row"
              aria-pressed={selected === m.merchant}
              onClick={() => onSelect(selected === m.merchant ? null : m.merchant)}
            >
              <span className="ledger-name">
                {m.merchant}
                <span className="ledger-sub">{categoryLabel(m.category)}</span>
              </span>
              <span className="leader" aria-hidden="true" />
              <span className="ledger-meta">×{m.count}</span>
              <span className="ledger-amount">{moneyRound(m.total)}</span>
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="empty">Nothing here.</li>}
      </ul>
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
  onAdd,
  onClassify,
  onRemember,
}: {
  txns: Txn[];
  all: Txn[];
  me: string;
  income: string;
  categories: string[];
  onMerchant: (m: string) => void;
  onAdd: (txn: Txn | null) => void;
  onClassify: (changes: Change[]) => Promise<void>;
  onRemember: (rules: Rule[]) => Promise<void>;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "date", desc: true });
  const [limit, setLimit] = useState(100);
  // The entry being refiled: only it shows the category and type pickers.
  const [active, setActive] = useState<string | null>(null);
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
        <button className="btn add-txn" onClick={() => onAdd(null)}>
          + Add transaction
        </button>
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
            <tr key={t.id} className={`${selected.has(t.id) ? "picked" : ""}${active === t.id ? " active" : ""}`}>
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
                {t.added && (
                  <button
                    className="edited"
                    title="You typed this one in. Click to change or delete it."
                    onClick={() => onAdd(t)}
                  >
                    added
                  </button>
                )}
              </td>
              <td className="nowrap">
                {active !== t.id ? (
                  <button
                    className="row-button muted"
                    aria-label={`${categoryLabel(t.category)}: change how ${t.merchant} on ${dayLabel(t.date)} is filed`}
                    onClick={() => setActive(t.id)}
                  >
                    {categoryLabel(t.category)}
                  </button>
                ) : (
                  <select
                    className="cell-select"
                    autoFocus
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
                )}
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
                {active !== t.id ? (
                  <button className="row-button muted" onClick={() => setActive(t.id)}>
                    {t.kind === "shared" ? "Shared" : "Personal"}
                  </button>
                ) : (
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
                )}
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
