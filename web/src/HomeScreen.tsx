// Home: the month so far, for both of you. The balance and when you last settled, this
// month's spending against the household's budgets, and the latest entries.

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { categoryLabel, SPENDING_CATEGORIES } from "../shared/categories";
import { getSpending, setBudgets } from "./api";
import { budgetLines, lastSettled, monthlyAverages, roundBudget } from "./home";
import { fmt, parseDollars, todayLocal } from "./ledger";
import { buildIndex, coverage, summarize, UNCATEGORIZED } from "./spending";
import type { Entry, Member, SpendingData } from "./types";
import { ErrorText, Modal, MoneyInput } from "./ui";

const dayShort = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const monthLong = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", timeZone: "UTC" });
const catName = (c: string) => (c === UNCATEGORIZED ? "No category" : categoryLabel(c));

export default function HomeScreen({
  userId,
  members,
  entries,
  balance,
  renderEntry,
  onSeeAll,
}: {
  userId: string;
  members: Member[];
  entries: Entry[];
  /** The balance card, as the Ledger shows it. */
  balance: ReactNode;
  renderEntry: (e: Entry) => ReactNode;
  onSeeAll: () => void;
}) {
  const partner = members.find((m) => m.user_id !== userId);
  const partnerId = partner?.user_id ?? null;
  const [data, setData] = useState<SpendingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getSpending());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load this month's spending.");
    }
  }, []);
  useEffect(() => {
    void load();
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const today = todayLocal();
  const month = today.slice(0, 7);
  const settled = lastSettled(entries, today);
  const index = useMemo(
    () =>
      data
        ? buildIndex(
            entries,
            data,
            members.map((m) => m.user_id),
          )
        : null,
    [entries, data, members],
  );
  const spent = index ? summarize(index, "household", month, userId, partnerId).categories : {};
  const budgets = data?.budgets ?? [];
  const { lines, other } = budgetLines(spent, budgets);
  const totalBudget = lines.reduce((n, l) => n + l.budget, 0);
  const totalSpent = lines.reduce((n, l) => n + l.spent, 0);
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = Number(today.slice(8));
  const recent = entries.filter((e) => !e.voided_at).slice(0, 5);

  // How far each person's uploaded statements reach into this month.
  // You first, then your partner.
  const people = [...members].sort((a, b) => Number(b.user_id === userId) - Number(a.user_id === userId));
  const reach = data
    ? people.map((mem) => {
        const c = coverage(data.batches, mem.user_id, month);
        const name = mem.user_id === userId ? "yours" : `${mem.display_name}'s`;
        if (!c.ranges.length) return null;
        const lastDay = c.ranges[c.ranges.length - 1][1];
        return `${name} run to ${dayShort(`${month}-${String(lastDay).padStart(2, "0")}`)}`;
      })
    : [];
  const statements = reach.every((r) => r === null)
    ? `No statements for ${monthLong(month)} yet, so card spending shows up once you upload them.`
    : `Statements: ${reach.map((r, i) => r ?? `${i === 0 ? "yours" : `${people[i].display_name}'s`} aren't in yet`).join("; ")}.`;

  return (
    <>
      {balance}
      <p className="home-settled muted small">
        {settled
          ? settled.daysAgo === 0
            ? "Settled up today."
            : `Last settled ${settled.daysAgo === 1 ? "yesterday" : `${settled.daysAgo} days ago`}, on ${dayShort(settled.date)}.`
          : "You haven't settled up in the app yet."}
      </p>

      <ErrorText message={error} />

      <section className="card home-budgets">
        <h2 className="card-title">
          {monthLong(month)} · day {day} of {daysInMonth}
        </h2>
        {!data ? (
          <p className="muted small">Loading…</p>
        ) : lines.length === 0 ? (
          <div className="stack">
            <p className="muted small">
              Set a monthly budget for the categories you care about, and this shows how the month is going for both of
              you.
            </p>
            <button onClick={() => setEditing(true)}>Set budgets</button>
          </div>
        ) : (
          <>
            <p className="home-total">
              <strong>{fmt(totalSpent)}</strong> of {fmt(totalBudget)}
              <span className="muted">
                {" "}
                ·{" "}
                {totalSpent <= totalBudget
                  ? `${fmt(totalBudget - totalSpent)} left`
                  : `${fmt(totalSpent - totalBudget)} over`}
              </span>
            </p>
            <ul className="budget-lines">
              {lines.map((l) => (
                <BudgetMeter key={l.category} line={l} pace={day / daysInMonth} />
              ))}
            </ul>
            {other > 0 && <p className="muted small">Plus {fmt(other)} in categories without a budget.</p>}
            <p className="muted small">
              Expenses added here count right away. {statements} The pale tick on each bar is where you&apos;d be if you
              spent evenly through the month.
            </p>
            <button className="link" onClick={() => setEditing(true)}>
              Change budgets
            </button>
          </>
        )}
      </section>

      {recent.length > 0 && (
        <section className="card">
          <h2 className="card-title">Latest</h2>
          <ul className="entries">{recent.map((e) => renderEntry(e))}</ul>
          <button className="link" onClick={onSeeAll}>
            See everything in the Ledger
          </button>
        </section>
      )}

      {editing && index && (
        <BudgetsForm
          current={budgets}
          averages={monthlyAverages(index, month, userId, partnerId)}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
    </>
  );
}

function BudgetMeter({ line: l, pace }: { line: { category: string; budget: number; spent: number }; pace: number }) {
  // The budget sits four fifths of the way along, leaving room to show going over.
  const base = Math.max(l.budget / 0.8, l.spent);
  const pct = (v: number) => `${(Math.max(0, v) / base) * 100}%`;
  const over = l.spent - l.budget;
  return (
    <li className={`budget-line${over > 0 ? " over" : ""}`}>
      <div className="budget-line-text">
        <span>{catName(l.category)}</span>
        <span className="budget-line-figures">
          {fmt(l.spent)} <span className="muted">of {fmt(l.budget)}</span>
          {over > 0 && <span className="budget-over-text"> · ▲ {fmt(over)} over</span>}
        </span>
      </div>
      <span className="budget-meter" aria-hidden="true">
        <span className="budget-meter-fill" style={{ width: pct(Math.min(l.spent, l.budget)) }} />
        {over > 0 && <span className="budget-meter-over" style={{ left: pct(l.budget), width: pct(over) }} />}
        <span className="budget-meter-limit" style={{ left: pct(l.budget) }} />
        <span className="budget-meter-pace" style={{ left: pct(l.budget * pace) }} />
      </span>
    </li>
  );
}

function BudgetsForm({
  current,
  averages,
  onClose,
  onSaved,
}: {
  current: { category: string; cents: number }[];
  averages: Record<string, number>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(current.map((b) => [b.category, (b.cents / 100).toFixed(0)])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bad = Object.entries(values).filter(([, v]) => v.trim() !== "" && parseDollars(v) === null);
  const missing = SPENDING_CATEGORIES.filter((c) => !values[c]?.trim() && roundBudget(averages[c] ?? 0) > 0);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (bad.length) return;
    setBusy(true);
    setError(null);
    try {
      const budgets: Record<string, number> = {};
      for (const [c, v] of Object.entries(values)) {
        const cents = parseDollars(v);
        if (cents) budgets[c] = cents;
      }
      await setBudgets(budgets);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the budgets.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Monthly budgets" onClose={onClose}>
      <form className="stack" onSubmit={(e) => void save(e)}>
        <p className="muted small">
          For the two of you together, shared and personal. Leave a category empty to not budget it. You both see the
          same budgets.
        </p>
        {missing.length > 0 && (
          <button
            type="button"
            className="link"
            onClick={() =>
              setValues({
                ...values,
                ...Object.fromEntries(missing.map((c) => [c, (roundBudget(averages[c]) / 100).toFixed(0)])),
              })
            }
          >
            Fill in the empty ones from your average month
          </button>
        )}
        <div className="budget-form">
          {SPENDING_CATEGORIES.map((c) => (
            <label key={c} className="budget-form-row">
              <span>
                {categoryLabel(c)}
                {averages[c] ? <span className="muted small"> · avg {fmt(averages[c])}</span> : null}
              </span>
              <MoneyInput
                aria-label={`Monthly budget for ${categoryLabel(c)}`}
                aria-invalid={bad.some(([k]) => k === c)}
                placeholder="none"
                value={values[c] ?? ""}
                onChange={(e) => setValues({ ...values, [c]: e.target.value })}
              />
            </label>
          ))}
        </div>
        {bad.length > 0 && <p className="error">Amounts look like 450 or 450.00.</p>}
        <ErrorText message={error} />
        <div className="row">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || bad.length > 0}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
