import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  cancelPasskeyRequest,
  markPasskeyOffer,
  passkeyAutofillSupported,
  passkeySignIn,
  passkeysSupported,
  signIn,
  signUp,
} from "./api";
import { ErrorText, PasswordInput, Segmented } from "./ui";

export default function AuthScreen({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canPasskey = passkeysSupported();

  // On the sign-in tab, iOS can offer your passkey right in the email field's suggestions.
  // That request waits quietly in the background until you pick it (or leave this screen).
  useEffect(() => {
    if (mode !== "signin" || !canPasskey) return;
    let live = true;
    void passkeyAutofillSupported().then((ok) => {
      if (!ok || !live) return;
      passkeySignIn(true).then(
        () => live && onDone(),
        (err) => live && !(err instanceof ApiError && err.code === "cancelled") && setError(err.message),
      );
    });
    return () => {
      live = false;
      cancelPasskeyRequest();
    };
  }, [mode, canPasskey, onDone]);

  async function withPasskey() {
    setBusy(true);
    setError(null);
    try {
      await passkeySignIn();
      onDone();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "cancelled")) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await (mode === "signin" ? signIn(email, password) : signUp(email, password));
      if (canPasskey) markPasskeyOffer();
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
        <img src="/icon-192.png" alt="" width={56} height={56} />
        <h1>Split</h1>
        <p className="muted">Shared expenses: who owes who.</p>
      </div>

      <div className="card stack">
        <Segmented
          label="Sign in or create an account"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError(null);
          }}
          options={[
            { value: "signin", label: "Sign in" },
            { value: "signup", label: "Create account" },
          ]}
        />

        {mode === "signin" && canPasskey && (
          <>
            <button type="button" className="primary" disabled={busy} onClick={() => void withPasskey()}>
              Sign in with passkey
            </button>
            <p className="or" aria-hidden="true">
              or with your password
            </p>
          </>
        )}

        <form onSubmit={submit} className="stack">
          <label>
            Email
            <input
              type="email"
              name="email"
              inputMode="email"
              // "webauthn" lets iOS suggest your passkey here, next to saved emails.
              autoComplete={mode === "signin" ? "username webauthn" : "email"}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <PasswordInput
            label="Password"
            name="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            required
            minLength={8}
            maxLength={200}
            hint={mode === "signup" ? "At least 8 characters." : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <ErrorText message={error} />
          <button className={mode === "signin" && canPasskey ? "" : "primary"} disabled={busy}>
            {busy ? "One moment…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>
      </div>

      {mode === "signin" && (
        <p className="muted small center">
          Forgot your password? Whoever set up the app can reset it with <code>npm run reset-password</code>.
        </p>
      )}
    </main>
  );
}
