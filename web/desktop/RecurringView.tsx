// Recurring charges: subscriptions and bills, found from merchants that charge on a steady
// schedule. Shows what each costs a year, when the next one is due, and price changes.

import { useMemo } from "react";
import { findRecurring, type Filters, type Recurring, type Txn } from "./analytics";
import Lede, { Fig } from "./Lede";
import { categoryLabel, dayLabel, money, moneyRound } from "./format";
import { Sparkline } from "./MonthChart";

const HOW_OFTEN = { weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" };

export default function RecurringView({
  txns,
  income,
  today,
  onOpen,
}: {
  txns: Txn[];
  income: string;
  today: string;
  onOpen: (patch: Partial<Filters>) => void;
}) {
  const found = useMemo(() => findRecurring(txns, income, today), [txns, income, today]);
  const active = found.filter((r) => r.active);
  const stopped = found.filter((r) => !r.active);
  const perYear = active.reduce((n, r) => n + r.perYear, 0);
  const changed = active.filter((r) => r.change);

  return (
    <>
      <Lede
        eyebrow="Recurring charges · subscriptions, memberships and bills that come round on their own"
        stats={[
          `about ${moneyRound(perYear)} a year`,
          changed.length > 0 &&
            `price changed: ${changed
              .slice(0, 3)
              .map((r) => r.merchant)
              .join(", ")}`,
          stopped.length > 0 && `${stopped.length} stopped`,
        ]}
      >
        <Fig>{active.length}</Fig> charge{active.length === 1 ? "" : "s"} come round on their own, about{" "}
        <Fig>{moneyRound(perYear / 12)}</Fig> a month.
      </Lede>

      <section className="panel">
        <div className="panel-head">
          <h2>Active</h2>
          <span className="muted">charged within the last cycle or so</span>
        </div>
        <RecurringTable rows={active} onOpen={onOpen} />
      </section>

      {stopped.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Stopped</h2>
            <span className="muted">no charge for a while: cancelled, or moved somewhere else</span>
          </div>
          <RecurringTable rows={stopped} onOpen={onOpen} stopped />
        </section>
      )}
    </>
  );
}

function RecurringTable({
  rows,
  onOpen,
  stopped = false,
}: {
  rows: Recurring[];
  onOpen: (patch: Partial<Filters>) => void;
  stopped?: boolean;
}) {
  if (!rows.length) return <p className="empty">None found.</p>;
  return (
    <table className={`grid-table recurring${stopped ? " stopped" : ""}`}>
      <thead>
        <tr>
          <th>Merchant</th>
          <th>How often</th>
          <th className="num">Amount</th>
          <th className="num">A year</th>
          <th className="spark-col">Charges</th>
          <th>{stopped ? "Last charge" : "Next, about"}</th>
          <th aria-label="Notes" />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={`${r.merchant}|${r.plan ?? ""}`}
            className="clickable"
            onClick={() => onOpen({ merchant: r.merchant })}
            title="Show these charges in the overview"
          >
            <td>
              <button className="row-button">{r.merchant}</button>
              <span className="cell-sub">
                {categoryLabel(r.category)}
                {r.plan !== null && ` · the ${money(r.plan)} plan`}
              </span>
            </td>
            <td className="muted">
              {HOW_OFTEN[r.cadence]} <span className="cell-sub">×{r.count}</span>
            </td>
            <td className="num">
              {r.varies && <span className="muted">~</span>}
              {money(r.amount)}
            </td>
            <td className="num">{moneyRound(r.perYear)}</td>
            <td className="spark-col">
              <Sparkline values={r.charges.slice(-12).map((c) => c.cents)} />
            </td>
            <td className="muted nowrap">{dayLabel(stopped ? r.last : r.next)}</td>
            <td className="nowrap">
              {r.change && (
                <span className={`pill ${r.amount > r.change.from ? "up" : "down"}`}>
                  {r.amount > r.change.from ? "▲" : "▼"} from {money(r.change.from)} since {dayLabel(r.change.since)}
                </span>
              )}
              {r.varies && <span className="pill">varies</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
