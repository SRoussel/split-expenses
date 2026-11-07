import { useState, type FormEvent } from "react";
import { createHousehold, joinHousehold, signOut } from "./api";
import { ErrorText, Segmented } from "./ui";

/** Shown once, after the first sign-in: start a ledger or join your partner's. */
export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"start" | "join">("start");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Enter the name you want your partner to see.");
    if (mode === "join" && !code.trim()) return setError("Paste the invite code your partner sent you.");
    setBusy(true);
    setError(null);
    try {
      // Codes are lowercase hex; tolerate spaces and capitals from copy-paste or autocorrect.
      await (mode === "start" ? createHousehold(name) : joinHousehold(code.replace(/\s/g, ""), name));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <div className="brand">
        <img src="/icon-192.png?v=2" alt="" width={56} height={56} />
        <h1>Welcome to Split</h1>
        <p className="muted">One of you starts the ledger, the other joins it with an invite code.</p>
      </div>

      <form className="card stack" onSubmit={submit}>
        <label>
          Your name
          <input
            value={name}
            maxLength={60}
            placeholder="What your partner will see"
            onChange={(e) => setName(e.target.value)}
            autoComplete="given-name"
            enterKeyHint="next"
          />
        </label>

        <Segmented
          label="Start a new ledger or join your partner's"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError(null);
          }}
          options={[
            { value: "start", label: "Start new" },
            { value: "join", label: "Join partner's" },
          ]}
        />

        {mode === "start" ? (
          <p className="preview">
            You'll get an invite code to send your partner. Once they join, you can both add expenses.
          </p>
        ) : (
          <label>
            Invite code
            <input
              className="mono"
              value={code}
              maxLength={40}
              placeholder="e.g. 3f9a0c21d4e8b7a6"
              onChange={(e) => setCode(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
            />
          </label>
        )}

        <ErrorText message={error} />
        <button className="primary" disabled={busy}>
          {busy ? "One moment…" : mode === "start" ? "Start ledger" : "Join ledger"}
        </button>
      </form>

      <p className="center">
        <button
          className="link small"
          onClick={() =>
            void signOut()
              .catch(() => undefined)
              .then(onDone)
          }
        >
          Wrong account? Sign out
        </button>
      </p>
    </main>
  );
}
