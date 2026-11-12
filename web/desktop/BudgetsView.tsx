// Budgets: a monthly amount per category for the household (shared and personal, both of you),
// and each month's spending against it. Saved by split-insights in desktop-data/budgets.json.

import { useEffect, useMemo, useState } from "react";
import {
  budgetRows,
  monthOf,
  monthRange,
  shiftMonth,
  suggestBudget,
  type BudgetRow,
  type Filters,
  type Txn,
} from "./analytics";
import Lede, { Fig } from "./Lede";
import { categoryLabel, dayLabel, money, moneyRound, monthName } from "./format";

export default function BudgetsView({
  txns,
  income,
  budgets,
  month: chosen,
  onMonth,
  onSave,
  onOpen,
}: {
  txns: Txn[];
  income: string;
  budgets: Record<string, number>;
  month: string | null;
  onMonth: (month: string) => void;
  onSave: (budgets: Record<string, number>) => Promise<void>;
  onOpen: (patch: Partial<Filters>) => void;
}) {
  const first = monthOf(txns[txns.length - 1].date);
  const last = monthOf(txns[0].date);
  const lastDay = txns[0].date;
  const month = !chosen || chosen > last ? last : chosen < first ? first : chosen;
  const months = useMemo(() => monthRange(first, last).reverse(), [first, last]);
  const rows = useMemo(() => budgetRows(txns, month, income, budgets), [txns, month, income, budgets]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  /** Budgets go to the phone app with each statement upload; this sends them now. */
  async function sendToApp() {
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const r = await fetch("/api/app/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error ?? `Couldn't send (the server said ${r.status}).`);
      setSent("Sent. The phone app shows these budgets now.");
    } catch (e) {
      setError(e instanceof Error ? `Couldn't send the budgets: ${e.message}` : "Couldn't send the budgets.");
    } finally {
      setBusy(false);
    }
  }

  async function save(next: Record<string, number>) {
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }
  const setOne = (category: string, cents: number | null) => {
    const next = { ...budgets };
    if (cents === null) delete next[category];
    else next[category] = cents;
    void save(next);
  };

  const budgeted = rows.filter((r) => r.budget !== null);
  const spentBudgeted = budgeted.reduce((n, r) => n + r.spent, 0);
  const totalBudget = budgeted.reduce((n, r) => n + r.budget!, 0);
  const over = budgeted.filter((r) => r.spent > r.budget!);
  const unbudgeted = rows.filter((r) => r.budget === null).reduce((n, r) => n + r.spent, 0);
  const suggestions = rows.filter((r) => r.budget === null && suggestBudget(r.average) > 0);
  const [y, m] = month.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const partial = month === last && lastDay < monthEnd;
  const left = totalBudget - spentBudgeted;
  const name = monthName(month).split(" ")[0];

  return (
    <>
      <Lede
        eyebrow={`Budgets · ${monthName(month)} · both of you`}
        stats={[
          budgeted.length > 0 && `${over.length} of ${budgeted.length} budgets over`,
          unbudgeted > 0 && `${moneyRound(unbudgeted)} in categories without a budget`,
          partial && `your files run to ${dayLabel(lastDay)}, so this month isn't over`,
        ]}
        actions={
          <div className="stepper" role="group" aria-label="Month">
            <button className="btn" disabled={month <= first} onClick={() => onMonth(shiftMonth(month, -1))}>
              ‹ <span className="sr-only">Previous month</span>
            </button>
            <select
              className="stepper-label"
              aria-label="Month"
              value={month}
              onChange={(e) => onMonth(e.target.value)}
            >
              {months.map((mo) => (
                <option key={mo} value={mo}>
                  {monthName(mo)}
                </option>
              ))}
            </select>
            <button className="btn" disabled={month >= last} onClick={() => onMonth(shiftMonth(month, 1))}>
              › <span className="sr-only">Next month</span>
            </button>
          </div>
        }
      >
        {budgeted.length ? (
          <>
            {name}: <Fig>{moneyRound(spentBudgeted)}</Fig> spent of <Fig>{moneyRound(totalBudget)}</Fig> budgeted,{" "}
            <Fig>{moneyRound(Math.abs(left))}</Fig> {left >= 0 ? "left" : "over"}.
          </>
        ) : (
          <>Set a monthly budget for a category to see how each month measures up.</>
        )}
      </Lede>

      <section className="panel">
        <div className="panel-head">
          <h2>By category</h2>
          <div className="panel-actions">
            {suggestions.length > 0 && (
              <button
                className="btn"
                disabled={busy}
                title="Each category without a budget gets its monthly average over the past year, rounded up to $10"
                onClick={() =>
                  void save({
                    ...budgets,
                    ...Object.fromEntries(suggestions.map((r) => [r.category, suggestBudget(r.average)])),
                  })
                }
              >
                Fill in the rest from your averages
              </button>
            )}
            <button className="btn primary" disabled={busy} onClick={() => void sendToApp()}>
              Send budgets to the app
            </button>
          </div>
        </div>
        {error && <p className="warn">{error}</p>}
        {sent && <p className="note">{sent}</p>}
        <table className="grid-table budgets">
          <thead>
            <tr>
              <th>Category</th>
              <th className="num">Budget</th>
              <th className="num">{name}</th>
              <th className="num">Left</th>
              <th className="budget-bar-col" aria-label="Spent against the budget" />
              <th className="num">Past year</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row
                key={r.category}
                row={r}
                busy={busy}
                onBudget={(cents) => setOne(r.category, cents)}
                onOpen={() => onOpen({ category: r.category, month })}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No spending this past year.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="proj-note muted">
          Everything the two of you spent, shared and personal, against one budget per category. Budgets are saved in{" "}
          <code>desktop-data/budgets.json</code>. Clear a budget to stop tracking that category. This page is the one
          place budgets are set: they go to the phone app with each statement you send or export, or right away with
          Send budgets to the app (that needs a desktop key).
        </p>
      </section>
    </>
  );
}

function Row({
  row: r,
  busy,
  onBudget,
  onOpen,
}: {
  row: BudgetRow;
  busy: boolean;
  onBudget: (cents: number | null) => void;
  onOpen: () => void;
}) {
  const shown = r.budget === null ? "" : String(Math.round(r.budget / 100));
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const clean = draft.replace(/[$,\s]/g, "");
    if (clean === shown) return;
    if (clean === "") return onBudget(null);
    const dollars = Number(clean);
    if (!Number.isFinite(dollars) || dollars <= 0) return setDraft(shown);
    onBudget(Math.round(dollars * 100));
  };
  const overBy = r.budget !== null ? r.spent - r.budget : 0;
  // Each bar is scaled to its own budget, which always sits four fifths of the way along,
  // leaving room to show going over.
  const base = r.budget === null ? 1 : Math.max(r.budget / 0.8, r.spent);
  const scale = (v: number) => `${(Math.max(0, v) / base) * 100}%`;

  return (
    <tr className={overBy > 0 ? "over" : ""}>
      <td>
        <button className="row-button" onClick={onOpen}>
          {categoryLabel(r.category)}
        </button>
      </td>
      <td className="num">
        <span className="proj-input unit-money budget-input">
          <input
            id={`budget-${r.category}`}
            inputMode="decimal"
            aria-label={`Monthly budget for ${categoryLabel(r.category)}`}
            placeholder="none"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </span>
      </td>
      <td className="num">{money(r.spent)}</td>
      <td className="num">
        {r.budget === null ? (
          <span className="muted">–</span>
        ) : overBy > 0 ? (
          <span className="over-by">▲ {moneyRound(overBy)} over</span>
        ) : (
          moneyRound(-overBy)
        )}
      </td>
      <td className="budget-bar-col">
        {r.budget !== null && (
          <span className="budget-track">
            <span className="budget-limit" style={{ left: scale(r.budget) }} />
            <span className="budget-fill" style={{ width: scale(Math.min(r.spent, r.budget)) }} />
            {overBy > 0 && <span className="budget-over" style={{ left: scale(r.budget), width: scale(overBy) }} />}
          </span>
        )}
      </td>
      <td className="num muted">
        {moneyRound(r.average)} a month
        {r.budget !== null && r.monthsCounted > 0 && (
          <span className="cell-sub">
            over in {r.overMonths} of {r.monthsCounted}
          </span>
        )}
      </td>
    </tr>
  );
}
