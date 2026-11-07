import { useState, type FormEvent } from "react";
import { addEntry, changePassword } from "./api";
import { fmt, owedCents, parseDollars, payerSharePct, SHARE_ERROR, todayLocal } from "./ledger";
import type { Member } from "./types";
import { ErrorText, MoneyInput, PasswordInput, Segmented } from "./ui";

interface FormProps {
  householdId: string;
  me: Member;
  partner: Member;
  onSaved: () => void;
}

function useSubmit(onSaved: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
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

// ---------------------------------------------------------------------------
// Add expense
// ---------------------------------------------------------------------------

export function AddExpenseForm({ householdId, me, partner, onSaved }: FormProps) {
  const [amount, setAmount] = useState("");
  const [name, setName] = useState("");
  const [payer, setPayer] = useState<"me" | "partner">("me");
  const [myShare, setMyShare] = useState("50");
  const [date, setDate] = useState(todayLocal());
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
      addEntry({
        household_id: householdId,
        kind: "expense",
        entry_date: date,
        name: name.trim(),
        amount_cents: cents,
        payer_id: payer === "me" ? me.user_id : partner.user_id,
        payer_share_pct: payerShare,
        owed_cents: owedCents("expense", cents, payerShare),
      }),
    );
  }

  return (
    <form onSubmit={submit} className="stack">
      <label>
        Amount
        <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
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
      <div>
        <span className="label">Who paid?</span>
        <Segmented
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
        <input
          inputMode="decimal"
          value={myShare}
          onChange={(e) => setMyShare(e.target.value)}
        />
        <span className="chips">
          {["50", "0", "100"].map((v) => (
            <button
              key={v}
              type="button"
              className={myShare.trim() === v ? "chip on" : "chip"}
              onClick={() => setMyShare(v)}
            >
              {v === "50" ? "Split evenly" : v === "0" ? "All theirs" : "All mine"}
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
        {busy ? "Saving…" : "Add expense"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Settle up
// ---------------------------------------------------------------------------

export function SettleForm({
  householdId,
  me,
  partner,
  balance,
  onSaved,
}: FormProps & { balance: number }) {
  const [amount, setAmount] = useState(balance === 0 ? "" : (Math.abs(balance) / 100).toFixed(2));
  // Whoever owes money is the one who pays.
  const [payer, setPayer] = useState<"me" | "partner">(balance > 0 ? "partner" : "me");
  const { busy, error, setError, run } = useSubmit(onSaved);
  const cents = parseDollars(amount);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (cents === null) return setError("Enter an amount greater than zero.");
    void run(() =>
      addEntry({
        household_id: householdId,
        kind: "settlement",
        entry_date: todayLocal(),
        name: "Settlement",
        amount_cents: cents,
        payer_id: payer === "me" ? me.user_id : partner.user_id,
        payer_share_pct: null,
        owed_cents: cents,
      }),
    );
  }

  return (
    <form onSubmit={submit} className="stack">
      <p className="muted">
        Record a payment between the two of you. This only updates the ledger; it doesn't move money.
      </p>
      <div>
        <span className="label">Who paid?</span>
        <Segmented
          value={payer}
          onChange={setPayer}
          options={[
            { value: "me", label: "You" },
            { value: "partner", label: partner.display_name },
          ]}
        />
      </div>
      <label>
        Amount
        <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <ErrorText message={error} />
      <button className="primary" disabled={busy}>
        {busy ? "Saving…" : "Record payment"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Starting balance
// ---------------------------------------------------------------------------

export function OpeningForm({ householdId, me, partner, onSaved }: FormProps) {
  const [who, setWho] = useState<"partner-owes" | "i-owe">("partner-owes");
  const [amount, setAmount] = useState("");
  const { busy, error, setError, run } = useSubmit(onSaved);
  const cents = parseDollars(amount);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (cents === null) return setError("Enter an amount greater than zero.");
    // payer_id on an opening row is the person who is OWED the money.
    const creditor = who === "partner-owes" ? me.user_id : partner.user_id;
    void run(() =>
      addEntry({
        household_id: householdId,
        kind: "opening",
        entry_date: todayLocal(),
        name: "Starting balance",
        amount_cents: cents,
        payer_id: creditor,
        payer_share_pct: null,
        owed_cents: cents,
      }),
    );
  }

  return (
    <form onSubmit={submit} className="stack">
      <p className="muted">If one of you already owes the other, enter it here once.</p>
      <Segmented
        value={who}
        onChange={setWho}
        options={[
          { value: "partner-owes", label: `${partner.display_name} owes me` },
          { value: "i-owe", label: `I owe ${partner.display_name}` },
        ]}
      />
      <label>
        Amount
        <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      </label>
      <ErrorText message={error} />
      <button className="primary" disabled={busy}>
        {busy ? "Saving…" : "Save starting balance"}
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
