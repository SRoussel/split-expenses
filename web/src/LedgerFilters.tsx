import { useState } from "react";
import { categoryLabel, SPENDING_CATEGORIES } from "../shared/categories";
import { activeFilterCount, fmt, isFiltering, NO_FILTER, type EntryFilter } from "./ledger";
import { Segmented } from "./ui";

/** Search box and filters above the ledger. The filters fold away so the list stays the focus. */
export default function LedgerFilters({
  filter,
  onChange,
  partnerName,
  totals,
}: {
  filter: EntryFilter;
  onChange: (f: EntryFilter) => void;
  partnerName: string;
  /** Totals of what matches; shown only while searching or filtering. */
  totals: { count: number; spent: number; mine: number };
}) {
  const [open, setOpen] = useState(false);
  const set = <K extends keyof EntryFilter>(key: K, value: EntryFilter[K]) => onChange({ ...filter, [key]: value });
  const count = activeFilterCount(filter);

  return (
    <section className="ledger-filters" aria-label="Search and filter entries">
      <div className="search-row">
        <input
          type="search"
          value={filter.text}
          onChange={(e) => set("text", e.target.value)}
          placeholder="Search"
          aria-label="Search entries by name, category or amount"
          enterKeyHint="search"
        />
        <button
          type="button"
          className={`filters-btn${count ? " on" : ""}`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Filters{count ? ` · ${count}` : ""}
        </button>
      </div>

      {filter.only && (
        <p className="filter-only">
          <span>
            From Spending: <strong>{filter.only.label}</strong>
            {filter.only.note && <span className="hint">{filter.only.note}</span>}
          </span>
          <button
            type="button"
            className="link"
            aria-label={`Stop showing only ${filter.only.label}`}
            onClick={() => set("only", null)}
          >
            Show all
          </button>
        </p>
      )}

      {open && (
        <div className="filters stack">
          <div>
            <span className="label">Type</span>
            <Segmented
              label="Type"
              value={filter.kind}
              onChange={(v) => set("kind", v)}
              options={[
                { value: "all", label: "All" },
                { value: "expense", label: "Expenses" },
                { value: "settlement", label: "Payments" },
              ]}
            />
          </div>
          <div>
            <span className="label">Paid by</span>
            <Segmented
              label="Paid by"
              value={filter.payer}
              onChange={(v) => set("payer", v)}
              options={[
                { value: "all", label: "Anyone" },
                { value: "me", label: "You" },
                { value: "partner", label: partnerName },
              ]}
            />
          </div>
          <label>
            Category
            <select value={filter.category} onChange={(e) => set("category", e.target.value)}>
              <option value="">Any category</option>
              {SPENDING_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
              <option value="none">No category</option>
            </select>
            <span className="hint">Imported statements are split across categories; see the Spending tab.</span>
          </label>
          <div className="date-pair">
            <label>
              From
              <input
                type="date"
                value={filter.from}
                max={filter.to || undefined}
                onChange={(e) => set("from", e.target.value)}
              />
            </label>
            <label>
              To
              <input
                type="date"
                value={filter.to}
                min={filter.from || undefined}
                onChange={(e) => set("to", e.target.value)}
              />
            </label>
          </div>
        </div>
      )}

      {isFiltering(filter) && (
        <p className="filter-result" role="status">
          <span>
            {totals.count} {totals.count === 1 ? "entry" : "entries"}
            {totals.spent > 0 && (
              <>
                {" "}
                ·{" "}
                <span className="nowrap">
                  <strong>{fmt(totals.spent)}</strong> spent
                </span>{" "}
                ·{" "}
                <span className="nowrap">
                  your share <strong>{fmt(totals.mine)}</strong>
                </span>
              </>
            )}
          </span>
          <button type="button" className="link" onClick={() => onChange(NO_FILTER)}>
            Clear
          </button>
        </p>
      )}
    </section>
  );
}
