import { useState, type FormEvent } from "react";
import { categoryLabel, SPENDING_CATEGORIES } from "../shared/categories";
import { describeSchedule, occurrenceDate, type Frequency } from "../shared/recurring";
import { changePassword, createRecurring, setDefaultSplit, updateRecurring } from "./api";
import { fmt, owedCents, parseDollars, payerSharePct, SHARE_ERROR, todayLocal } from "./ledger";
import type { Entry, Member, NewEntry, Recurring } from "./types";
import { ErrorText, MoneyInput, PasswordInput, Segmented } from "./ui";

/** Shared by the entry forms: `save` adds a new entry or edits `initial`, depending on the caller. */
interface EntryFormProps {
  me: Member;
  partner: Member;
  save: (entry: NewEntry) => Promise<unknown>;
  onSaved: () => void;
  /** Set when editing an existing entry. */
  initial?: Entry;
}

/** 33.333333 -> "33.33", 50 -> "50" */
export const pctText = (n: number) => String(Math.round(n * 100) / 100);
const dollarsText = (cents: number) => (cents / 100).toFixed(2);

function useSubmit(onSaved: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

function PayerToggle({
  value,
  onChange,
  partner,
}: {
  value: "me" | "partner";
  onChange: (v: "me" | "partner") => void;
  partner: Member;
}) {
  return (
    <div>
      <span className="label">Who paid?</span>
      <Segmented
        label="Who paid?"
        value={value}
        onChange={onChange}
        options={[
          { value: "me", label: "You" },
          { value: "partner", label: partner.display_name },
        ]}
      />
    </div>
  );
}

/** "Your share (%)" with quick picks: your usual split first (if it isn't 50/50), then the common ones. */
function ShareField({ me, value, onChange }: { me: Member; value: string; onChange: (v: string) => void }) {
  const usual = pctText(me.share_pct);
  const chips: [string, string][] = [
    ...(usual !== "50" ? ([[usual, `Usual (${usual}%)`]] as [string, string][]) : []),
    ["50", "Split evenly"],
    ["0", "All theirs"],
    ["100", "All mine"],
  ];
  return (
    <label>
      Your share (%)
      <input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="chips">
        {chips.map(([v, label]) => (
          <button key={v} type="button" className={value.trim() === v ? "chip on" : "chip"} onClick={() => onChange(v)}>
            {label}
          </button>
        ))}
      </span>
    </label>
  );
}

/** Optional spending category, used by the spending reports. */
function CategoryField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label>
      Category
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No category</option>
        {SPENDING_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {categoryLabel(c)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** "Sam will owe you $42.10" / "You will owe Sam $42.10" */
function OwedPreview({ owed, payer, partner, suffix = "" }: { owed: number | null; payer: "me" | "partner"; partner: Member; suffix?: string }) {
  if (owed === null) return null;
  return (
    <p className="preview">
      {payer === "me"
        ? `${partner.display_name} will owe you ${fmt(owed)}${suffix}`
        : `You will owe ${partner.display_name} ${fmt(owed)}${suffix}`}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Expense
// ---------------------------------------------------------------------------

export function AddExpenseForm({ me, partner, save, onSaved, initial }: EntryFormProps) {
  const initialPayer = initial ? (initial.payer_id === me.user_id ? "me" : "partner") : "me";
  // payer_share_pct is the payer's share; the field shows *your* share.
  const initialMyShare = initial
    ? pctText(initialPayer === "me" ? (initial.payer_share_pct ?? 50) : 100 - (initial.payer_share_pct ?? 50))
    : pctText(me.share_pct);

  const [amount, setAmount] = useState(initial ? dollarsText(initial.amount_cents) : "");
  const [name, setName] = useState(initial?.name ?? "");
  const [payer, setPayer] = useState<"me" | "partner">(initialPayer);
  const [myShare, setMyShare] = useState(initialMyShare);
  const [date, setDate] = useState(initial?.entry_date ?? todayLocal());
  const [category, setCategory] = useState(initial?.category ?? "");
  const { busy, error, setError, run } = useSubmit(onSaved);

  const cents = parseDollars(amount);
  const payerShare = payerSharePct(myShare, payer);
  const owed = cents !== null && payerShare !== null ? owedCents("expense", cents, payerShare) : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (cents === null) return setError("Enter an amount greater than zero.");
    if (!name.trim()) return setError("Give it a name, like groceries.");
    if (payerShare === null) return setError(SHARE_ERROR);
    void run(() =>
      save({
        kind: "expense",
        entry_date: date,
        name: name.trim(),
        amount_cents: cents,
        payer_id: payer === "me" ? me.user_id : partner.user_id,
        payer_share_pct: payerShare,
        category: category || null,
      }),
    );
  }

  return (
    <form onSubmit={submit} className="stack">
      <label>
        Amount
        <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus={!initial} />
      </label>
      <label>
        What for?
        <input
          placeholder="Groceries"
          value={name}
          maxLength={200}
          enterKeyHint="done"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <PayerToggle value={payer} onChange={setPayer} partner={partner} />
      <ShareField me={me} value={myShare} onChange={setMyShare} />
      <CategoryField value={category} onChange={setCategory} />
      <label>
        Date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>

      <OwedPreview owed={owed} payer={payer} partner={partner} />
      <ErrorText message={error} />
      <button className="primary" disabled={busy}>
        {busy ? "Saving…" : initial ? "Save changes" : "Add expense"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Settle up
// ---------------------------------------------------------------------------

export function SettleForm({ me, partner, balance, save, onSaved, initial }: EntryFormProps & { balance: number }) {
  const [amount, setAmount] = useState(
    initial ? dollarsText(initial.amount_cents) : balance === 0 ? "" : dollarsText(Math.abs(balance)),
  );
  // New payment: whoever owes money is the one who pays.
  const [payer, setPayer] = useState<"me" | "partner">(
    initial ? (initial.payer_id === me.user_id ? "me" : "partner") : balance > 0 ? "partner" : "me",
  );
  const [date, setDate] = useState(initial?.entry_date ?? todayLocal());
  const { busy, error, setError, run } = useSubmit(onSaved);
  const cents = parseDollars(amount);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (cents === null) return setError("Enter an amount greater than zero.");
    void run(() =>
      save({
        kind: "settlement",
        entry_date: date,
        name: initial?.name ?? "Settlement",
        amount_cents: cents,
        payer_id: payer === "me" ? me.user_id : partner.user_id,
        payer_share_pct: null,
      }),
    );
  }

  return (
    <form onSubmit={submit} className="stack">
      {!initial && (
        <p className="muted">
          Record a payment between the two of you. This only updates the ledger; it doesn't move money.
        </p>
      )}
      <PayerToggle value={payer} onChange={setPayer} partner={partner} />
      <label>
        Amount
        <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      {initial && (
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      )}
      <ErrorText message={error} />
      <button className="primary" disabled={busy}>
        {busy ? "Saving…" : initial ? "Save changes" : "Record payment"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Starting balance
// ---------------------------------------------------------------------------

export function OpeningForm({ me, partner, save, onSaved, initial }: EntryFormProps) {
  // payer_id on an opening row is the person who is OWED the money.
  const [who, setWho] = useState<"partner-owes" | "i-owe">(
    initial && initial.payer_id !== me.user_id ? "i-owe" : "partner-owes",
  );
  const [amount, setAmount] = useState(initial ? dollarsText(initial.amount_cents) : "");
  const { busy, error, setError, run } = useSubmit(onSaved);
  const cents = parseDollars(amount);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (cents === null) return setError("Enter an amount greater than zero.");
    void run(() =>
      save({
        kind: "opening",
        entry_date: initial?.entry_date ?? todayLocal(),
        name: "Starting balance",
        amount_cents: cents,
        payer_id: who === "partner-owes" ? me.user_id : partner.user_id,
        payer_share_pct: null,
      }),
    );
  }

  return (
    <form onSubmit={submit} className="stack">
      {!initial && <p className="muted">If one of you already owes the other, enter it here once.</p>}
      <Segmented
        label="Who owes whom?"
        value={who}
        onChange={setWho}
        options={[
          { value: "partner-owes", label: `${partner.display_name} owes me` },
          { value: "i-owe", label: `I owe ${partner.display_name}` },
        ]}
      />
      <label>
        Amount
        <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus={!initial} />
      </label>
      <ErrorText message={error} />
      <button className="primary" disabled={busy}>
        {busy ? "Saving…" : initial ? "Save changes" : "Save starting balance"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Recurring expense
// ---------------------------------------------------------------------------

const EVERY = { weekly: "week", monthly: "month", yearly: "year" } as const;
const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Create a recurring expense, or change one (`initial`). The schedule is fixed once created. */
export function RecurringForm({
  me,
  partner,
  initial,
  onSaved,
  onStop,
}: {
  me: Member;
  partner: Member;
  initial?: Recurring;
  onSaved: () => void;
  onStop?: () => void;
}) {
  const initialPayer = initial ? (initial.payer_id === me.user_id ? "me" : "partner") : "me";
  const [amount, setAmount] = useState(initial ? dollarsText(initial.amount_cents) : "");
  const [name, setName] = useState(initial?.name ?? "");
  const [payer, setPayer] = useState<"me" | "partner">(initialPayer);
  const [myShare, setMyShare] = useState(
    initial
      ? pctText(initialPayer === "me" ? initial.payer_share_pct : 100 - initial.payer_share_pct)
      : pctText(me.share_pct),
  );
  const [frequency, setFrequency] = useState<Frequency>(initial?.frequency ?? "monthly");
  const [start, setStart] = useState(initial?.start_date ?? todayLocal());
  const [paused, setPaused] = useState(initial?.paused ?? false);
  const [category, setCategory] = useState(initial?.category ?? "");
  const { busy, error, setError, run } = useSubmit(onSaved);

  const cents = parseDollars(amount);
  const payerShare = payerSharePct(myShare, payer);
  const owed = cents !== null && payerShare !== null ? owedCents("expense", cents, payerShare) : null;
  const today = todayLocal();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (cents === null) return setError("Enter an amount greater than zero.");
    if (!name.trim()) return setError("Give it a name, like rent.");
    if (payerShare === null) return setError(SHARE_ERROR);
    if (!initial && start < today) return setError("The first date can't be in the past.");
    const fields = {
      name: name.trim(),
      amount_cents: cents,
      payer_id: payer === "me" ? me.user_id : partner.user_id,
      payer_share_pct: payerShare,
      category: category || null,
    };
    void run(() =>
      initial ? updateRecurring(initial.id, { ...fields, paused }) : createRecurring({ ...fields, frequency, start_date: start }),
    );
  }

  return (
    <form onSubmit={submit} className="stack">
      <label>
        Amount
        <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus={!initial} />
      </label>
      <label>
        What for?
        <input placeholder="Rent" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </label>
      <PayerToggle value={payer} onChange={setPayer} partner={partner} />
      <ShareField me={me} value={myShare} onChange={setMyShare} />
      <CategoryField value={category} onChange={setCategory} />

      {initial ? (
        <>
          <p className="preview">
            {describeSchedule(initial.start_date, initial.frequency)}
            {paused ? " · paused" : ` · next on ${shortDate(initial.next_date)}`}
          </p>
          <label className="check">
            <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
            Paused (resuming starts again from the next date, without filling in the gap)
          </label>
        </>
      ) : (
        <>
          <div>
            <span className="label">Repeats</span>
            <Segmented
              label="Repeats"
              value={frequency}
              onChange={setFrequency}
              options={[
                { value: "weekly", label: "Weekly" },
                { value: "monthly", label: "Monthly" },
                { value: "yearly", label: "Yearly" },
              ]}
            />
          </div>
          <label>
            First date
            <input type="date" value={start} min={today} onChange={(e) => setStart(e.target.value)} />
          </label>
          {start >= today && (
            <p className="preview">
              {describeSchedule(start, frequency)}: {shortDate(start)}, then {shortDate(occurrenceDate(start, frequency, 1))}, and
              so on.
            </p>
          )}
        </>
      )}

      <OwedPreview owed={owed} payer={payer} partner={partner} suffix={` each ${EVERY[initial?.frequency ?? frequency]}`} />
      <p className="muted small">
        Each one is added to the ledger automatically when either of you opens the app on or after its date.
        {initial && " Changes apply from the next one; ones already added stay as they are."}
      </p>
      <ErrorText message={error} />
      <button className="primary" disabled={busy}>
        {busy ? "Saving…" : initial ? "Save changes" : "Add recurring expense"}
      </button>
      {initial && onStop && (
        <button type="button" className="danger-link" onClick={onStop} disabled={busy}>
          Stop this recurring expense
        </button>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Default split
// ---------------------------------------------------------------------------

export function DefaultSplitForm({ me, partner, onSaved }: { me: Member; partner: Member; onSaved: () => void }) {
  const [myShare, setMyShare] = useState(pctText(me.share_pct));
  const { busy, error, setError, run } = useSubmit(onSaved);
  const mine = payerSharePct(myShare, "me");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (mine === null) return setError(SHARE_ERROR);
    void run(() => setDefaultSplit(mine));
  }

  return (
    <form onSubmit={submit} className="stack">
      <p className="muted">
        The share you normally pay. New expenses and statement imports start with it, and you can still
        change it on any single expense. It's the same setting for both of you.
      </p>
      <label>
        Your share (%)
        <input inputMode="decimal" value={myShare} onChange={(e) => setMyShare(e.target.value)} autoFocus />
        <span className="chips">
          {["50", "60", "40"].map((v) => (
            <button key={v} type="button" className={myShare.trim() === v ? "chip on" : "chip"} onClick={() => setMyShare(v)}>
              {v === "50" ? "50/50" : `${v}/${100 - Number(v)}`}
            </button>
          ))}
        </span>
      </label>
      {mine !== null && (
        <p className="preview">
          You pay {pctText(mine)}%, {partner.display_name} pays {pctText(100 - mine)}%.
        </p>
      )}
      <ErrorText message={error} />
      <button className="primary" disabled={busy}>
        {busy ? "Saving…" : "Save default split"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------

export function ChangePasswordForm({ onSaved }: { onSaved: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const { busy, error, setError, run } = useSubmit(onSaved);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (next.length < 8) return setError("The new password must be at least 8 characters.");
    if (next === current) return setError("That's the same as your current password.");
    void run(() => changePassword(current, next));
  }

  return (
    <form onSubmit={submit} className="stack">
      <PasswordInput
        label="Current password"
        autoComplete="current-password"
        required
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <PasswordInput
        label="New password"
        autoComplete="new-password"
        required
        minLength={8}
        maxLength={200}
        hint="At least 8 characters. Your other devices will be signed out."
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <ErrorText message={error} />
      <button className="primary" disabled={busy}>
        {busy ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}
