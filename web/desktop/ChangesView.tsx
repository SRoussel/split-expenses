// What changed: one month against the months before it. Which categories and merchants
// moved, where you went for the first time, and the regulars you skipped.

import { useMemo, useState } from "react";
import { monthOf, shiftMonth, whatChanged, type Filters, type Mover, type Txn } from "./analytics";
import Lede, { Fig } from "./Lede";
import { categoryLabel, dayLabel, monthName, moneyRound, rangeLabel } from "./format";

export default function ChangesView({
  txns,
  income,
  onOpen,
}: {
  txns: Txn[];
  income: string;
  onOpen: (patch: Partial<Filters>) => void;
}) {
  const first = txns.length ? monthOf(txns[txns.length - 1].date) : "";
  const last = txns.length ? monthOf(txns[0].date) : "";
  const lastDay = txns.length ? txns[0].date : "";
  const [month, setMonth] = useState(last);
  const c = useMemo(() => whatChanged(txns, month, income), [txns, month, income]);
  if (!txns.length) return <p className="muted">No transactions for this selection.</p>;

  const diff = c.now - c.usual;
  const [y, m] = month.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const partial = month === last && lastDay < monthEnd;
  const compared = c.compared.length
    ? `against the average of ${rangeLabel(c.compared[0], c.compared[c.compared.length - 1])}`
    : "with nothing earlier to compare against";

  // The category that moved most in the same direction as the total.
  const top = c.categories.find((x) => (diff >= 0 ? x.diff > 0 : x.diff < 0)) ?? null;

  return (
    <>
      <Lede
        eyebrow={`What changed · ${monthName(month)} ${compared}`}
        stats={[
          c.compared.length > 0 && `a usual month ${moneyRound(c.usual)}`,
          `${c.fresh.length} new place${c.fresh.length === 1 ? "" : "s"}`,
          c.missing.length > 0 && `${c.missing.length} regular${c.missing.length === 1 ? "" : "s"} skipped`,
          partial && `your files run to ${dayLabel(lastDay)}, so this month may not be complete`,
        ]}
        actions={
          <div className="stepper" role="group" aria-label="Month">
            <button className="btn" disabled={month <= first} onClick={() => setMonth(shiftMonth(month, -1))}>
              ‹ <span className="sr-only">Previous month</span>
            </button>
            <span className="stepper-label">{monthName(month)}</span>
            <button className="btn" disabled={month >= last} onClick={() => setMonth(shiftMonth(month, 1))}>
              › <span className="sr-only">Next month</span>
            </button>
          </div>
        }
      >
        {monthName(month).split(" ")[0]}: <Fig>{moneyRound(c.now)}</Fig> spent
        {c.compared.length > 0 && c.usual > 0 ? (
          <>
            , <Fig>{moneyRound(Math.abs(diff))}</Fig> {diff >= 0 ? "more" : "less"} than a usual month
            {top && (
              <>
                , mostly <em>{categoryLabel(top.key).toLowerCase()}</em>
              </>
            )}
          </>
        ) : null}
        .
      </Lede>

      <section className="panel">
        <div className="panel-head">
          <h2>Categories</h2>
          <div className="legend">
            <span>
              <span className="swatch more" />
              more than usual
            </span>
            <span>
              <span className="swatch less" />
              less than usual
            </span>
          </div>
        </div>
        <MoverTable
          rows={c.categories}
          label="Category"
          month={month}
          name={categoryLabel}
          onPick={(category) => onOpen({ category, month })}
        />
      </section>

      <div className="split">
        <section className="panel">
          <div className="panel-head">
            <h2>Merchants that moved most</h2>
          </div>
          <MoverTable
            rows={c.merchants.slice(0, 10)}
            label="Merchant"
            month={month}
            name={(m) => m}
            onPick={(merchant) => onOpen({ merchant, month })}
          />
        </section>
        <div className="stack-panels">
          <section className="panel">
            <div className="panel-head">
              <h2>New this month</h2>
              <span className="muted">first time ever</span>
            </div>
            {c.fresh.length ? (
              <table className="grid-table">
                <tbody>
                  {c.fresh.map((m) => (
                    <tr key={m.merchant} className="clickable" onClick={() => onOpen({ merchant: m.merchant, month })}>
                      <td>
                        <button className="row-button">{m.merchant}</button>
                        <span className="cell-sub">{categoryLabel(m.category)}</span>
                      </td>
                      <td className="num muted">{m.count}×</td>
                      <td className="num">{moneyRound(m.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="empty">Nowhere new.</p>
            )}
          </section>
          <section className="panel">
            <div className="panel-head">
              <h2>Usually there, not this month</h2>
            </div>
            {c.missing.length ? (
              <table className="grid-table">
                <tbody>
                  {c.missing.map((m) => (
                    <tr key={m.merchant} className="clickable" onClick={() => onOpen({ merchant: m.merchant })}>
                      <td>
                        <button className="row-button">{m.merchant}</button>
                        <span className="cell-sub">last {dayLabel(m.last)}</span>
                      </td>
                      <td className="num muted">usually {moneyRound(m.usual)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="empty">Every regular showed up.</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function Signed({ cents }: { cents: number }) {
  return <>{cents > 0 ? `+${moneyRound(cents)}` : cents < 0 ? moneyRound(cents) : "$0"}</>;
}

/** Rows with this month, the usual month, and a bar out from the middle: right for more, left for less. */
function MoverTable({
  rows,
  label,
  month,
  name,
  onPick,
}: {
  rows: Mover[];
  label: string;
  month: string;
  name: (key: string) => string;
  onPick: (key: string) => void;
}) {
  const widest = Math.max(1, ...rows.map((r) => Math.abs(r.diff)));
  if (!rows.length) return <p className="empty">Nothing here.</p>;
  return (
    <table className="grid-table movers">
      <thead>
        <tr>
          <th>{label}</th>
          <th className="num">{monthName(month).split(" ")[0]}</th>
          <th className="num">Usual</th>
          <th className="div-col" aria-label="Change" />
          <th className="num">Change</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const share = (Math.abs(r.diff) / widest) * 50;
          return (
            <tr key={r.key} className="clickable" onClick={() => onPick(r.key)}>
              <td>
                <button className="row-button">{name(r.key)}</button>
              </td>
              <td className="num">{moneyRound(r.now)}</td>
              <td className="num muted">{moneyRound(r.usual)}</td>
              <td className="div-col">
                <span className="div-track">
                  <span
                    className={`div-bar ${r.diff >= 0 ? "more" : "less"}`}
                    style={r.diff >= 0 ? { left: "50%", width: `${share}%` } : { right: "50%", width: `${share}%` }}
                  />
                </span>
              </td>
              <td className="num">
                {r.diff > 0 ? "▲ " : r.diff < 0 ? "▼ " : ""}
                <Signed cents={r.diff} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
