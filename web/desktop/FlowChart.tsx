// Where the money went, as a flow: money in on the left splits into shared, personal and kept,
// and shared and personal split into categories on the right. Band widths are amounts. Hover
// for the numbers; click a category to look at just that one.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Txn } from "./analytics";
import { categoryLabel, money, moneyRound, percent } from "./format";

const TOP_CATEGORIES = 9; // the rest fold into "Everything else"
const NODE_W = 10;
const GAP = 8; // between nodes in a column
const MIN_SLOT = 20; // room for a label, however small the amount
const PAD_Y = 6;

type Mid = "shared" | "personal" | "kept";
type Node = { id: string; label: string; value: number; y: number; h: number; mid?: Mid; category?: string };
type Link = { id: string; from: Node; to: Node; value: number; y0: number; y1: number; h: number; mid: Mid };

const MID_LABEL: Record<Mid, string> = { shared: "Shared", personal: "Personal", kept: "Kept" };

/** Flows for the transactions shown. Returns (negative amounts) lower their category; income is the left side. */
export function flows(txns: Txn[], income: string) {
  let moneyIn = 0;
  const byCat = new Map<string, { shared: number; personal: number }>();
  for (const t of txns) {
    if (t.category === income) {
      moneyIn += t.cents;
      continue;
    }
    const row = byCat.get(t.category) ?? { shared: 0, personal: 0 };
    row[t.kind] += t.cents;
    byCat.set(t.category, row);
  }
  const cats = [...byCat]
    .map(([category, v]) => ({ category, shared: Math.max(0, v.shared), personal: Math.max(0, v.personal) }))
    .filter((c) => c.shared + c.personal > 0)
    .sort((a, b) => b.shared + b.personal - (a.shared + a.personal) || a.category.localeCompare(b.category));
  const top = cats.slice(0, TOP_CATEGORIES);
  const rest = cats.slice(TOP_CATEGORIES);
  if (rest.length === 1) top.push(rest[0]);
  else if (rest.length > 1) {
    top.push({
      category: "",
      shared: rest.reduce((n, c) => n + c.shared, 0),
      personal: rest.reduce((n, c) => n + c.personal, 0),
    });
  }
  const shared = top.reduce((n, c) => n + c.shared, 0);
  const personal = top.reduce((n, c) => n + c.personal, 0);
  return {
    moneyIn: Math.max(0, moneyIn),
    shared,
    personal,
    categories: top,
    folded: rest.length > 1 ? rest.length : 0,
  };
}

export default function FlowChart({
  txns,
  income,
  selected,
  onSelect,
}: {
  txns: Txn[];
  income: string;
  selected: string | null;
  onSelect: (category: string | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ text: string[]; x: number; y: number } | null>(null);
  const [focus, setFocus] = useState<string | null>(null); // a node id: light up its flows

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(480, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const f = useMemo(() => flows(txns, income), [txns, income]);
  const spent = f.shared + f.personal;

  const layout = useMemo(() => {
    if (spent <= 0) return null;
    const kept = Math.max(0, f.moneyIn - spent);
    const fromSavings = Math.max(0, spent - f.moneyIn);
    const total = spent + kept; // the height of the left and middle columns
    const plotH = 300;
    const scale = (plotH - 2 * GAP) / total;
    const h = (v: number) => Math.max(1, v * scale);

    // Left: what came in, and what spending took beyond it.
    const left: Node[] = [];
    if (f.moneyIn > 0) left.push({ id: "in", label: "Money in", value: f.moneyIn, y: 0, h: h(f.moneyIn) });
    if (fromSavings > 0 && f.moneyIn > 0)
      left.push({ id: "savings", label: "Beyond money in", value: fromSavings, y: 0, h: h(fromSavings) });
    if (f.moneyIn <= 0) left.push({ id: "spent", label: "Spent", value: spent, y: 0, h: h(spent) });

    const mid: Node[] = (["shared", "personal", "kept"] as Mid[])
      .map((m) => ({ id: m, label: MID_LABEL[m], value: m === "kept" ? kept : f[m], y: 0, h: 0, mid: m }))
      .filter((n) => n.value > 0)
      .map((n) => ({ ...n, h: h(n.value) }));

    const right: Node[] = f.categories.map((c) => ({
      id: `cat:${c.category}`,
      label: c.category ? categoryLabel(c.category) : `Everything else (${f.folded})`,
      value: c.shared + c.personal,
      y: 0,
      h: h(c.shared + c.personal),
      category: c.category || undefined,
    }));

    // Stack each column; small nodes still get room for their label.
    const stack = (nodes: Node[]) => {
      let y = PAD_Y;
      for (const n of nodes) {
        const slot = Math.max(n.h, MIN_SLOT);
        n.y = y + (slot - n.h) / 2;
        y += slot + GAP;
      }
      return y - GAP + PAD_Y;
    };
    const height = Math.max(stack(left), stack(mid), stack(right));

    const x0 = 170;
    const x2 = width - 230;
    const x1 = Math.round((x0 + x2) / 2);

    // Left to middle: each left node splits across the middle nodes in proportion.
    const links: Link[] = [];
    const outY = new Map<string, number>(left.map((n) => [n.id, n.y]));
    const inY = new Map<string, number>(mid.map((n) => [n.id, n.y]));
    for (const m of mid) {
      for (const l of left) {
        let value: number;
        if (m.mid === "kept") value = l.id === "in" ? m.value : 0;
        else if (l.id === "spent") value = m.value;
        else if (l.id === "in") value = (m.value / spent) * Math.min(f.moneyIn, spent);
        else value = (m.value / spent) * fromSavings;
        if (value <= 0) continue;
        const lh = value * scale;
        links.push({
          id: `${l.id}>${m.id}`,
          from: l,
          to: m,
          value,
          y0: outY.get(l.id)!,
          y1: inY.get(m.id)!,
          h: lh,
          mid: m.mid!,
        });
        outY.set(l.id, outY.get(l.id)! + lh);
        inY.set(m.id, inY.get(m.id)! + lh);
      }
    }
    // Middle to right: shared and personal into each category.
    const midOut = new Map<string, number>(mid.map((n) => [n.id, n.y]));
    for (const r of right) {
      let y = r.y;
      const c = f.categories.find((x) => (x.category || undefined) === r.category)!;
      for (const k of ["shared", "personal"] as const) {
        const m = mid.find((n) => n.id === k);
        if (!m || c[k] <= 0) continue;
        const lh = c[k] * scale;
        links.push({ id: `${k}>${r.id}`, from: m, to: r, value: c[k], y0: midOut.get(k)!, y1: y, h: lh, mid: k });
        midOut.set(k, midOut.get(k)! + lh);
        y += lh;
      }
    }
    return { left, mid, right, links, height, x: [x0, x1, x2], total: spent + kept };
  }, [f, spent, width]);

  if (!layout) return <p className="empty">No spending here to show.</p>;
  const { left, mid, right, links, height, x } = layout;
  const colX = (n: Node) => (left.includes(n) ? x[0] : mid.includes(n) ? x[1] : x[2]);

  const band = (l: Link) => {
    const a = colX(l.from) + NODE_W;
    const b = colX(l.to);
    const c = (a + b) / 2;
    return `M${a},${l.y0}C${c},${l.y0} ${c},${l.y1} ${b},${l.y1}V${l.y1 + l.h}C${c},${l.y1 + l.h} ${c},${l.y0 + l.h} ${a},${l.y0 + l.h}Z`;
  };
  const share = (v: number) => percent(v / Math.max(1, spent));
  const lit = (l: Link) => !focus || l.from.id === focus || l.to.id === focus;
  const selectedId = selected ? `cat:${selected}` : null;

  const tip = (text: string[], e: React.MouseEvent) => {
    const box = ref.current!.getBoundingClientRect();
    setHover({ text, x: Math.min(e.clientX - box.left + 12, width - 200), y: e.clientY - box.top + 12 });
  };
  const nodeText = (n: Node) =>
    n.mid === "kept"
      ? [n.label, `${money(n.value)} of money in wasn't spent`]
      : n.id === "in"
        ? [n.label, money(n.value)]
        : n.id === "savings"
          ? [n.label, `${money(n.value)} more went out than came in`]
          : [n.label, `${money(n.value)} · ${share(n.value)} of spending`];

  return (
    <div className="flow-chart" ref={ref} onMouseLeave={() => (setHover(null), setFocus(null))}>
      <svg width={width} height={height} role="group" aria-label="Where the money went, by type and category">
        {links.map((l) => (
          <path
            key={l.id}
            className={`flow ${l.mid}${lit(l) ? "" : " faded"}`}
            d={band(l)}
            onMouseMove={(e) =>
              tip(
                [
                  `${l.from.label} → ${l.to.label}`,
                  `${money(l.value)}${l.mid === "kept" ? "" : ` · ${share(l.value)} of spending`}`,
                ],
                e,
              )
            }
          />
        ))}
        {[...left, ...mid, ...right].map((n) => {
          const isRight = right.includes(n);
          const isLeft = left.includes(n);
          const clickable = isRight && !!n.category;
          const on = selectedId === n.id;
          const lx = isLeft ? colX(n) - 8 : colX(n) + NODE_W + 8;
          return (
            <g
              key={n.id}
              className={`flow-node${clickable ? " clickable" : ""}${on ? " on" : ""}${selectedId && isRight && !on ? " dim" : ""}`}
              onMouseEnter={() => setFocus(n.id)}
              onMouseMove={(e) => tip(nodeText(n), e)}
              {...(clickable
                ? {
                    role: "button",
                    tabIndex: 0,
                    "aria-pressed": on,
                    "aria-label": `${n.label}: ${money(n.value)}`,
                    onClick: () => onSelect(on ? null : n.category!),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(on ? null : n.category!);
                      }
                    },
                  }
                : {})}
            >
              {/* A hit area wider than the thin bar, covering its label too. */}
              <rect
                className="hit"
                x={isLeft ? colX(n) - 140 : colX(n) - 4}
                y={n.y + n.h / 2 - MIN_SLOT / 2}
                width={isLeft ? 140 + NODE_W + 4 : isRight ? 230 : NODE_W + 8}
                height={MIN_SLOT}
              />
              <rect className={`bar ${n.mid ?? ""}`} x={colX(n)} y={n.y} width={NODE_W} height={n.h} rx={2} />
              {(isLeft || isRight) && (
                <text x={lx} y={n.y + n.h / 2} dy="0.32em" textAnchor={isLeft ? "end" : "start"}>
                  <tspan className="flow-label">{n.label}</tspan>
                  <tspan className="flow-amount" dx={6}>
                    {moneyRound(n.value)}
                  </tspan>
                </text>
              )}
              {!isLeft && !isRight && (
                <text className="flow-mid" x={lx} y={n.y + n.h / 2} dy="0.32em">
                  {n.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="tooltip" style={{ left: hover.x, top: hover.y }} role="status">
          <div className="tip-title">{hover.text[0]}</div>
          <div className="tip-row">{hover.text[1]}</div>
        </div>
      )}
    </div>
  );
}
