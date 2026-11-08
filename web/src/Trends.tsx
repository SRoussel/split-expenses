import { useMemo, useState } from "react";
import { ChartTable, ColumnChart, signed } from "./charts";
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
import { Segmented } from "./ui";

const monthLong = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const monthShort = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
const pct = (share: number) => `${Math.round(share * 100)}%`;

/** Spending and cash flow over 6 months, 12 months or the year so far: totals only. */
export default function Trends({
  index,
  batches,
  view,
  viewLabel,
  end,
  me,
  partner,
  catName,
}: {
  index: SpendingIndex;
  batches: SpendingBatch[];
  view: View;
  viewLabel: string;
  end: string;
  me: string;
  partner: string | null;
  catName: (c: string) => string;
}) {
  const [range, setRange] = useState<Range>("12m");
  const months = rangeMonths(end, range);
  const report = useMemo(() => rangeReport(index, batches, view, months, me, partner), [index, batches, view, months.join(), me, partner]);
  const cashflow = report.income !== null;
  const anyPartial = report.partial.some(Boolean);
  const period =
    range === "ytd" ? `${end.slice(0, 4)} so far` : `${monthShort(months[0])} – ${monthLong(months[months.length - 1])}`;
  const hasData = report.spent !== 0 || (report.income ?? 0) !== 0;

  async function exportCsv() {
    const who = viewLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await saveTextFile(`spending-${who}-${months[0]}-to-${months[months.length - 1]}.csv`, reportCsv(report, catName));
  }

  return (
    <div className="trends">
      <Segmented
        label="Range"
        value={range}
        onChange={setRange}
        options={[
          { value: "6m", label: "6 months" },
          { value: "12m", label: "1 year" },
          { value: "ytd", label: "This year" },
        ]}
      />

      <section className="card cashflow">
        <span className="muted small">
          {cashflow ? "Net cash flow" : "Shared spending"}, {period}
        </span>
        <strong className={`hero ${cashflow && report.net! < 0 ? "neg-text" : ""}`}>
          {cashflow ? signed(report.net!) : fmt(report.spent)}
        </strong>
        {cashflow && report.income! > 0 && (
          <span className="muted small">
            {report.net! >= 0
              ? `Kept ${Math.round((report.net! / report.income!) * 100)}% of what came in`
              : `Spent ${fmt(-report.net!)} more than came in`}
          </span>
        )}
        {cashflow && (
          <div className="tiles">
            <div>
              <span className="muted small">Money in</span>
              <strong>{fmt(report.income!)}</strong>
            </div>
            <div>
              <span className="muted small">Spent</span>
              <strong>{fmt(report.spent)}</strong>
            </div>
          </div>
        )}
      </section>

      {!hasData ? (
        <p className="muted center">Nothing for {period} yet.</p>
      ) : (
        <>
          <section className="card">
            <h3 className="card-title">{cashflow ? "Net cash flow by month" : "Shared spending by month"}</h3>
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
            <h3 className="card-title">By category, {period}</h3>
            <p className="muted small multiples-note">
              Largest first. Each chart has its own scale, so look at the shape; the numbers say how big.
            </p>
            <div className="multiples">
              {report.categories.map((c) => (
                <div key={c.category} className="multiple">
                  <strong className="multiple-name">{catName(c.category)}</strong>
                  <span className="amount">{c.total < 0 ? `−${fmt(c.total)}` : fmt(c.total)}</span>
                  <span className="muted small">
                    {c.average !== null ? `${fmt(c.average)}/mo` : "no full month yet"} · {pct(c.share)}
                  </span>
                  <ColumnChart
                    compact
                    height={84}
                    label={`${catName(c.category)} by month, ${period}`}
                    columns={months.map((m, i) => ({
                      key: m,
                      label: monthShort(m),
                      value: Math.max(0, c.series[i]),
                      partial: report.partial[i],
                      title: `${monthLong(m)}: ${fmt(c.series[i])}`,
                      details: [{ value: c.series[i] < 0 ? `−${fmt(c.series[i])}` : fmt(c.series[i]), label: monthShort(m) + (report.partial[i] ? "*" : "") }],
                    }))}
                  />
                </div>
              ))}
            </div>
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
                          <td key={i}>{v < 0 ? `−${fmt(v)}` : fmt(v)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>

          {anyPartial && (
            <p className="muted small center">
              * Lighter bars are months that are only partly uploaded. They're left out of the per-month averages.
            </p>
          )}

          <button onClick={() => void exportCsv()}>Export these totals as CSV</button>
          <p className="muted small center">
            One row per month: money in, spent, net and each category. Totals only, saved to this device.
          </p>
        </>
      )}
    </div>
  );
}
