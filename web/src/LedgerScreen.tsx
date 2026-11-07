import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadHousehold, signOut, voidEntry } from "./api";
import { AddExpenseForm, ChangePasswordForm, OpeningForm, SettleForm } from "./forms";
import ImportCsv from "./ImportCsv";
import { balanceFor, effectFor, exportLedgerCsv, fmt } from "./ledger";
import type { Entry, Member } from "./types";
import { ConfirmDialog, ErrorText, Modal, Toast } from "./ui";

type Panel = null | "add" | "settle" | "opening" | "import" | "more" | "password";

// Entry dates are plain calendar days, so format them in UTC to avoid shifting a day.
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

export default function LedgerScreen({
  userId,
  email,
  householdId,
  onSignedOut,
}: {
  userId: string;
  email: string;
  householdId: string;
  onSignedOut: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [inviteCode, setInviteCode] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [voiding, setVoiding] = useState<Entry | null>(null);
  const [showVoided, setShowVoided] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);
  const closePanel = useCallback(() => setPanel(null), []);

  // Each refresh gets a number; only the newest one is allowed to update the screen,
  // so a slow older response can't overwrite a newer one.
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latestLoad.current;
    try {
      const data = await loadHousehold();
      if (mine !== latestLoad.current) return;
      setMembers(data.members);
      setEntries(data.entries);
      setInviteCode(data.inviteCode);
      setError(null);
    } catch (err) {
      if (mine !== latestLoad.current) return;
      setError(err instanceof Error ? err.message : "Couldn't load the ledger.");
    } finally {
      if (mine === latestLoad.current) setLoaded(true);
    }
  }, []);

  // Initial load, then keep fresh: refetch every 15 seconds while the app is open
  // and whenever it comes back to the foreground (iOS freezes background apps).
  useEffect(() => {
    void load();

    const refreshIfVisible = () => document.visibilityState === "visible" && void load();
    const timer = setInterval(refreshIfVisible, 15_000);
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("online", refreshIfVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("online", refreshIfVisible);
    };
  }, [load]);

  const me = members.find((m) => m.user_id === userId);
  const partner = members.find((m) => m.user_id !== userId);
  const partnerName = partner?.display_name ?? "Your partner";
  const names = useMemo(() => {
    const map = new Map<string, string>();
    members.forEach((m) => map.set(m.user_id, m.user_id === userId ? "You" : m.display_name));
    return map;
  }, [members, userId]);

  const balance = balanceFor(entries, userId);
  const hasOpening = entries.some((e) => e.kind === "opening" && !e.voided_at);
  const ready = Boolean(me && partner);

  // Entries arrive newest first; group them under month headings.
  const months = useMemo(() => {
    const visible = showVoided ? entries : entries.filter((e) => !e.voided_at);
    const groups: { key: string; label: string; items: Entry[] }[] = [];
    for (const e of visible) {
      const key = e.entry_date.slice(0, 7);
      if (groups.at(-1)?.key !== key) groups.push({ key, label: monthFmt.format(asDate(e.entry_date)), items: [] });
      groups.at(-1)!.items.push(e);
    }
    return groups;
  }, [entries, showVoided]);

  function saved(message: string) {
    setPanel(null);
    setToast(message);
    void load();
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard can be blocked; the code is on screen anyway */
    }
  }

  async function exportCsv() {
    const csv = exportLedgerCsv(entries, userId);
    const file = new File([csv], "ledger.csv", { type: "text/csv" });
    // On iPhone the share sheet is the reliable way to save a file from a home-screen app.
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "ledger.csv" });
        return;
      } catch (err) {
        // Cancelling the share sheet is not a failure: don't start a second, unwanted download.
        if (err instanceof DOMException && err.name === "AbortError") return;
        /* share isn't usable here; fall through to a normal download */
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ledger.csv";
    a.click();
    // Give the browser a moment to start the download before releasing the file.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  if (!loaded) {
    return (
      <main className="narrow">
        <p className="muted center">Loading…</p>
      </main>
    );
  }

  const tone = balance > 0 ? "pos" : balance < 0 ? "neg" : "even";

  return (
    <main className="with-bar">
      <header className="top">
        <h1>Split</h1>
        <button className="link" onClick={() => setPanel("more")}>
          More
        </button>
      </header>

      <ErrorText message={error} />

      {!partner && (
        <section className="card stack">
          <strong>Waiting for your partner</strong>
          <p className="muted">
            Have them create an account, choose "Join partner's", and enter this code:
          </p>
          <div className="row">
            <code className="code">{inviteCode}</code>
            <button className="link" onClick={() => void copyCode()}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </section>
      )}

      <section className={`balance ${tone}`} aria-live="polite">
        <span className="balance-label">
          {balance > 0 ? `${partnerName} owes you` : balance < 0 ? `You owe ${partnerName}` : "All settled up"}
        </span>
        <strong className="balance-amount">{fmt(balance)}</strong>
      </section>

      {months.length === 0 ? (
        <div className="empty">
          <p>No entries yet.</p>
          <p className="muted small">
            {ready ? "Add your first expense with the button below." : "Once your partner joins, you can add expenses."}
          </p>
        </div>
      ) : (
        months.map((m) => (
          <section key={m.key} className="month">
            <h2 className="month-label">{m.label}</h2>
            <ul className="entries">
              {m.items.map((e) => (
                <EntryRow
                  key={e.id}
                  entry={e}
                  userId={userId}
                  who={names.get(e.payer_id) ?? "Someone"}
                  onVoid={() => setVoiding(e)}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      <div className="bar">
        <div className="bar-inner">
          <button disabled={!ready || balance === 0} onClick={() => setPanel("settle")}>
            Settle up
          </button>
          <button className="primary" disabled={!ready} onClick={() => setPanel("add")}>
            Add expense
          </button>
        </div>
      </div>

      <Toast message={toast} onDone={clearToast} />

      {voiding && (
        <ConfirmDialog
          title="Void this entry?"
          message={
            <>
              <strong>{voiding.name}</strong> ({fmt(voiding.amount_cents)}) stays in the history but stops
              counting toward the balance. This can't be undone, but you can add it again.
            </>
          }
          confirmLabel="Void entry"
          danger
          onConfirm={async () => {
            await voidEntry(voiding.id);
            setToast("Entry voided");
            void load();
          }}
          onClose={() => setVoiding(null)}
        />
      )}

      {panel === "add" && me && partner && (
        <Modal title="Add expense" onClose={closePanel}>
          <AddExpenseForm householdId={householdId} me={me} partner={partner} onSaved={() => saved("Expense added")} />
        </Modal>
      )}

      {panel === "settle" && me && partner && (
        <Modal title="Settle up" onClose={closePanel}>
          <SettleForm
            householdId={householdId}
            me={me}
            partner={partner}
            balance={balance}
            onSaved={() => saved("Payment recorded")}
          />
        </Modal>
      )}

      {panel === "opening" && me && partner && (
        <Modal title="Starting balance" onClose={closePanel}>
          <OpeningForm
            householdId={householdId}
            me={me}
            partner={partner}
            onSaved={() => saved("Starting balance saved")}
          />
        </Modal>
      )}

      {panel === "import" && me && partner && (
        <Modal title="Import statement total" onClose={closePanel}>
          <ImportCsv
            householdId={householdId}
            me={me}
            partner={partner}
            entries={entries}
            onSaved={() => saved("Statement imported")}
          />
        </Modal>
      )}

      {panel === "password" && (
        <Modal title="Change password" onClose={closePanel}>
          <ChangePasswordForm onSaved={() => saved("Password changed")} />
        </Modal>
      )}

      {panel === "more" && (
        <Modal title="More" onClose={closePanel}>
          <div className="stack">
            <div className="menu">
              <button disabled={!ready} onClick={() => setPanel("import")}>
                Import statement total (CSV)
              </button>
              <button disabled={!ready || hasOpening} onClick={() => setPanel("opening")}>
                {hasOpening ? "Starting balance already set" : "Set starting balance"}
              </button>
              <button onClick={() => void exportCsv()} disabled={entries.length === 0}>
                Export ledger as CSV
              </button>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={showVoided}
                onChange={(e) => setShowVoided(e.target.checked)}
              />
              Show voided entries
            </label>

            <h2 className="section-label">Account</h2>
            <p className="muted small">
              Signed in as {email}
              {partner && (
                <>
                  <br />
                  Invite code: <code>{inviteCode}</code>
                </>
              )}
            </p>
            <div className="menu">
              <button onClick={() => setPanel("password")}>Change password</button>
              <button
                onClick={() =>
                  void signOut()
                    .catch(() => undefined)
                    .then(onSignedOut)
                }
              >
                Sign out
              </button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}

function EntryRow({
  entry: e,
  userId,
  who,
  onVoid,
}: {
  entry: Entry;
  userId: string;
  who: string;
  onVoid: () => void;
}) {
  const effect = effectFor(e, userId);
  const voided = Boolean(e.voided_at);
  const day = dayFmt.format(asDate(e.entry_date));

  let detail: string;
  if (e.kind === "opening") {
    detail = `${day} · Starting balance`;
  } else if (e.kind === "settlement") {
    detail = `${day} · ${who} paid ${fmt(e.amount_cents)}`;
  } else {
    const myPct =
      e.payer_share_pct === null ? 50 : e.payer_id === userId ? e.payer_share_pct : 100 - e.payer_share_pct;
    detail = `${day} · ${who} paid ${fmt(e.amount_cents)}` + (myPct !== 50 ? ` · ${myPct}% yours` : "");
  }

  return (
    <li className={voided ? "voided" : ""}>
      <span className={`dot ${e.kind}`} aria-hidden="true" />
      <div className="grow">
        <strong>{e.name}</strong>
        <span className="muted small">
          {detail}
          {voided && " · voided"}
        </span>
      </div>
      <div className="amount-col">
        <span className={`amount ${effect > 0 ? "pos" : effect < 0 ? "neg" : "muted"}`}>
          {effect > 0 ? "+" : effect < 0 ? "−" : ""}
          {fmt(effect)}
        </span>
        {!voided && (
          <button className="link tiny" onClick={onVoid} aria-label={`Void ${e.name}`}>
            Void
          </button>
        )}
      </div>
    </li>
  );
}
