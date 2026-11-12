import { useState, type ChangeEvent } from "react";
import { categoryLabel, INCOME_CATEGORY } from "../shared/categories";
import { importStatement } from "./api";
import { pctText } from "./forms";
import {
  fmt,
  MAX_SUMMARY_BYTES,
  owedCents,
  parseSummary,
  payerSharePct,
  SHARE_ERROR,
  summaryToImport,
  totalsByCategory,
  type ImportSummary as Summary,
} from "./ledger";
import type { Entry, Member } from "./types";
import { ErrorText, Segmented } from "./ui";

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

function CategoryList({ totals }: { totals: Record<string, number> }) {
  return (
    <ul className="plain">
      {Object.entries(totals)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cat, cents]) => (
          <li key={cat} className="row">
            <span>{categoryLabel(cat)}</span>
            <span className={cents < 0 ? "pos" : ""}>{cents < 0 ? `−${fmt(cents)}` : fmt(cents)}</span>
          </li>
        ))}
    </ul>
  );
}

/**
 * Imports a statement from the split_summary.json made on your computer by
 * `uv run split-ledger summarize`. The detailed transaction files are refused,
 * so individual purchases never reach the app; only totals per month and
 * category are saved.
 */
export default function ImportSummary({
  me,
  partner,
  entries,
  onSaved,
}: {
  me: Member;
  partner: Member;
  entries: Entry[];
  onSaved: () => void;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [name, setName] = useState("");
  const [owner, setOwner] = useState<"me" | "partner">("me");
  const [payer, setPayer] = useState<"me" | "partner">("me");
  const [myShare, setMyShare] = useState(pctText(me.share_pct));
  const [includeShared, setIncludeShared] = useState(true);
  const [includePersonal, setIncludePersonal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ownerName = owner === "me" ? "Your" : `${partner.display_name}'s`;

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // so choosing the same file again still triggers
    if (!file) return;
    setError(null);
    setSummary(null);
    try {
      // A summary is tiny; a big file is almost certainly a detailed one.
      if (file.size > MAX_SUMMARY_BYTES) {
        throw new Error(
          "That file is too big to be a statement summary. Run `uv run split-ledger summarize` and choose the split_summary.json it makes.",
        );
      }
      const s = parseSummary(await file.text());
      setSummary(s);
      setName(s.name);
      setIncludeShared(Boolean(s.shared));
      setIncludePersonal(Boolean(s.personal));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file.");
    }
  }

  function chooseOwner(o: "me" | "partner") {
    setOwner(o);
    setPayer(o); // whoever's statement it is paid the shared part, unless changed
  }

  const payerShare = payerSharePct(myShare, payer);
  const doShared = Boolean(summary?.shared && includeShared);
  const doPersonal = Boolean(summary?.personal && includePersonal);
  const duplicate = doShared && entries.some((e) => !e.voided_at && e.name === name.trim());
  const owed =
    summary?.shared && payerShare !== null ? owedCents("expense", summary.shared.totalCents, payerShare) : null;

  const personalTotals = summary?.personal ? totalsByCategory(summary.personal.months) : null;
  const income = personalTotals?.[INCOME_CATEGORY] ?? 0;
  const spendingOnly = personalTotals
    ? Object.fromEntries(Object.entries(personalTotals).filter(([c]) => c !== INCOME_CATEGORY))
    : {};
  const spent = Object.values(spendingOnly).reduce((a, b) => a + b, 0);

  async function save() {
    if (!summary) return;
    if (!name.trim()) return setError("Give the import a name.");
    if (!doShared && !doPersonal) return setError("Choose at least one part to import.");
    if (doShared && payerShare === null) return setError(SHARE_ERROR);
    if (duplicate) return setError("There's already an entry with that name. Change the name to add it anyway.");
    setBusy(true);
    setError(null);
    try {
      const person = owner === "me" ? me.user_id : partner.user_id;
      await importStatement(
        summaryToImport(summary, {
          name: name.trim(),
          shared: doShared
            ? { payerId: payer === "me" ? me.user_id : partner.user_id, payerSharePct: payerShare! }
            : null,
          personId: doPersonal ? person : null,
        }),
      );
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="muted">
        On your computer, run <code>uv run split-ledger summarize</code> (add <code>--person name</code> for the other
        person's files), then choose the <code>split_summary.json</code> it makes. Individual transactions stay on your
        computer.
      </p>
      <input type="file" accept=".json,application/json" onChange={onFile} />
      <ErrorText message={error} />

      {summary && (
        <>
          <div>
            <span className="label">Whose statement is this?</span>
            <Segmented
              label="Whose statement is this?"
              value={owner}
              onChange={chooseOwner}
              options={[
                { value: "me", label: "Mine" },
                { value: "partner", label: `${partner.display_name}'s` },
              ]}
            />
          </div>
          <p className="muted small">
            {summary.name} · {shortDate(summary.start)} – {shortDate(summary.end)}
          </p>

          {summary.shared && (
            <div className="card stack">
              <label className="check">
                <input type="checkbox" checked={includeShared} onChange={(e) => setIncludeShared(e.target.checked)} />
                <strong>Shared expenses: {fmt(summary.shared.totalCents)}</strong>
              </label>
              {includeShared && (
                <>
                  <CategoryList totals={totalsByCategory(summary.shared.months)} />
                  <div>
                    <span className="label">Who paid?</span>
                    <Segmented
                      label="Who paid?"
                      value={payer}
                      onChange={setPayer}
                      options={[
                        { value: "me", label: "You" },
                        { value: "partner", label: partner.display_name },
                      ]}
                    />
                  </div>
                  <label>
                    Your share (%)
                    <input inputMode="decimal" value={myShare} onChange={(e) => setMyShare(e.target.value)} />
                  </label>
                  {owed !== null && (
                    <p className="preview">
                      {payer === "me"
                        ? `${partner.display_name} will owe you ${fmt(owed)}`
                        : `You will owe ${partner.display_name} ${fmt(owed)}`}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {summary.personal && personalTotals && (
            <div className="card stack">
              <label className="check">
                <input
                  type="checkbox"
                  checked={includePersonal}
                  onChange={(e) => setIncludePersonal(e.target.checked)}
                />
                <strong>{ownerName} own spending and income</strong>
              </label>
              {includePersonal && (
                <>
                  <ul className="plain">
                    <li className="row">
                      <span>Money in</span>
                      <span className="pos">{fmt(income)}</span>
                    </li>
                    <li className="row">
                      <span>Spent</span>
                      <span>{fmt(spent)}</span>
                    </li>
                  </ul>
                  <CategoryList totals={spendingOnly} />
                  <span className="muted small">Saved as monthly totals by category, visible to both of you.</span>
                </>
              )}
            </div>
          )}

          {summary.netWorth && (
            <p className="muted small">
              Also brings your net worth at the end of{" "}
              {new Date(`${summary.netWorth.month}-01T00:00:00Z`).toLocaleDateString(undefined, {
                month: "long",
                year: "numeric",
                timeZone: "UTC",
              })}
              , {summary.netWorth.cents < 0 ? "−" : ""}
              {fmt(summary.netWorth.cents)}, for Home: just the total, not your accounts.
            </p>
          )}
          {summary.budgets && (
            <p className="muted small">
              {Object.keys(summary.budgets).length
                ? `Also brings the ${Object.keys(summary.budgets).length} monthly budgets from the desktop page, replacing the ones here.`
                : "Also clears the monthly budgets here: the desktop page has none."}
            </p>
          )}

          <label>
            Name
            <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </label>
          {duplicate && (
            <p className="notice">
              There's already an entry with this name, so this statement may have been imported before. Change the name
              to add it anyway.
            </p>
          )}
          <button className="primary" disabled={busy || duplicate} onClick={() => void save()}>
            {busy ? "Saving…" : "Import"}
          </button>
        </>
      )}
    </div>
  );
}
