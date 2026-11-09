// Spending per month as columns, shared stacked under personal. Hover for the numbers,
// click a month to look at just that month (click it again to go back).

import { useEffect, useRef, useState } from "react";
import type { MonthRow } from "./analytics";
import { money, moneyCompact, monthLabel, monthName } from "./format";

const HEIGHT = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 48 };
const GAP = 2; // surface gap between the two stacked segments

/** A round step for about four gridlines: 1, 2, 2.5 or 5 × 10^k. */
function niceStep(max: number): number {
  const raw = Math.max(max, 100) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** A column segment with 4px rounded corners on top only when it's the data end. */
function segment(x: number, w: number, bottom: number, top: number, rounded: boolean): string {
  const h = bottom - top;
  if (h < 0.5) return "";
  const r = rounded ? Math.min(4, h, w / 2) : 0;
  return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${bottom}Z`;
}

export default function MonthChart({
  rows,
  selected,
  onSelect,
}: {
  rows: MonthRow[];
  selected: string | null;
  onSelect: (month: string | null) => void;
}) {
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

  const peak = Math.max(0, ...rows.map((r) => Math.max(0, r.shared) + Math.max(0, r.personal)));
  const step = niceStep(peak);
  const max = Math.max(step, Math.ceil(peak / step) * step);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / Math.max(1, rows.length);
  const barW = Math.min(24, band * 0.6);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const base = y(0);
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  // With many months, label every other one (always January, so the year change shows).
  const every = band < 34 ? 2 : 1;

  const hovered = hover === null ? null : rows[hover];
  const tipLeft = hover === null ? 0 : Math.min(Math.max(PAD.left + band * (hover + 0.5), 90), width - 90);

  return (
    <div className="month-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={HEIGHT} role="group" aria-label="Spending by month">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="axis" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {moneyCompact(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = PAD.left + band * i + (band - barW) / 2;
          const shared = Math.max(0, r.shared);
          const personal = Math.max(0, r.personal);
          const sharedTop = y(shared);
          const personalBottom = shared > 0 ? sharedTop - GAP : base;
          const personalTop = Math.min(personalBottom, y(shared + personal) - (shared > 0 ? GAP : 0));
          const dim = selected !== null && selected !== r.month;
          const showLabel = i % every === 0 || r.month.endsWith("-01");
          return (
            <g
              key={r.month}
              className={`col${dim ? " dim" : ""}${selected === r.month ? " on" : ""}`}
              role="button"
              tabIndex={0}
              aria-pressed={selected === r.month}
              aria-label={`${monthName(r.month)}: ${money(r.shared + r.personal)} spent`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              onClick={() => onSelect(selected === r.month ? null : r.month)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(selected === r.month ? null : r.month);
                }
              }}
            >
              <rect className="hit" x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} />
              <path className="seg shared" d={segment(x, barW, base, sharedTop, personal === 0)} />
              <path className="seg personal" d={segment(x, barW, personalBottom, personalTop, true)} />
              {showLabel && (
                <text
                  className={`axis${r.month.endsWith("-01") ? " year" : ""}`}
                  x={x + barW / 2}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                >
                  {r.month.endsWith("-01") ? r.month.slice(0, 4) : monthLabel(r.month)}
                </text>
              )}
            </g>
          );
        })}
        <line className="baseline" x1={PAD.left} x2={width - PAD.right} y1={base} y2={base} />
      </svg>
      {hovered && (
        <div className="tooltip" style={{ left: tipLeft, top: 4 }} role="status">
          <div className="tip-title">{monthName(hovered.month)}</div>
          <div className="tip-row">
            <span className="swatch shared" />
            Shared <b>{money(hovered.shared)}</b>
          </div>
          <div className="tip-row">
            <span className="swatch personal" />
            Personal <b>{money(hovered.personal)}</b>
          </div>
          <div className="tip-row total">
            Total <b>{money(hovered.shared + hovered.personal)}</b>
          </div>
        </div>
      )}
    </div>
  );
}

/** A small trend line for a table row: 2px, round caps, a dot on the last month. */
export function Sparkline({ values, width = 96, height = 18 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const x = (i: number) => 3 + (i / (values.length - 1)) * (width - 6);
  const y = (v: number) => 3 + (1 - (v - min) / (max - min)) * (height - 6);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = values.length - 1;
  return (
    <svg className="spark" width={width} height={height} aria-hidden="true">
      <path d={d} />
      <circle cx={x(last)} cy={y(values[last])} r={2.5} />
    </svg>
  );
}
