import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { categoryLabel, SPENDING_CATEGORIES } from "../shared/categories";
import { deleteUpload, getSpending, moveSpending } from "./api";
import { ChartTable, ColumnChart, signed } from "./charts";
import Trends from "./Trends";
import { fmt, parseDollars, todayLocal } from "./ledger";
import {
  buildIndex,
  compare,
  coverage,
  monthsEnding,
  moveSources,
  sharedItemsFor,
  shiftMonth,
  summarize,
  UNCATEGORIZED,
  type MonthSummary,
  type MoveSource,
  type SpendingIndex,
  type View,
} from "./spending";
import type { Entry, Member, SpendingBatch, SpendingData } from "./types";
import { ConfirmDialog, ErrorText, Modal, MoneyInput, Segmented, TallyLine } from "./ui";

const monthLong = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const monthShort = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
const dayShort = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const catName = (c: string) => (c === UNCATEGORIZED ? "No category" : categoryLabel(c));

/** "▲ 40% vs avg" / "▼ 12% vs avg" / "new": change against the average of earlier months. */
function Change({ value, average }: { value: number; average: number | null }) {
  if (average === null || average <= 0) return value > 0 ? <span className="change">new</span> : null;
  const pct = Math.round(((value - average) / average) * 100);
  if (Math.abs(pct) < 5) return <span className="change">≈ avg</span>;
  return (
    <span className="change" title={`Average of earlier months: ${fmt(average)}`}>
      {pct > 0 ? "▲" : "▼"} {Math.abs(pct)}% vs avg
    </span>
  );
}

export default function SpendingScreen({
  userId,
  members,
  entries,
  mode,
}: {
  userId: string;
  members: Member[];
  entries: Entry[];
  mode: "month" | "trends";
}) {
  const partner = members.find((m) => m.user_id !== userId);
  const partnerId = partner?.user_id ?? null;
  const partnerName = partner?.display_name ?? "Partner";
  const nameOf = (id: string) => (id === userId ? "You" : (members.find((m) => m.user_id === id)?.display_name ?? "Someone"));

  const [data, setData] = useState<SpendingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("me");
  const [month, setMonth] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SpendingBatch | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getSpending());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load spending.");
    }
  }, []);

  useEffect(() => {
    void load();
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const index = useMemo(
    () => (data ? buildIndex(entries, data, members.map((m) => m.user_id)) : null),
    [entries, data, members],
  );

  if (!index || !data) {
    return (
      <>
        <ErrorText message={error} />
        <p className="muted center">Loading…</p>
      </>
    );
  }

  const thisMonth = todayLocal().slice(0, 7);
  const latest = index.months.filter((m) => m <= thisMonth).at(-1) ?? thisMonth;
  const current = month ?? latest;
  const first = index.months[0] ?? thisMonth;
  const last = [thisMonth, index.months.at(-1) ?? thisMonth].sort().at(-1)!;

  const sum = (m: string): MonthSummary => summarize(index, view, m, userId, partnerId);
  const summary = sum(current);
  const cats = Object.entries(summary.categories).sort(([, a], [, b]) => b - a);
  const maxCat = Math.max(1, ...cats.map(([, v]) => v));
  const spentCompare = compare(index, view, current, userId, partnerId, (s) => s.spent);
  const people = view === "me" ? [userId] : view === "partner" ? [partnerId!] : view === "household" ? [userId, partnerId!].filter(Boolean) : [];
  const hasCashFlow = view !== "shared";
  // A month only partly covered by uploads can't be compared fairly with full months.
  const covers = people.map((p) => ({ p, c: coverage(data.batches, p, current) }));
  const partial = covers.some(({ c }) => c.covered < c.days);
  const missing = covers.filter(({ c }) => c.covered === 0).map(({ p }) => nameOf(p));

  const six = monthsEnding(current, 6).map((m) => ({ m, s: sum(m) }));
  const viewOptions: { value: View; label: string }[] = [
    { value: "me", label: "You" },
    ...(partner ? [{ value: "partner" as View, label: partnerName }] : []),
    { value: "shared", label: "Shared" },
    ...(partner ? [{ value: "household" as View, label: "Both" }] : []),
  ];

  return (
    <div className="spending">
      <ErrorText message={error} />

      <div className="view-switch">
        <Segmented tabs label="Whose spending" value={view} onChange={setView} options={viewOptions} />
      </div>

      {mode === "trends" ? (
        <Trends
          index={index}
          batches={data.batches}
          view={view}
          viewLabel={viewOptions.find((o) => o.value === view)?.label ?? view}
          end={latest}
          me={userId}
          partner={partnerId}
          catName={catName}
        />
      ) : (
        <>
        <div className="month-nav">
          <button className="icon-btn" aria-label="Previous month" disabled={current <= first} onClick={() => setMonth(shiftMonth(current, -1))}>
            ‹
          </button>
          <h2>{monthLong(current)}</h2>
          <button className="icon-btn" aria-label="Next month" disabled={current >= last} onClick={() => setMonth(shiftMonth(current, 1))}>
            ›
          </button>
        </div>


        {people.length > 0 && <CoverageStrips batches={data.batches} people={people} month={current} nameOf={nameOf} />}

        <section className="card tally" aria-label={hasCashFlow ? "Cash flow" : "Shared spending"}>
          {hasCashFlow ? (
            <>
              <TallyLine label="In">{fmt(summary.income!)}</TallyLine>
              <TallyLine label="Out">
                {!partial && !missing.length && <Change value={summary.spent} average={spentCompare.average} />}{" "}
                {fmt(summary.spent)}
              </TallyLine>
              <TallyLine
                label="Net"
                className={`tally-total${missing.length ? " incomplete" : summary.net! < 0 ? " neg-total" : ""}`}
              >
                {signed(summary.net!)}
              </TallyLine>
              {missing.length > 0 ? (
                <p className="notice small">
                  Nothing uploaded for {missing.join(" or ")} yet, so only shared expenses are counted.
                </p>
              ) : (
                <p className="tally-note">
                  {summary.income! > 0 &&
                    (summary.net! >= 0
                      ? `Kept ${Math.round((summary.net! / summary.income!) * 100)}% of what came in`
                      : `Spent ${fmt(-summary.net!)} more than came in`)}
                  {summary.income! > 0 && partial && ", so far. "}
                  {partial && "Partial month, so no comparisons yet."}
                </p>
              )}
            </>
          ) : (
            <>
              <TallyLine label="Shared, full amounts" className="tally-total">
                {fmt(summary.spent)}
              </TallyLine>
              <p className="tally-note">
                <Change value={summary.spent} average={spentCompare.average} />
              </p>
            </>
          )}
        </section>

        <section className="card">
          <h3 className="card-title">By category</h3>
          {cats.length === 0 ? (
            <p className="muted small">Nothing for {monthLong(current)} yet.</p>
          ) : (
            <ul className="cat-bars">
              {cats.map(([c, v]) => {
                const avg = compare(index, view, current, userId, partnerId, (s) => s.categories[c] ?? 0).average;
                return (
                  <li key={c}>
                    <button onClick={() => setDetail(c)} aria-label={`${catName(c)}: ${fmt(v)}. Details`}>
                      <span className="cat-name">{catName(c)}</span>
                      <span className="lead" aria-hidden="true" />
                      <span className="cat-amount">{v < 0 ? `−${fmt(v)}` : fmt(v)}</span>
                      <span className="cat-track">
                        {v > 0 && <span className="cat-fill" style={{ width: `${(v / maxCat) * 100}%` }} />}
                      </span>
                      {v < 0 ? <span className="change">returns</span> : !partial && <Change value={v} average={avg} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card">
          <h3 className="card-title">{hasCashFlow ? "Net, 6 months" : "Shared, 6 months"}</h3>
          <ColumnChart
            label={`${hasCashFlow ? "Net cash flow" : "Shared spending"} for the 6 months up to ${monthLong(current)}`}
            selected={current}
            onSelect={(m) => setMonth(m)}
            columns={six.map(({ m, s }) => ({
              key: m,
              label: monthShort(m),
              value: hasCashFlow ? s.net! : s.spent,
              title: hasCashFlow
                ? `${monthLong(m)}: in ${fmt(s.income!)}, spent ${fmt(s.spent)}, net ${signed(s.net!)}`
                : `${monthLong(m)}: ${fmt(s.spent)}`,
              details:
                s.spent === 0 && !s.income
                  ? [{ value: monthLong(m), label: "· nothing uploaded" }]
                  : hasCashFlow
                    ? [
                        { value: monthLong(m), label: "·" },
                        { value: signed(s.net!), label: "net" },
                        { value: fmt(s.income!), label: "in" },
                        { value: fmt(s.spent), label: "spent" },
                      ]
                    : [{ value: monthLong(m), label: "·" }, { value: fmt(s.spent), label: "shared spending" }],
            }))}
          />
          <ChartTable
            head={hasCashFlow ? ["Month", "Money in", "Spent", "Net"] : ["Month", "Spent"]}
            rows={six.map(({ m, s }) =>
              hasCashFlow ? [monthLong(m), fmt(s.income!), fmt(s.spent), signed(s.net!)] : [monthLong(m), fmt(s.spent)],
            )}
          />
        </section>

        </>
      )}

      <Uploads batches={data.batches} nameOf={nameOf} onDelete={setDeleting} />

      {detail && (
        <CategoryDetail
          category={detail}
          month={current}
          view={view}
          index={index}
          me={userId}
          partner={partnerId}
          people={people}
          sources={moveSources(entries, data, view, current, detail, userId, partnerId)}
          nameOf={nameOf}
          onMoved={load}
          onClose={() => setDetail(null)}
          onMonth={setMonth}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete this upload?"
          message={
            <>
              Removes <strong>{deleting.name}</strong> ({nameOf(deleting.person_id)}) from spending and cash flow. If the
              same import added a shared entry to the ledger, that entry stays; void it there if you need to.
            </>
          }
          confirmLabel="Delete upload"
          danger
          onConfirm={async () => {
            await deleteUpload(deleting.id);
            await load();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

/** Which days of the month each person's statement uploads cover. */
function CoverageStrips({
  batches,
  people,
  month,
  nameOf,
}: {
  batches: SpendingBatch[];
  people: string[];
  month: string;
  nameOf: (id: string) => string;
}) {
  return (
    <div className="coverage" aria-label="Days covered by statement uploads">
      {people.map((p) => {
        const c = coverage(batches, p, month);
        const who = nameOf(p);
        const text =
          c.covered === 0
            ? "none"
            : c.covered === c.days
              ? "whole month"
              : `${c.ranges.map(([s, e]) => (s === e ? `${s}` : `${s}–${e}`)).join(", ")} · ${c.covered}/${c.days}`;
        return (
          <div key={p} className={`coverage-row${c.covered < c.days ? " partial" : ""}`}>
            <span className="coverage-who" title={who}>
              {who}
            </span>
            <span className="coverage-track" aria-hidden="true">
              {c.ranges.map(([s, e]) => (
                <span
                  key={s}
                  className="coverage-fill"
                  style={{ left: `${((s - 1) / c.days) * 100}%`, width: `${((e - s + 1) / c.days) * 100}%` }}
                />
              ))}
            </span>
            <span className="coverage-text">
              <span className="visually-hidden">{who}'s statements cover: </span>
              {text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Uploads({
  batches,
  nameOf,
  onDelete,
}: {
  batches: SpendingBatch[];
  nameOf: (id: string) => string;
  onDelete: (b: SpendingBatch) => void;
}) {
  if (batches.length === 0) {
    return (
      <p className="muted small center">
        No statement uploads yet. Import one from <strong>More → Import statement summary</strong>.
      </p>
    );
  }
  return (
    <details className="card uploads">
      <summary>
        Statement uploads <span className="muted">({batches.length})</span>
      </summary>
      <ul className="plain">
        {batches.map((b) => (
          <li key={b.id} className="row">
            <span>
              {b.name}
              <br />
              <span className="muted small">
                {nameOf(b.person_id)} · {dayShort(b.start_date)} – {dayShort(b.end_date)}
              </span>
            </span>
            <button className="link small" onClick={() => onDelete(b)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

function CategoryDetail({
  category,
  month,
  view,
  index,
  me,
  partner,
  people,
  sources,
  nameOf,
  onMoved,
  onClose,
  onMonth,
}: {
  category: string;
  month: string;
  view: View;
  index: SpendingIndex;
  me: string;
  partner: string | null;
  people: string[];
  sources: MoveSource[];
  nameOf: (id: string) => string;
  onMoved: () => Promise<void>;
  onClose: () => void;
  onMonth: (m: string) => void;
}) {
  const [moving, setMoving] = useState(false);
  const [moved, setMoved] = useState<{ source: MoveSource; to: string; cents: number } | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

  async function undoMove() {
    if (!moved) return;
    setUndoError(null);
    try {
      await moveSpending({ kind: moved.source.kind, id: moved.source.id, month, from: moved.to, to: category, cents: moved.cents });
      setMoved(null);
      await onMoved();
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : "Couldn't undo that.");
    }
  }

  const pick = (s: MonthSummary) => s.categories[category] ?? 0;
  const year = monthsEnding(month, 12).map((m) => ({ m, v: pick(summarize(index, view, m, me, partner)) }));
  const { average, previous } = compare(index, view, month, me, partner, pick);
  const items = sharedItemsFor(index, view, month, category, me, partner);
  const fromStatements = people.reduce((n, p) => n + (index.personal.get(p)?.get(month)?.[category] ?? 0), 0);
  const value = year[year.length - 1].v;

  return (
    <Modal title={catName(category)} onClose={onClose}>
      <div className="stack">
        <div className="detail-head">
          <span>{monthLong(month)}</span>
          <strong>{value < 0 ? `−${fmt(value)}` : fmt(value)}</strong>
        </div>
        <p className="muted small">
          {previous !== null ? `Previous month ${fmt(previous)}. ` : ""}
          {average !== null ? `Average of earlier months ${fmt(average)}.` : "No earlier months to compare with yet."}
        </p>
        <ColumnChart
          label={`${catName(category)}, 12 months up to ${monthLong(month)}`}
          selected={month}
          onSelect={(m) => {
            onMonth(m);
            onClose();
          }}
          average={average}
          height={150}
          columns={year.map(({ m, v }) => ({
            key: m,
            label: monthShort(m).slice(0, 1),
            value: Math.max(0, v),
            title: `${monthLong(m)}: ${fmt(v)}`,
            details: [{ value: v < 0 ? `−${fmt(v)}` : fmt(v), label: monthLong(m) }],
          }))}
        />
        <ChartTable head={["Month", catName(category)]} rows={year.map(({ m, v }) => [monthLong(m), v < 0 ? `−${fmt(v)}` : fmt(v)])} />

        {moved && (
          <p className="preview small" role="status">
            Moved {fmt(moved.cents)} to {catName(moved.to)}.{" "}
            <button className="link" onClick={() => void undoMove()}>
              Undo
            </button>
          </p>
        )}
        <ErrorText message={undoError} />
        {moving ? (
          <MoveForm
            category={category}
            month={month}
            sources={sources}
            nameOf={nameOf}
            onCancel={() => setMoving(false)}
            onMoved={async (m) => {
              setMoving(false);
              setMoved(m);
              await onMoved();
            }}
          />
        ) : (
          sources.length > 0 && (
            <button onClick={() => { setMoved(null); setMoving(true); }}>Move money to another category</button>
          )
        )}

        {(items.length > 0 || fromStatements !== 0) && (
          <div className="menu-list">
            <h3 className="card-title">What's in it this month</h3>
            <ul className="plain">
              {fromStatements !== 0 && (
                <li className="row">
                  <span>
                    From statement uploads
                    <br />
                    <span className="muted small">monthly total only</span>
                  </span>
                  <span>{fromStatements < 0 ? `−${fmt(fromStatements)}` : fmt(fromStatements)}</span>
                </li>
              )}
              {items.map((i) => (
                <li key={`${i.entryId}-${i.month}`} className="row">
                  <span>
                    {i.name}
                    <br />
                    <span className="muted small">
                      shared · {dayShort(i.date)}
                      {i.counted !== i.cents ? ` · ${fmt(i.cents)} total` : ""}
                    </span>
                  </span>
                  <span>{fmt(i.counted)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** "Move $700 from Groceries to Household": fixes a month's categories without uploading anything new. */
function MoveForm({
  category,
  month,
  sources,
  nameOf,
  onCancel,
  onMoved,
}: {
  category: string;
  month: string;
  sources: MoveSource[];
  nameOf: (id: string) => string;
  onCancel: () => void;
  onMoved: (m: { source: MoveSource; to: string; cents: number }) => Promise<void>;
}) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = sources[sourceIndex];
  const describe = (s: MoveSource) => (s.person ? `${s.name} (${nameOf(s.person)})` : `${s.name} (shared)`);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseDollars(amount);
    if (!to) return setError("Choose where the money goes.");
    if (cents === null) return setError("Enter an amount, like 700 or 700.00.");
    if (cents > source.cents) return setError(`That's more than the ${fmt(source.cents)} there is to move.`);
    setBusy(true);
    setError(null);
    try {
      await moveSpending({ kind: source.kind, id: source.id, month, from: category, to, cents });
      await onMoved({ source, to, cents });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't move that.");
      setBusy(false);
    }
  }

  return (
    <form className="stack move-form" onSubmit={(e) => void submit(e)}>
      <h3 className="card-title">Move money</h3>
      {sources.length > 1 ? (
        <label>
          From
          <select id="move-source" value={sourceIndex} onChange={(e) => setSourceIndex(Number(e.target.value))}>
            {sources.map((s, i) => (
              <option key={`${s.kind}-${s.id}`} value={i}>
                {describe(s)}: {fmt(s.cents)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="muted small">
          From {describe(source)}, which has {fmt(source.cents)} in {catName(category)}.
        </p>
      )}
      <label>
        To
        <select id="move-to" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose a category</option>
          {SPENDING_CATEGORIES.filter((c) => c !== category).map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Amount
        <MoneyInput id="move-amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <span className="hint">
          {source.person === null
            ? `The full shared amount, up to ${fmt(source.cents)}. It changes for both of you; the balance stays the same.`
            : `Up to ${fmt(source.cents)}.`}
        </span>
      </label>
      <ErrorText message={error} />
      <div className="actions-row">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Moving…" : "Move"}
        </button>
      </div>
    </form>
  );
}
