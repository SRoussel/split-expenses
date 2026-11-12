// "Where this is heading": today's savings and investments carried forward, with saving until
// retirement and spending after it. A fan shows the range of outcomes across a couple of
// thousand runs of good and bad market years. The numbers you type are remembered in this
// browser only.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { project, sustainableSpend, type Plan } from "./projection";
import { money, moneyCompact, moneyRound, percent } from "./format";

const KEY = "insights-projection";
const HEIGHT = 260;
const PAD = { top: 16, right: 12, bottom: 28, left: 56 };

type Inputs = Record<
  | "age"
  | "retireAge"
  | "endAge"
  | "save"
  | "spend"
  | "other"
  | "otherAge"
  | "stockShare"
  | "stockReturn"
  | "stockSwing"
  | "cashReturn",
  string
>;

function load(): Partial<Inputs> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const num = (s: string | undefined) => {
  const n = Number((s ?? "").replace(/[$,%\s]/g, ""));
  return s !== undefined && s.trim() !== "" && Number.isFinite(n) ? n : null;
};

export default function Projection({
  start,
  stockShare,
  saveMonthly,
  spendMonthly,
}: {
  /** Cash, investments and retirement now, less debts other than a mortgage, in cents. */
  start: number;
  /** The share of `start` in investment and retirement accounts now. */
  stockShare: number;
  /** What you've kept each month on average, from your transactions; null without income. */
  saveMonthly: number | null;
  /** What you've spent each month on average, from your transactions. */
  spendMonthly: number;
}) {
  // Defaults come from your accounts and transactions; anything you type replaces them.
  const defaults: Inputs = {
    age: "",
    retireAge: "65",
    endAge: "95",
    save: saveMonthly !== null ? String(Math.max(0, Math.round(saveMonthly / 100))) : "",
    spend: String(Math.round(spendMonthly / 100)),
    other: "0",
    otherAge: "67",
    stockShare: String(Math.round(stockShare * 100)),
    stockReturn: "5",
    stockSwing: "17",
    cashReturn: "0.5",
  };
  const [typed, setTyped] = useState<Partial<Inputs>>(load);
  const v: Inputs = { ...defaults, ...typed };
  const set = (k: keyof Inputs, value: string) => {
    const next = { ...typed, [k]: value };
    setTyped(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* not remembered, still used */
    }
  };
  const reset = () => {
    const next = v.age ? { age: v.age } : {};
    setTyped(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* fine */
    }
  };

  const age = num(v.age);
  const plan: Plan | null =
    age !== null && age >= 16 && age < 100
      ? (() => {
          const retireAge = Math.max(age, num(v.retireAge) ?? 65);
          return {
            age: Math.round(age),
            retireAge: Math.round(retireAge),
            endAge: Math.round(Math.min(110, Math.max(retireAge + 1, num(v.endAge) ?? 95))),
            start,
            stockShare: Math.min(1, Math.max(0, (num(v.stockShare) ?? 80) / 100)),
            saveMonthly: (num(v.save) ?? 0) * 100,
            spendMonthly: Math.max(0, (num(v.spend) ?? 0) * 100),
            otherIncomeMonthly: Math.max(0, (num(v.other) ?? 0) * 100),
            otherIncomeAge: num(v.otherAge) ?? 67,
            stockReturn: (num(v.stockReturn) ?? 5) / 100,
            stockSwing: Math.max(0, (num(v.stockSwing) ?? 17) / 100),
            cashReturn: (num(v.cashReturn) ?? 0.5) / 100,
          };
        })()
      : null;
  const key = JSON.stringify(plan);
  const result = useMemo(() => (plan ? project(plan) : null), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const canSpend = useMemo(() => (plan ? sustainableSpend(plan) : null), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const field = (k: keyof Inputs, label: string, unit: "$" | "%" | "", hint?: string) => (
    <label className="proj-field" key={k}>
      <span>{label}</span>
      <span className={`proj-input${unit ? ` unit-${unit === "$" ? "money" : "pct"}` : ""}`}>
        <input
          id={`proj-${k}`}
          inputMode="decimal"
          value={v[k]}
          placeholder={k === "age" ? "e.g. 38" : undefined}
          onChange={(e) => set(k, e.target.value)}
        />
      </span>
      {hint && <small>{hint}</small>}
    </label>
  );

  const at = (a: number) => (result ? result.ages.indexOf(a) : -1);
  const r = plan && result ? at(plan.retireAge) : -1;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Where this is heading</h2>
        <span className="muted">in today&apos;s dollars · an estimate from your assumptions, not advice</span>
      </div>

      <div className="proj-inputs">
        <fieldset>
          <legend>You</legend>
          {field("age", "Your age", "")}
          {field("retireAge", "Retire at", "")}
          {field("endAge", "Make it last to", "")}
        </fieldset>
        <fieldset>
          <legend>Money</legend>
          {field(
            "save",
            "Save a month until then",
            "$",
            saveMonthly !== null ? "starts at what you kept a month this past year" : undefined,
          )}
          {field("spend", "Spend a month in retirement", "$", "starts at what you spend a month now")}
          {field("other", "Social Security or pension a month", "$", "your estimate at ssa.gov")}
          {field("otherAge", "…starting at", "")}
        </fieldset>
        <fieldset>
          <legend>Markets, after inflation</legend>
          {field("stockShare", "In stocks", "%", "starts at your investment and retirement share")}
          {field("stockReturn", "Stocks return a year", "%")}
          {field("stockSwing", "…swinging by about", "%", "a typical year's ups and downs")}
          {field("cashReturn", "Cash and bonds return", "%")}
        </fieldset>
      </div>
      <p className="proj-start muted">
        Starting from {moneyRound(start)}: cash, investments and retirement, less debts other than a mortgage. The home
        isn&apos;t counted, since you live in it.{" "}
        {Object.keys(typed).some((k) => k !== "age") && (
          <button className="link" onClick={reset}>
            Back to the starting numbers
          </button>
        )}
      </p>

      {!plan || !result ? (
        <p className="empty">Type your age to see the projection.</p>
      ) : (
        <>
          <p className="proj-lede">
            {r >= 0 && plan.retireAge > plan.age ? (
              <>
                At {plan.retireAge} you&apos;d likely have <b>{moneyRound(result.mid[r])}</b> (8 in 10 outcomes between{" "}
                {moneyRound(result.low[r])} and {moneyRound(result.high[r])}).{" "}
              </>
            ) : null}
            Spending {moneyRound(plan.spendMonthly)} a month, the money lasts to {plan.endAge} in{" "}
            <b>{percent(result.lasts)}</b> of outcomes.{" "}
            {canSpend !== null && (
              <>
                To make it last in 9 of 10, keep spending to about <b>{moneyRound(canSpend)}</b> a month
                {plan.otherIncomeMonthly > 0
                  ? `, counting ${moneyRound(plan.otherIncomeMonthly)} from age ${plan.otherIncomeAge}`
                  : ""}
                .
              </>
            )}
          </p>
          <FanChart
            ages={result.ages}
            low={result.low}
            mid={result.mid}
            high={result.high}
            retireAge={plan.retireAge}
          />
        </>
      )}
    </section>
  );
}

function FanChart({
  ages,
  low,
  mid,
  high,
  retireAge,
}: {
  ages: number[];
  low: number[];
  mid: number[];
  high: number[];
  retireAge: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  // Measured before the first paint, then kept up to date.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.max(320, Math.floor(el.clientWidth)));
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scaled to the middle line and the band at retirement: the luckiest outcomes decades on
  // would otherwise flatten everything else. Anything above is clipped (the tooltip has it all).
  const retireAt = ages.indexOf(retireAge);
  const top = Math.max(1, ...mid, retireAt >= 0 ? high[retireAt] : high[high.length - 1]) * 1.1;
  const clipped = Math.max(...high) > top;
  const step = niceStep(top);
  const max = Math.ceil(top / step) * step;
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (ages.length > 1 ? (i / (ages.length - 1)) * plotW : 0);
  const y = (v: number) => PAD.top + plotH - (Math.max(0, v) / max) * plotH;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const line = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const band = `${line(high)}${low
    .map((v, i) => [i, v] as const)
    .reverse()
    .map(([i, v]) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join("")}Z`;
  const ri = ages.indexOf(retireAge);
  const everyAge = plotW / ages.length < 28 ? 10 : 5;
  const thisYear = new Date().getFullYear();
  const tipLeft = hover === null ? 0 : Math.min(Math.max(x(hover), 110), width - 110);

  return (
    <div className="month-chart proj-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`Projected savings by age, from ${ages[0]} to ${ages[ages.length - 1]}`}
        onMouseMove={(e) => {
          const box = ref.current!.getBoundingClientRect();
          const i = Math.round(((e.clientX - box.left - PAD.left) / plotW) * (ages.length - 1));
          setHover(Math.max(0, Math.min(ages.length - 1, i)));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="axis" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {moneyCompact(t)}
            </text>
          </g>
        ))}
        {ages.map((a, i) =>
          a % everyAge === 0 ? (
            <text key={a} className="axis" x={x(i)} y={HEIGHT - 8} textAnchor="middle">
              {a}
            </text>
          ) : null,
        )}
        <clipPath id="proj-clip">
          <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} />
        </clipPath>
        <g clipPath="url(#proj-clip)">
          <path className="proj-band" d={band} />
          <path className="proj-mid" d={line(mid)} />
        </g>
        {ri > 0 && (
          <g>
            <line className="proj-retire" x1={x(ri)} x2={x(ri)} y1={PAD.top} y2={PAD.top + plotH} />
            <text className="axis" x={x(ri) + 6} y={PAD.top + 10}>
              retire at {retireAge}
            </text>
          </g>
        )}
        <line className="baseline" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
        {hover !== null && (
          <g>
            <line className="proj-cross" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} />
            <circle className="proj-dot" cx={x(hover)} cy={y(mid[hover])} r={4} />
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: tipLeft, top: 4 }} role="status">
          <div className="tip-title">
            Age {ages[hover]} · {thisYear + hover}
          </div>
          <div className="tip-row">
            Likely <b>{money(mid[hover])}</b>
          </div>
          <div className="tip-row">
            8 in 10 between{" "}
            <b>
              {moneyCompact(low[hover])}–{moneyCompact(high[hover])}
            </b>
          </div>
        </div>
      )}
      <p className="proj-key muted">
        <span className="swatch proj" /> the line is the middle outcome; the shaded band holds 8 in 10 of them
        {clipped ? " (its top runs off the chart later on; hover for the numbers)" : ""}
      </p>
    </div>
  );
}

/** A round step for about four gridlines. */
function niceStep(max: number): number {
  const raw = Math.max(max, 100) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
