import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  addPasskey,
  ApiError,
  confirmWithPasskey,
  confirmWithPassword,
  disablePassword,
  enablePassword,
  getAccount,
  needsConfirm,
  passkeysSupported,
  removePasskey,
  revokeDesktopKey,
  type DesktopKey,
  type Passkey,
} from "./api";
import { ConfirmDialog, ErrorText, PasswordInput } from "./ui";

const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
// The server stores UTC as "YYYY-MM-DD HH:MM:SS".
const day = (sqlTime: string) => dayFmt.format(new Date(`${sqlTime.replace(" ", "T")}Z`));
const isCancel = (err: unknown) => err instanceof ApiError && err.code === "cancelled";

type Account = { passwordEnabled: boolean; passkeys: Passkey[]; desktopKeys: DesktopKey[] };

/**
 * More > Sign-in: passkeys and password sign-in. Changes here need a recent sign-in or
 * confirmation; when the server asks for one, this shows a "Confirm it's you" step and
 * then finishes what you asked for.
 */
export default function SignInSettings({ onMessage }: { onMessage: (message: string) => void }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What to do once you've confirmed it's you.
  const [pending, setPending] = useState<{ run: () => Promise<void>; done: string } | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<Passkey | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<DesktopKey | null>(null);
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [settingPassword, setSettingPassword] = useState(false);
  const supported = passkeysSupported();

  const load = useCallback(async () => {
    try {
      setAccount(await getAccount());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load your sign-in settings.");
    }
  }, []);
  useEffect(() => void load(), [load]);

  /** Runs a change; if the server wants a confirmation first, asks for it and then retries. */
  async function change(run: () => Promise<void>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await run();
      onMessage(done);
      await load();
    } catch (err) {
      if (needsConfirm(err)) setPending({ run, done });
      else if (!isCancel(err)) setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (!account) {
    return error ? <ErrorText message={error} /> : <p className="muted">Loading…</p>;
  }

  if (pending) {
    return (
      <ConfirmIdentity
        account={account}
        onConfirmed={() => {
          const { run, done } = pending;
          setPending(null);
          void change(run, done);
        }}
        onCancel={() => setPending(null)}
      />
    );
  }

  if (settingPassword) {
    return (
      <NewPasswordForm
        onCancel={() => setSettingPassword(false)}
        onSubmit={(next) => {
          setSettingPassword(false);
          void change(() => enablePassword(next), "Password sign-in is back on");
        }}
      />
    );
  }

  const { passkeys, passwordEnabled, desktopKeys } = account;
  return (
    <div className="stack">
      <p className="muted small">
        A passkey lets you sign in with Face ID or Touch ID instead of a password. Your device keeps the key; the app
        only stores a public half that can check a sign-in but never make one.
      </p>

      <h2 className="section-label">Passkeys</h2>
      {passkeys.length === 0 ? (
        <p className="muted small">None yet.</p>
      ) : (
        <ul className="plain passkey-list">
          {passkeys.map((p) => (
            <li key={p.id} className="row">
              <span>
                <strong>{p.name}</strong>
                <br />
                <span className="muted small">
                  Added {day(p.created_at)}
                  {p.last_used_at ? ` · last used ${day(p.last_used_at)}` : " · not used yet"}
                </span>
              </span>
              <button className="link" disabled={busy} onClick={() => setConfirmingRemove(p)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {supported ? (
        <button disabled={busy} onClick={() => void change(addPasskey, "Passkey added")}>
          {busy ? "One moment…" : passkeys.length ? "Add another passkey" : "Add a passkey"}
        </button>
      ) : (
        <p className="notice small">This browser can't make passkeys. Try Safari on your iPhone.</p>
      )}
      <ErrorText message={error} />

      <h2 className="section-label">Password</h2>
      {passwordEnabled ? (
        <>
          <p className="muted small">
            Password sign-in is on. Once your passkey works, turning it off means there's no password left to guess,
            phish or leak.
          </p>
          <button disabled={busy || passkeys.length === 0} onClick={() => setConfirmingDisable(true)}>
            Turn off password sign-in
          </button>
          {passkeys.length === 0 && <p className="muted small">Add a passkey first, so you can still sign in.</p>}
        </>
      ) : (
        <>
          <p className="muted small">
            Password sign-in is off: only your passkeys can sign you in. If you ever lose them all, whoever set up the
            app can turn it back on with <code>npm run reset-password</code>.
          </p>
          <button disabled={busy} onClick={() => setSettingPassword(true)}>
            Turn password sign-in back on
          </button>
        </>
      )}

      {desktopKeys.length > 0 && (
        <>
          <h2 className="section-label">Desktop app</h2>
          <p className="muted small">
            These let the desktop app on your computer send statement summaries here. They can only add and replace
            statement uploads. If you lose that computer, revoke its key.
          </p>
          <ul className="plain passkey-list">
            {desktopKeys.map((k) => (
              <li key={k.id} className="row">
                <span>
                  <strong>{k.name}</strong>
                  <br />
                  <span className="muted small">
                    Added {day(k.created_at)}
                    {k.last_used_at ? ` · last used ${day(k.last_used_at)}` : " · not used yet"} · expires{" "}
                    {day(k.expires_at)}
                  </span>
                </span>
                <button className="link" disabled={busy} onClick={() => setConfirmingRevoke(k)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {confirmingRevoke && (
        <ConfirmDialog
          title="Revoke desktop key?"
          message={`"${confirmingRevoke.name}" stops working right away. Make a new one on the computer with npm run desktop-key.`}
          confirmLabel="Revoke"
          danger
          onConfirm={async () => {
            const id = confirmingRevoke.id;
            await change(() => revokeDesktopKey(id), "Desktop key revoked");
          }}
          onClose={() => setConfirmingRevoke(null)}
        />
      )}
      {confirmingRemove && (
        <ConfirmDialog
          title="Remove passkey?"
          message={`"${confirmingRemove.name}" won't be able to sign in any more. You can add it again later.`}
          confirmLabel="Remove"
          danger
          onConfirm={async () => {
            const id = confirmingRemove.id;
            await change(() => removePasskey(id), "Passkey removed");
          }}
          onClose={() => setConfirmingRemove(null)}
        />
      )}
      {confirmingDisable && (
        <ConfirmDialog
          title="Turn off password sign-in?"
          message="From now on only your passkeys can sign you in. Your current password stops working right away."
          confirmLabel="Turn off"
          onConfirm={() => change(disablePassword, "Password sign-in is off")}
          onClose={() => setConfirmingDisable(false)}
        />
      )}
    </div>
  );
}

/** "Confirm it's you": a passkey if you have one, the password if it's on. */
function ConfirmIdentity({
  account,
  onConfirmed,
  onCancel,
}: {
  account: Account;
  onConfirmed: () => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function attempt(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      onConfirmed();
    } catch (err) {
      if (!isCancel(err)) setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p>
        <strong>Confirm it's you</strong>
        <br />
        <span className="muted small">
          Changes to how you sign in need a fresh confirmation, in case someone else has your phone open.
        </span>
      </p>
      {account.passkeys.length > 0 && passkeysSupported() && (
        <button className="primary" disabled={busy} onClick={() => void attempt(confirmWithPasskey)}>
          Confirm with passkey
        </button>
      )}
      {account.passwordEnabled && (
        <form
          className="stack"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void attempt(() => confirmWithPassword(password));
          }}
        >
          <PasswordInput
            id="confirm-password"
            label="Your password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button disabled={busy || !password}>{busy ? "One moment…" : "Confirm with password"}</button>
        </form>
      )}
      <ErrorText message={error} />
      <button className="link" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function NewPasswordForm({ onSubmit, onCancel }: { onSubmit: (next: string) => void; onCancel: () => void }) {
  const [next, setNext] = useState("");
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(next);
      }}
    >
      <p className="muted small">Choose a new password. Your passkeys keep working too.</p>
      <PasswordInput
        id="new-password"
        label="New password"
        autoComplete="new-password"
        required
        minLength={8}
        maxLength={200}
        hint="At least 8 characters."
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <button className="primary" disabled={next.length < 8}>
        Turn password sign-in back on
      </button>
      <button type="button" className="link" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
