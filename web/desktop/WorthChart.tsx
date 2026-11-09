// Net worth by month: assets stacked above the line (cash, invested, retirement, property),
// debts below it, and net worth as a line with a dot per month. Hover for the numbers.

import { useEffect, useRef, useState } from "react";
import { ASSET_GROUPS, type Group, type WorthRow } from "./analytics";
import { money, moneyCompact, monthLabel, monthName } from "./format";

export const GROUP_LABEL: Record<Group, string> = {
  cash: "Cash",
  invested: "Invested",
  retirement: "Retirement",
  property: "Property & other",
  debt: "Debt",
};

const HEIGHT = 260;
const PAD = { top: 12, right: 12, bottom: 26, left: 56 };
const GAP = 2;

function niceStep(span: number): number {
  const raw = Math.max(span, 100) / 5;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

export default function WorthChart({ rows }: { rows: WorthRow[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(300, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const top = Math.max(
    0,
    ...rows.map((r) => ASSET_GROUPS.reduce((n, g) => n + Math.max(0, r.groups[g]), 0)),
    ...rows.map((r) => r.net),
  );
  const bottom = Math.min(0, ...rows.map((r) => -r.groups.debt), ...rows.map((r) => r.net));
  const step = niceStep(top - bottom);
  const max = Math.ceil(top / step) * step || step;
  const min = Math.floor(bottom / step) * step;
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / Math.max(1, rows.length);
  const barW = Math.min(28, band * 0.6);
  const y = (v: number) => PAD.top + ((max - v) / (max - min)) * plotH;
  const zero = y(0);
  const ticks: number[] = [];
  for (let v = min; v <= max + 1; v += step) ticks.push(v);
  const every = band < 34 ? 2 : 1;
  const cx = (i: number) => PAD.left + band * i + band / 2;
  const line = rows.map((r, i) => `${i ? "L" : "M"}${cx(i).toFixed(1)},${y(r.net).toFixed(1)}`).join("");
  const hovered = hover === null ? null : rows[hover];

  return (
    <div className="month-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={HEIGHT} role="img" aria-label="Net worth by month">
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? "baseline" : "grid"} x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="axis" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {moneyCompact(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = cx(i) - barW / 2;
          let up = zero;
          const segs = ASSET_GROUPS.filter((g) => r.groups[g] > 0).map((g, k, list) => {
            const h = (r.groups[g] / (max - min)) * plotH;
            const bottomY = up - (k ? GAP : 0);
            const topY = bottomY - Math.max(0, h - (k ? GAP : 0));
            up = topY;
            const last = k === list.length - 1;
            const r4 = last ? Math.min(4, bottomY - topY, barW / 2) : 0;
            const d =
              bottomY - topY < 0.5
                ? ""
                : `M${x},${bottomY}V${topY + r4}Q${x},${topY} ${x + r4},${topY}H${x + barW - r4}Q${x + barW},${topY} ${x + barW},${topY + r4}V${bottomY}Z`;
            return <path key={g} className={`seg g-${g}`} d={d} />;
          });
          const debtH = (r.groups.debt / (max - min)) * plotH;
          const r4 = Math.min(4, debtH, barW / 2);
          const debt =
            debtH < 0.5
              ? null
              : `M${x},${zero}V${zero + debtH - r4}Q${x},${zero + debtH} ${x + r4},${zero + debtH}H${x + barW - r4}Q${x + barW},${zero + debtH} ${x + barW},${zero + debtH - r4}V${zero}Z`;
          return (
            <g key={r.month} className="col" onMouseEnter={() => setHover(i)}>
              <rect className="hit" x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} />
              {segs}
              {debt && <path className="seg g-debt" d={debt} />}
              {(i % every === 0 || r.month.endsWith("-01")) && (
                <text
                  className={`axis${r.month.endsWith("-01") ? " year" : ""}`}
                  x={cx(i)}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                >
                  {r.month.endsWith("-01") ? r.month.slice(0, 4) : monthLabel(r.month)}
                </text>
              )}
            </g>
          );
        })}
        <path className="net-line" d={line} />
        {rows.map((r, i) => (
          <circle key={r.month} className="net-dot" cx={cx(i)} cy={y(r.net)} r={hover === i ? 5 : 3.5} />
        ))}
      </svg>
      {hovered && (
        <div
          className="tooltip"
          style={{ left: Math.min(Math.max(cx(hover!), 100), width - 100), top: 4 }}
          role="status"
        >
          <div className="tip-title">{monthName(hovered.month)}</div>
          {[...ASSET_GROUPS, "debt" as Group]
            .filter((g) => hovered.groups[g])
            .map((g) => (
              <div className="tip-row" key={g}>
                <span className={`swatch g-${g}`} />
                {GROUP_LABEL[g]} <b>{g === "debt" ? `−${money(hovered.groups[g])}` : money(hovered.groups[g])}</b>
              </div>
            ))}
          <div className="tip-row total">
            Net worth <b>{money(hovered.net)}</b>
          </div>
        </div>
      )}
    </div>
  );
}
