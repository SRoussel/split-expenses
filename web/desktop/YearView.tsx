// Year in review: one calendar year at a glance. Totals against the year before (when the
// files cover it), the months, categories and merchants, and a few highlights.

import { useMemo, useState } from "react";
import { change, yearInReview, type Filters, type Txn } from "./analytics";
import { categoryLabel, dayLabel, monthName, moneyRound, percent, rangeLabel } from "./format";
import MonthChart from "./MonthChart";

export default function YearView({
  txns,
  income,
  onOpen,
}: {
  txns: Txn[];
  income: string;
  onOpen: (patch: Partial<Filters>) => void;
}) {
  const years = useMemo(() => [...new Set(txns.map((t) => t.date.slice(0, 4)))].sort(), [txns]);
  const [year, setYear] = useState(years[years.length - 1] ?? "");
  const r = useMemo(() => yearInReview(txns, year, income), [txns, year, income]);
  if (!txns.length) return <p className="muted">No transactions for this selection.</p>;

  const whole = r.months.length === 12;
  const span = r.months.length ? rangeLabel(r.months[0], r.months[r.months.length - 1]) : "";
  const vs = (now: number, before: number | undefined) => {
    const c = before === undefined ? null : change(now, before);
    return c === null ? null : `${c >= 0 ? "▲" : "▼"} ${percent(Math.abs(c))} vs the same months last year`;
  };
  // To the overview: this year, up to the last month in the files.
  const inYear = { from: `${year}-01`, to: r.months[r.months.length - 1] ?? `${year}-12` };
  const top = Math.max(1, ...r.categories.map((c) => c.total));
  const startsHere = !txns.some((t) => t.date < `${year}-01-01`);

  return (
    <>
      <header className="top">
        <div>
          <h1>{year} in review</h1>
          <p className="sub">{whole ? "The whole year" : `Your files cover ${span}`}</p>
        </div>
        {years.length > 1 && (
          <div className="stepper" role="group" aria-label="Year">
            {years.map((y) => (
              <button
                key={y}
                className={`btn${y === year ? " on" : ""}`}
                aria-pressed={y === year}
                onClick={() => setYear(y)}
              >
                {y}
              </button>
            ))}
          </div>
        )}
      </header>

      <section className="kpis">
        <Stat label="Spent" value={moneyRound(r.totals.spent)} sub={vs(r.totals.spent, r.previous?.spent)} />
        <Stat
          label="Shared"
          swatch="shared"
          value={moneyRound(r.totals.shared)}
          sub={vs(r.totals.shared, r.previous?.shared)}
        />
        <Stat
          label="Personal"
          swatch="personal"
          value={moneyRound(r.totals.personal)}
          sub={vs(r.totals.personal, r.previous?.personal)}
        />
        <Stat label="Money in" value={moneyRound(r.totals.income)} sub={vs(r.totals.income, r.previous?.income)} />
        <Stat label="A month, on average" value={moneyRound(r.totals.spent / Math.max(1, r.months.length))} />
      </section>

      <section className="facts">
        {r.busiest && (
          <Fact
            label="Biggest month"
            value={monthName(r.busiest.month).split(" ")[0]}
            sub={moneyRound(r.busiest.shared + r.busiest.personal)}
            onClick={() => onOpen({ ...inYear, month: r.busiest!.month })}
          />
        )}
        {r.quietest && (
          <Fact
            label="Quietest month"
            value={monthName(r.quietest.month).split(" ")[0]}
            sub={moneyRound(r.quietest.shared + r.quietest.personal)}
            onClick={() => onOpen({ ...inYear, month: r.quietest!.month })}
          />
        )}
        {r.biggest && (
          <Fact
            label="Biggest purchase"
            value={moneyRound(r.biggest.cents)}
            sub={`${r.biggest.merchant}, ${dayLabel(r.biggest.date)}`}
            onClick={() => onOpen({ ...inYear, merchant: r.biggest!.merchant })}
          />
        )}
        {r.mostVisited && (
          <Fact
            label="Most visits"
            value={r.mostVisited.merchant}
            sub={`${r.mostVisited.count} times, ${moneyRound(r.mostVisited.total)} in all`}
            onClick={() => onOpen({ ...inYear, merchant: r.mostVisited!.merchant })}
          />
        )}
        {startsHere ? (
          <Fact label="New places" value="–" sub="Your files start this year, so every place is new" />
        ) : (
          <Fact
            label="New places"
            value={String(r.fresh.length)}
            sub={
              r.fresh.length
                ? `Like ${r.fresh
                    .slice(0, 3)
                    .map((m) => m.merchant)
                    .join(", ")}`
                : "Nowhere new"
            }
          />
        )}
        <Fact
          label="Recurring charges"
          value={`${moneyRound(r.recurring.perYear)} a year`}
          sub={`${r.recurring.count} active at the end of ${r.months.length ? monthName(r.months[r.months.length - 1]) : year}`}
        />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Month by month</h2>
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
        <MonthChart rows={r.byMonth} selected={null} onSelect={(month) => month && onOpen({ ...inYear, month })} />
      </section>

      <div className="split">
        <section className="panel">
          <div className="panel-head">
            <h2>Categories</h2>
            <span className="muted">{r.previous ? "against the same months last year" : ""}</span>
          </div>
          <table className="grid-table">
            <thead>
              <tr>
                <th>Category</th>
                <th className="bar-col" aria-label="Relative amount" />
                <th className="num">Amount</th>
                <th className="num">{r.previous ? "Last year" : "Share"}</th>
              </tr>
            </thead>
            <tbody>
              {r.categories.map((c) => {
                const d = c.before === null ? null : change(c.total, c.before);
                return (
                  <tr
                    key={c.category}
                    className="clickable"
                    onClick={() => onOpen({ ...inYear, category: c.category })}
                  >
                    <td>
                      <button className="row-button">{categoryLabel(c.category)}</button>
                    </td>
                    <td className="bar-col">
                      <span className="hbar" style={{ width: `${(Math.max(0, c.total) / top) * 100}%` }} />
                    </td>
                    <td className="num">{moneyRound(c.total)}</td>
                    <td className="num muted">
                      {c.before === null
                        ? percent(c.share)
                        : d === null
                          ? "new"
                          : `${d >= 0 ? "▲" : "▼"} ${percent(Math.abs(d))}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Top merchants</h2>
            <span className="muted">{r.merchants.length} in all</span>
          </div>
          <table className="grid-table">
            <thead>
              <tr>
                <th>Merchant</th>
                <th className="num">Visits</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {r.merchants.slice(0, 12).map((m) => (
                <tr key={m.merchant} className="clickable" onClick={() => onOpen({ ...inYear, merchant: m.merchant })}>
                  <td>
                    <button className="row-button">{m.merchant}</button>
                    <span className="cell-sub">{categoryLabel(m.category)}</span>
                  </td>
                  <td className="num muted">{m.count}</td>
                  <td className="num">{moneyRound(m.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}

function Stat({ label, value, sub, swatch }: { label: string; value: string; sub?: string | null; swatch?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">
        {swatch && <span className={`swatch ${swatch}`} />}
        {label}
      </div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-delta">{sub}</div>}
    </div>
  );
}

function Fact({ label, value, sub, onClick }: { label: string; value: string; sub: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="fact-label">{label}</span>
      <span className="fact-value">{value}</span>
      <span className="fact-sub">{sub}</span>
    </>
  );
  return onClick ? (
    <button className="fact" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="fact">{body}</div>
  );
}
