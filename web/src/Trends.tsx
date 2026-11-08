import { useMemo, useState } from "react";
import { ChartTable, ColumnChart, signed, Sparkline } from "./charts";
import { saveTextFile } from "./files";
import { fmt } from "./ledger";
import {
  rangeMonths,
  rangeReport,
  reportCsv,
  type Range,
  type SpendingIndex,
  type View,
} from "./spending";
import type { SpendingBatch } from "./types";
import { TallyLine } from "./ui";

const monthLong = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const monthShort = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
const monthYear = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
const pct = (share: number) => `${Math.round(share * 100)}%`;
const amount = (cents: number) => (cents < 0 ? `−${fmt(cents)}` : fmt(cents));

/** Spending and cash flow over 6 months, 12 months or the year so far: totals only. */
export default function Trends({
  index,
  batches,
  view,
  range,
  viewLabel,
  end,
  me,
  partner,
  catName,
}: {
  index: SpendingIndex;
  batches: SpendingBatch[];
  view: View;
  range: Range;
  viewLabel: string;
  end: string;
  me: string;
  partner: string | null;
  catName: (c: string) => string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const months = rangeMonths(end, range);
  const report = useMemo(() => rangeReport(index, batches, view, months, me, partner), [index, batches, view, months.join(), me, partner]);
  const cashflow = report.income !== null;
  const anyPartial = report.partial.some(Boolean);
  const period =
    range === "ytd" ? `${end.slice(0, 4)} so far` : `${monthYear(months[0])} – ${monthYear(months[months.length - 1])}`;
  const hasData = report.spent !== 0 || (report.income ?? 0) !== 0;

  async function exportCsv() {
    const who = viewLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await saveTextFile(`spending-${who}-${months[0]}-to-${months[months.length - 1]}.csv`, reportCsv(report, catName));
  }

  return (
    <div className="trends">
      <section className="card tally" aria-label={`${cashflow ? "Cash flow" : "Shared spending"}, ${period}`}>
        <h3 className="card-title">{period}</h3>
        {cashflow ? (
          <>
            <TallyLine label="In">{fmt(report.income!)}</TallyLine>
            <TallyLine label="Out">{fmt(report.spent)}</TallyLine>
            <TallyLine label="Net" className={`tally-total${report.net! < 0 ? " neg-total" : ""}`}>
              {signed(report.net!)}
            </TallyLine>
            {report.income! > 0 && (
              <p className="tally-note">
                {report.net! >= 0
                  ? `Kept ${Math.round((report.net! / report.income!) * 100)}% of what came in`
                  : `Spent ${fmt(-report.net!)} more than came in`}
              </p>
            )}
          </>
        ) : (
          <TallyLine label="Shared, full amounts" className="tally-total">
            {fmt(report.spent)}
          </TallyLine>
        )}
      </section>

      {!hasData ? (
        <p className="muted center">Nothing for {period} yet.</p>
      ) : (
        <>
          <section className="card">
            <h3 className="card-title">{cashflow ? "Net by month" : "Shared by month"}</h3>
            <ColumnChart
              label={`${cashflow ? "Net cash flow" : "Shared spending"} by month, ${period}`}
              selected={months[months.length - 1]}
              columns={months.map((m, i) => {
                const s = report.summaries[i];
                const empty = s.spent === 0 && !s.income;
                return {
                  key: m,
                  label: monthShort(m),
                  value: cashflow ? s.net! : s.spent,
                  partial: report.partial[i],
                  title: `${monthLong(m)}: ${cashflow ? `net ${signed(s.net!)}` : fmt(s.spent)}${report.partial[i] ? ", partly uploaded" : ""}`,
                  details: empty
                    ? [{ value: monthLong(m), label: "· nothing uploaded" }]
                    : [
                        { value: monthLong(m), label: report.partial[i] ? "· partly uploaded ·" : "·" },
                        ...(cashflow
                          ? [
                              { value: signed(s.net!), label: "net" },
                              { value: fmt(s.income!), label: "in" },
                              { value: fmt(s.spent), label: "spent" },
                            ]
                          : [{ value: fmt(s.spent), label: "shared spending" }]),
                      ],
                };
              })}
            />
            <ChartTable
              head={cashflow ? ["Month", "Money in", "Spent", "Net"] : ["Month", "Spent"]}
              rows={months.map((m, i) => {
                const s = report.summaries[i];
                const name = monthLong(m) + (report.partial[i] ? " *" : "");
                return cashflow ? [name, fmt(s.income!), fmt(s.spent), signed(s.net!)] : [name, fmt(s.spent)];
              })}
            />
          </section>

          <section className="card">
            <h3 className="card-title">By category</h3>
            <p className="muted small multiples-note">Tap one for its months.</p>
            <ul className="cat-bars trend-cats">
              {report.categories.map((c) => {
                const isOpen = open === c.category;
                return (
                  <li key={c.category}>
                    <button
                      aria-expanded={isOpen}
                      onClick={() => setOpen(isOpen ? null : c.category)}
                      aria-label={`${catName(c.category)}: ${amount(c.total)}, ${pct(c.share)} of spending. ${isOpen ? "Hide" : "Show"} months`}
                    >
                      <span className="cat-name">{catName(c.category)}</span>
                      <span className="lead" aria-hidden="true" />
                      <span className="cat-amount">{amount(c.total)}</span>
                      <span className="cat-track">
                        <Sparkline values={c.series} partial={report.partial} label="" />
                      </span>
                      <span className="change">
                        {pct(c.share)} · {c.average !== null ? `${fmt(c.average)}/mo` : "no full month"}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="trend-cat-chart">
                        <ColumnChart
                          height={130}
                          average={c.average}
                          selected={months[months.length - 1]}
                          label={`${catName(c.category)} by month, ${period}`}
                          columns={months.map((m, i) => ({
                            key: m,
                            label: monthShort(m),
                            value: Math.max(0, c.series[i]),
                            partial: report.partial[i],
                            title: `${monthLong(m)}: ${amount(c.series[i])}`,
                            details: [
                              { value: monthLong(m), label: report.partial[i] ? "· partly uploaded ·" : "·" },
                              { value: amount(c.series[i]), label: catName(c.category).toLowerCase() },
                            ],
                          }))}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <details className="chart-table wide">
              <summary>Show numbers</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Total</th>
                      <th>Per month</th>
                      <th>Share</th>
                      {months.map((m, i) => (
                        <th key={m}>
                          {monthShort(m)}
                          {report.partial[i] ? "*" : ""}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.categories.map((c) => (
                      <tr key={c.category}>
                        <td>{catName(c.category)}</td>
                        <td>{fmt(c.total)}</td>
                        <td>{c.average !== null ? fmt(c.average) : "–"}</td>
                        <td>{pct(c.share)}</td>
                        {c.series.map((v, i) => (
                          <td key={i}>{amount(v)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>

          {anyPartial && (
            <p className="muted small center">* Lighter bars: partly uploaded months, left out of averages.</p>
          )}

          <div className="export">
            <button onClick={() => void exportCsv()}>Export totals as CSV</button>
            <p className="muted small center">One row per month. Totals only, saved to this device.</p>
          </div>
        </>
      )}
    </div>
  );
}
