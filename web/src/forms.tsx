import { useState, type FormEvent } from "react";
import { changePassword, setDefaultSplit } from "./api";
import { fmt, owedCents, parseDollars, payerSharePct, SHARE_ERROR, todayLocal } from "./ledger";
import type { Entry, Member, NewEntry } from "./types";
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
  const { busy, error, setError, run } = useSubmit(onSaved);

  const cents = parseDollars(amount);
  const payerShare = payerSharePct(myShare, payer);
  const owed = cents !== null && payerShare !== null ? owedCents("expense", cents, payerShare) : null;

  // Quick picks: your usual split first (if it isn't 50/50), then the common ones.
  const usual = pctText(me.share_pct);
  const chips: [string, string][] = [
    ...(usual !== "50" ? ([[usual, `Usual (${usual}%)`]] as [string, string][]) : []),
    ["50", "Split evenly"],
    ["0", "All theirs"],
    ["100", "All mine"],
  ];

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
      <label>
        Your share (%)
        <input inputMode="decimal" value={myShare} onChange={(e) => setMyShare(e.target.value)} />
        <span className="chips">
          {chips.map(([v, label]) => (
            <button
              key={v}
              type="button"
              className={myShare.trim() === v ? "chip on" : "chip"}
              onClick={() => setMyShare(v)}
            >
              {label}
            </button>
          ))}
        </span>
      </label>
      <label>
        Date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>

      {owed !== null && (
        <p className="preview">
          {payer === "me"
            ? `${partner.display_name} will owe you ${fmt(owed)}`
            : `You will owe ${partner.display_name} ${fmt(owed)}`}
        </p>
      )}
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
