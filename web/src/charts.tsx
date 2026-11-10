// Small, dependency-free charts. Mark specs: bars <= 24px with a 4px rounded data
// end (square at the baseline), hairline solid gridlines, one selective direct
// label, a tooltip on hover/tap/focus, and a table of the same numbers.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmt } from "./ledger";
import { DOTS, isRedacted } from "./redact";

/** $1.2K, $12K, $1.5M (axis labels only; everything else uses full amounts). */
export function compactMoney(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  if (isRedacted()) return `${sign}$${DOTS}`;
  const d = Math.abs(cents) / 100;
  if (d >= 1_000_000) return `${sign}$${(d / 1_000_000).toFixed(d >= 10_000_000 ? 0 : 1)}M`;
  if (d >= 10_000) return `${sign}$${Math.round(d / 1000)}K`;
  if (d >= 1000) return `${sign}$${(d / 1000).toFixed(1)}K`;
  return `${sign}$${Math.round(d)}`;
}

/** A signed amount: "+$12.00" / "−$12.00". */
export const signed = (cents: number) => (cents > 0 ? "+" : cents < 0 ? "−" : "") + fmt(cents);

/** The next "nice" number at or above v (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^k), so bars use the height. */
function niceCeil(v: number): number {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function useWidth<T extends HTMLElement>(initial: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(120, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A bar from the baseline to `y`, with a 4px rounded data end (square at the baseline). */
function barPath(x: number, w: number, base: number, y: number): string {
  const h = Math.abs(base - y);
  if (h < 0.5) return "";
  const r = Math.min(4, h, w / 2);
  if (y < base) {
    return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
  }
  return `M${x},${base}V${y - r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y - r}V${base}Z`;
}

export interface Column {
  key: string;
  /** Short axis label, e.g. "Jan". */
  label: string;
  value: number;
  /** Tooltip rows: value first (strong), then what it is. */
  details: { value: string; label: string }[];
  /** Spoken label for screen readers and keyboard focus. */
  title: string;
  /** A month that's only partly uploaded: drawn lighter, and marked * on the axis. */
  partial?: boolean;
}

/**
 * Columns from a zero baseline. Positive values use --chart-pos, negative --chart-neg,
 * and sit below the line, so the sign never depends on color alone.
 */
export function ColumnChart({
  columns,
  selected,
  onSelect,
  average,
  height = 160,
  label,
  compact = false,
}: {
  columns: Column[];
  selected?: string;
  onSelect?: (key: string) => void;
  average?: number | null;
  height?: number;
  label: string;
  /** Small-multiple size: one tick label, initials on the axis. */
  compact?: boolean;
}) {
  const [wrap, width] = useWidth<HTMLDivElement>(compact ? 140 : 320);
  const [hover, setHover] = useState<string | null>(null);

  const pad = compact ? { left: 34, right: 4, top: 10, bottom: 18 } : { left: 44, right: 8, top: 18, bottom: 22 };
  const values = columns.map((c) => c.value);
  const top = niceCeil(Math.max(0, ...values, average ?? 0)) || 1;
  const bottom = -niceCeil(-Math.min(0, ...values));
  const plotH = height - pad.top - pad.bottom;
  const y = (v: number) => pad.top + ((top - v) / (top - bottom)) * plotH;
  const slot = (width - pad.left - pad.right) / Math.max(1, columns.length);
  const barW = Math.min(24, slot * 0.6);
  const base = y(0);
  // Tick labels too close to each other (a small negative range) keep their gridline but drop the label.
  const ticks = [top, 0, ...(bottom < 0 ? [bottom] : [])].map((t, i, all) => ({
    t,
    showLabel: compact ? i === 0 : i < 2 || Math.abs(y(t) - y(all[1])) >= 14,
  }));
  const active = hover ?? null;
  const labelled = columns.find((c) => c.key === selected);
  // The readout under the chart: the hovered/focused column, else the selected one.
  const readout = columns.find((c) => c.key === active) ?? labelled;

  return (
    <div className="chart" ref={wrap}>
      <svg width={width} height={height} role="img" aria-label={label}>
        {ticks.map(({ t, showLabel }) => (
          <g key={t}>
            <line className="grid" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
            {showLabel && (
              <text className="tick" x={pad.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
                {compactMoney(t)}
              </text>
            )}
          </g>
        ))}
        {columns.map((c, i) => {
          const cx = pad.left + slot * i + slot / 2;
          const isSel = c.key === selected;
          return (
            <g key={c.key}>
              {isSel && (
                <rect
                  className="sel"
                  x={cx - slot / 2 + 1}
                  y={pad.top - 6}
                  width={slot - 2}
                  height={plotH + 6}
                  rx={6}
                />
              )}
              <path
                className={`bar ${c.value < 0 ? "neg" : "pos"}${c.partial ? " partial" : ""}${active && active !== c.key ? " dim" : ""}`}
                d={barPath(cx - barW / 2, barW, base, y(c.value))}
              />
              {(!compact || slot >= 9) && (
                <text className={`xlabel${isSel ? " on" : ""}`} x={cx} y={height - 6} textAnchor="middle">
                  {compact ? c.label.slice(0, 1) : c.label}
                  {c.partial && !compact ? "*" : ""}
                </text>
              )}
              {/* The hit target is the whole slot, bigger than the bar. */}
              <rect
                className="hit"
                x={cx - slot / 2}
                y={0}
                width={slot}
                height={height}
                tabIndex={0}
                role="button"
                aria-label={c.title}
                onPointerEnter={() => setHover(c.key)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(c.key)}
                onBlur={() => setHover(null)}
                onClick={() => onSelect?.(c.key)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect?.(c.key)}
              />
            </g>
          );
        })}
        {average != null && average > 0 && (
          <g className="avg">
            <line x1={pad.left} x2={width - pad.right} y1={y(average)} y2={y(average)} />
            {/* Drawn over the bars, with a paper-colored halo so it stays readable. Left end: the selected (usually latest) column's label sits at the right. */}
            <text x={pad.left + 4} y={y(average) - 4} textAnchor="start">
              avg {compactMoney(average)}
            </text>
          </g>
        )}
        <line className="baseline" x1={pad.left} x2={width - pad.right} y1={base} y2={base} />
        {labelled && !active && labelled.value !== 0 && !compact && (
          <text
            className="direct"
            x={pad.left + slot * columns.indexOf(labelled) + slot / 2}
            // Above the bar's tip; for a negative bar, just above the zero line (the axis labels are below it).
            y={labelled.value >= 0 ? y(labelled.value) - 6 : base - 6}
            textAnchor="middle"
          >
            {compactMoney(labelled.value)}
          </text>
        )}
      </svg>
      {/* A readout line instead of a floating tooltip: it can't be clipped and works the same on touch. */}
      <div className="readout" role="status" aria-live="polite">
        {readout?.details.map((d) => (
          <span key={d.label}>
            <strong>{d.value}</strong> {d.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** "Show numbers": the same values as a table, so nothing depends on hovering. */
export function ChartTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <details className="chart-table">
      <summary>Show numbers</summary>
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/**
 * A tiny column chart with no axis, for a row in a list: it shows the shape of a
 * series, not its size (each sparkline has its own scale). Negative values sit at zero.
 */
export function Sparkline({ values, partial, label }: { values: number[]; partial?: boolean[]; label: string }) {
  const max = Math.max(1, ...values);
  const n = Math.max(1, values.length);
  const H = 20;
  return (
    <svg className="spark" viewBox={`0 0 ${n * 10} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {values.map((v, i) => {
        const h = v > 0 ? Math.max(1.5, (v / max) * H) : 0;
        return (
          <rect
            key={i}
            className={partial?.[i] ? "partial" : undefined}
            x={i * 10 + 2}
            y={H - h}
            width={6}
            height={h}
          />
        );
      })}
      <line x1={0} x2={n * 10} y1={H - 0.5} y2={H - 0.5} />
    </svg>
  );
}
