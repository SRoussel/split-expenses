import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { categoryLabel } from "../shared/categories";
import { describeSchedule } from "../shared/recurring";
import {
  addEntry,
  addPasskey,
  ApiError,
  getAccount,
  takePasskeyOffer,
  editEntry,
  loadHousehold,
  purgeVoided,
  resetHousehold,
  signOut,
  stopRecurring,
  unvoidEntry,
  voidEntry,
} from "./api";
import {
  AddExpenseForm,
  ChangePasswordForm,
  DefaultSplitForm,
  OpeningForm,
  pctText,
  RecurringForm,
  SettleForm,
} from "./forms";
import ImportSummary from "./ImportSummary";
import { saveTextFile } from "./files";
import SignInSettings from "./SignInSettings";
import HomeScreen from "./HomeScreen";
import SpendingScreen from "./SpendingScreen";
import {
  balanceFor,
  effectFor,
  exportLedgerCsv,
  filterTotals,
  fmt,
  isFiltering,
  matchesFilter,
  NO_FILTER,
} from "./ledger";
import LedgerFilters from "./LedgerFilters";
import { isRedacted, setRedacted } from "./redact";
import type { Entry, Member, NewEntry, Recurring } from "./types";
import { ConfirmDialog, ErrorText, Modal, Toast, type ToastState } from "./ui";

type Panel =
  | null
  | "add"
  | "settle"
  | "opening"
  | "import"
  | "more"
  | "password"
  | "signin"
  | "passkey-offer"
  | "split"
  | "recurring"
  | "purge"
  | "reset";

// Entry dates are plain calendar days, so format them in UTC to avoid shifting a day.
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const longDayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
// created_at / voided_at are real moments, so show them in local time.
const momentFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const headerDateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit", year: "numeric" });
const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

const KIND_LABEL = { expense: "Expense", settlement: "Payment", opening: "Starting balance" } as const;

export default function LedgerScreen({
  userId,
  email,
  onSignedOut,
}: {
  userId: string;
  email: string;
  onSignedOut: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [recurring, setRecurring] = useState<Recurring[]>([]);
  const [ruleEditing, setRuleEditing] = useState<Recurring | "new" | null>(null);
  const [stopping, setStopping] = useState<Recurring | null>(null);
  const [inviteCode, setInviteCode] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [tab, setTab] = useState<"home" | "ledger" | "spending" | "trends">("home");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [voiding, setVoiding] = useState<Entry | null>(null);
  const [showVoided, setShowVoided] = useState(false);
  const [redacted, setRedactedState] = useState(isRedacted);
  function redact(value: boolean) {
    setRedacted(value); // amounts read this while rendering, so it's set before the re-render
    setRedactedState(value);
  }
  const [filter, setFilter] = useState(NO_FILTER);

  // Right after a password sign-in, offer once to add a passkey (if there isn't one yet).
  useEffect(() => {
    if (!takePasskeyOffer()) return;
    getAccount()
      .then((a) => a.passkeys.length === 0 && setPanel((p) => p ?? "passkey-offer"))
      .catch(() => undefined);
  }, []);
  // Entries that weren't there on the previous load "print" in (see .printed in styles.css).
  const knownIds = useRef<Set<string> | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!loaded) return;
    const prev = knownIds.current;
    knownIds.current = new Set(entries.map((e) => e.id));
    if (!prev) return; // first load: nothing is new
    const fresh = entries.filter((e) => !prev.has(e.id)).map((e) => e.id);
    if (fresh.length) setFreshIds(new Set(fresh));
  }, [entries, loaded]);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const clearToast = useCallback(() => setToast(null), []);
  const closePanel = useCallback(() => setPanel(null), []);
  const closeDetails = useCallback(() => setSelectedId(null), []);
  const closeEdit = useCallback(() => setEditing(null), []);
  // The rule sheet replaces the list (sheets never stack); closing it goes back to the list.
  const backToRules = useCallback(() => {
    setRuleEditing(null);
    setPanel("recurring");
  }, []);

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
      setRecurring(data.recurring ?? []);
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
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? "Someone") : "Someone");

  const balance = balanceFor(entries, userId);
  const hasOpening = entries.some((e) => e.kind === "opening" && !e.voided_at);
  const voidedCount = entries.filter((e) => e.voided_at).length;
  const ready = Boolean(me && partner);
  // Look the selected entry up fresh, so the sheet reflects the latest refresh.
  const selected = entries.find((e) => e.id === selectedId) ?? null;

  // Entries arrive newest first; group them under month headings.
  const matching = useMemo(
    () => entries.filter((e) => (showVoided || !e.voided_at) && matchesFilter(e, filter, userId)),
    [entries, showVoided, filter, userId],
  );
  const months = useMemo(() => {
    const visible = matching;
    const groups: { key: string; label: string; items: Entry[] }[] = [];
    for (const e of visible) {
      const key = e.entry_date.slice(0, 7);
      if (groups.at(-1)?.key !== key) groups.push({ key, label: monthFmt.format(asDate(e.entry_date)), items: [] });
      groups.at(-1)!.items.push(e);
    }
    return groups;
  }, [matching]);

  function saved(message: string) {
    setPanel(null);
    setEditing(null);
    setRuleEditing(null);
    setToast({ message });
    void load();
  }

  async function restore(entry: Entry, message: string) {
    try {
      await unvoidEntry(entry.id);
      setToast({ message });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't restore that entry.");
    }
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
    await saveTextFile("ledger.csv", exportLedgerCsv(entries, userId));
  }

  if (!loaded) {
    return (
      <main className="narrow">
        <p className="muted center">Loading…</p>
      </main>
    );
  }

  const tone = balance > 0 ? "pos" : balance < 0 ? "neg" : "even";
  const waiting = !partner && (
    <section className="card stack">
      <strong>Waiting for your partner</strong>
      <p className="muted">Have them create an account, choose "Join partner's", and enter this code:</p>
      <div className="row">
        <code className="code">{inviteCode}</code>
        <button className="link" onClick={() => void copyCode()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </section>
  );
  const balanceCard = (
    <section className={`balance ${tone}`} aria-live="polite">
      <span className="balance-label">
        {balance > 0 ? `${partnerName} owes you` : balance < 0 ? `You owe ${partnerName}` : "All settled up"}
      </span>
      <strong className="balance-amount">{fmt(balance)}</strong>
    </section>
  );
  const saveEdit = (entry: NewEntry) => editEntry(editing!.id, entry);

  return (
    <main className={tab === "ledger" || tab === "home" ? "with-bar" : ""}>
      <header className="masthead">
        <h1>SPLIT</h1>
        <p>
          {me && partner ? `${me.display_name} & ${partner.display_name}` : (me?.display_name ?? "")} ·{" "}
          {headerDateFmt.format(new Date())}
        </p>
      </header>
      <nav className="nav" role="tablist" aria-label="Section">
        {(
          [
            ["home", "Home"],
            ["ledger", "Ledger"],
            ["spending", "Spending"],
            ["trends", "Trends"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
        <button className="more" onClick={() => setPanel("more")}>
          More
        </button>
      </nav>

      <ErrorText message={error} />

      {tab === "home" ? (
        <HomeScreen
          userId={userId}
          members={members}
          entries={entries}
          balance={
            <>
              {waiting}
              {balanceCard}
            </>
          }
          renderEntry={(e) => (
            <EntryRow
              key={e.id}
              entry={e}
              userId={userId}
              partnerName={partnerName}
              fresh={freshIds.has(e.id)}
              addedBy={e.created_by !== userId ? nameOf(e.created_by) : null}
              onOpen={() => setSelectedId(e.id)}
            />
          )}
          onSeeAll={() => {
            setTab("ledger");
            window.scrollTo(0, 0);
          }}
        />
      ) : tab !== "ledger" ? (
        <SpendingScreen
          userId={userId}
          members={members}
          entries={entries}
          mode={tab === "trends" ? "trends" : "month"}
          onShowEntries={(only) => {
            setFilter({ ...NO_FILTER, only });
            setTab("ledger");
            window.scrollTo(0, 0);
          }}
        />
      ) : (
        <>
          {waiting}
          {balanceCard}

          {entries.length > 0 && (
            <LedgerFilters
              filter={filter}
              onChange={setFilter}
              partnerName={partnerName}
              totals={filterTotals(matching, userId)}
            />
          )}

          {months.length === 0 && isFiltering(filter) ? (
            <div className="empty">
              <p>No entries match.</p>
              <button className="link" onClick={() => setFilter(NO_FILTER)}>
                Clear search and filters
              </button>
            </div>
          ) : months.length === 0 ? (
            <div className="empty">
              <p>No entries yet.</p>
              <p className="muted small">
                {ready
                  ? "Add your first expense with the button below."
                  : "Once your partner joins, you can add expenses."}
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
                      partnerName={partnerName}
                      fresh={freshIds.has(e.id)}
                      addedBy={e.created_by !== userId ? nameOf(e.created_by) : null}
                      onOpen={() => setSelectedId(e.id)}
                    />
                  ))}
                  <MonthSubtotal entries={m.items} userId={userId} month={m.label} />
                </ul>
              </section>
            ))
          )}

          {me && partner && (
            <span className="stamp">
              Split {pctText(me.share_pct)}/{pctText(partner.share_pct)}
            </span>
          )}
        </>
      )}

      {(tab === "ledger" || tab === "home") && (
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
      )}

      <Toast toast={toast} onDone={clearToast} />

      {selected && (
        <Modal title={KIND_LABEL[selected.kind]} onClose={closeDetails}>
          <EntryDetails
            entry={selected}
            rule={recurring.find((r) => r.id === selected.recurring_id)}
            userId={userId}
            nameOf={nameOf}
            partnerName={partnerName}
            canEdit={ready}
            onEdit={() => {
              setSelectedId(null);
              setEditing(selected);
            }}
            onVoid={() => {
              setSelectedId(null);
              setVoiding(selected);
            }}
            onRestore={() => {
              setSelectedId(null);
              void restore(selected, "Entry restored");
            }}
          />
        </Modal>
      )}

      {voiding && (
        <ConfirmDialog
          title="Void this entry?"
          message={
            <>
              <strong>{voiding.name}</strong> ({fmt(voiding.amount_cents)}) stays in the history but stops counting
              toward the balance. You can undo this right away, or restore it later from the voided entries.
            </>
          }
          confirmLabel="Void entry"
          danger
          onConfirm={async () => {
            const entry = voiding;
            await voidEntry(entry.id);
            setToast({
              message: "Entry voided",
              action: { label: "Undo", onClick: () => void restore(entry, "Entry restored") },
            });
            void load();
          }}
          onClose={() => setVoiding(null)}
        />
      )}

      {editing && me && partner && (
        <Modal title={`Edit ${KIND_LABEL[editing.kind].toLowerCase()}`} onClose={closeEdit}>
          <p className="muted small edit-note">
            The original stays in the history (under voided entries) marked as edited.
          </p>
          {editing.kind === "expense" && (
            <AddExpenseForm
              me={me}
              partner={partner}
              initial={editing}
              save={saveEdit}
              onSaved={() => saved("Changes saved")}
            />
          )}
          {editing.kind === "settlement" && (
            <SettleForm
              me={me}
              partner={partner}
              balance={balance}
              initial={editing}
              save={saveEdit}
              onSaved={() => saved("Changes saved")}
            />
          )}
          {editing.kind === "opening" && (
            <OpeningForm
              me={me}
              partner={partner}
              initial={editing}
              save={saveEdit}
              onSaved={() => saved("Changes saved")}
            />
          )}
        </Modal>
      )}

      {panel === "add" && me && partner && (
        <Modal title="Add expense" onClose={closePanel}>
          <AddExpenseForm
            me={me}
            partner={partner}
            history={entries}
            save={addEntry}
            onSaved={() => saved("Expense added")}
          />
        </Modal>
      )}

      {panel === "settle" && me && partner && (
        <Modal title="Settle up" onClose={closePanel}>
          <SettleForm
            me={me}
            partner={partner}
            balance={balance}
            save={addEntry}
            onSaved={() => saved("Payment recorded")}
          />
        </Modal>
      )}

      {panel === "opening" && me && partner && (
        <Modal title="Starting balance" onClose={closePanel}>
          <OpeningForm me={me} partner={partner} save={addEntry} onSaved={() => saved("Starting balance saved")} />
        </Modal>
      )}

      {panel === "import" && me && partner && (
        <Modal title="Import statement" onClose={closePanel}>
          <ImportSummary me={me} partner={partner} entries={entries} onSaved={() => saved("Statement imported")} />
        </Modal>
      )}

      {panel === "recurring" && (
        <Modal title="Recurring expenses" onClose={closePanel}>
          <div className="stack">
            <p className="muted small">
              Added to the ledger automatically when either of you opens the app on or after each date.
            </p>
            {recurring.length > 0 && (
              <div className="menu">
                {recurring.map((r) => (
                  <button
                    key={r.id}
                    className="rule-row"
                    onClick={() => {
                      setPanel(null);
                      setRuleEditing(r);
                    }}
                  >
                    <span className="grow">
                      <strong>{r.name}</strong>
                      <span className="muted small">
                        {describeSchedule(r.start_date, r.frequency)} · {nameOf(r.payer_id)} pays
                      </span>
                    </span>
                    <span className="rule-side">
                      <span className="amount">{fmt(r.amount_cents)}</span>
                      <span className="muted small">
                        {r.paused ? "Paused" : `next ${dayFmt.format(asDate(r.next_date))}`}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <button
              className="primary"
              disabled={!ready}
              onClick={() => {
                setPanel(null);
                setRuleEditing("new");
              }}
            >
              Add recurring expense
            </button>
          </div>
        </Modal>
      )}

      {ruleEditing && me && partner && (
        <Modal title={ruleEditing === "new" ? "New recurring expense" : "Recurring expense"} onClose={backToRules}>
          <RecurringForm
            me={me}
            partner={partner}
            initial={ruleEditing === "new" ? undefined : ruleEditing}
            onSaved={() => {
              const isNew = ruleEditing === "new";
              backToRules();
              setToast({ message: isNew ? "Recurring expense added" : "Changes saved" });
              void load();
            }}
            onStop={
              ruleEditing === "new"
                ? undefined
                : () => {
                    setStopping(ruleEditing);
                    setRuleEditing(null);
                  }
            }
          />
        </Modal>
      )}

      {stopping && (
        <ConfirmDialog
          title="Stop this recurring expense?"
          message={
            <>
              <strong>{stopping.name}</strong> won't be added again. The ones already in the ledger stay. To take a
              break instead, edit it and turn on Paused.
            </>
          }
          confirmLabel="Stop"
          danger
          onConfirm={async () => {
            await stopRecurring(stopping.id);
            setToast({ message: "Recurring expense stopped" });
            void load();
          }}
          onClose={() => {
            setStopping(null);
            setPanel("recurring");
          }}
        />
      )}

      {panel === "purge" && (
        <ConfirmDialog
          title="Delete voided and edited history?"
          message={
            <>
              This permanently deletes {voidedCount} voided {voidedCount === 1 ? "entry" : "entries"} and old versions
              of edited entries. Active entries and the balance don't change, but these can't be restored afterwards.
            </>
          }
          confirmLabel={`Delete ${voidedCount}`}
          danger
          onConfirm={async () => {
            const { deleted } = await purgeVoided();
            setShowVoided(false);
            setToast({ message: `Deleted ${deleted} ${deleted === 1 ? "entry" : "entries"}` });
            void load();
          }}
          onClose={closePanel}
        />
      )}

      {panel === "reset" && (
        <ResetDialog
          entryCount={entries.length}
          ruleCount={recurring.length}
          onExport={() => void exportCsv()}
          onReset={async (confirm) => {
            await resetHousehold(confirm);
            setToast({ message: "Everything deleted" });
            void load();
          }}
          onClose={closePanel}
        />
      )}

      {panel === "split" && me && partner && (
        <Modal title="Default split" onClose={closePanel}>
          <DefaultSplitForm me={me} partner={partner} onSaved={() => saved("Default split saved")} />
        </Modal>
      )}

      {panel === "password" && (
        <Modal title="Change password" onClose={closePanel}>
          <ChangePasswordForm onSaved={() => saved("Password changed")} />
        </Modal>
      )}

      {panel === "signin" && (
        <Modal title="Passkeys and sign-in" onClose={closePanel}>
          <SignInSettings onMessage={(message) => setToast({ message })} />
        </Modal>
      )}

      {panel === "passkey-offer" && <PasskeyOffer onClose={closePanel} onAdded={() => saved("Passkey added")} />}

      {panel === "more" && (
        <Modal title="More" onClose={closePanel}>
          <div className="stack">
            <div className="menu">
              <button disabled={!ready} onClick={() => setPanel("split")}>
                Default split
                {me && partner && (
                  <span className="menu-value">
                    {pctText(me.share_pct)}/{pctText(partner.share_pct)}
                  </span>
                )}
              </button>
              <button onClick={() => setPanel("recurring")}>
                Recurring expenses
                {recurring.length > 0 && <span className="menu-value">{recurring.length}</span>}
              </button>
              <button disabled={!ready} onClick={() => setPanel("import")}>
                Import statement summary
              </button>
              <button disabled={!ready || hasOpening} onClick={() => setPanel("opening")}>
                {hasOpening ? "Starting balance already set" : "Set starting balance"}
              </button>
              <button onClick={() => void exportCsv()} disabled={entries.length === 0}>
                Export ledger as CSV
              </button>
            </div>
            <label className="check">
              <input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} />
              Show voided and edited entries
            </label>
            <label className="check">
              <input type="checkbox" checked={redacted} onChange={(e) => redact(e.target.checked)} />
              <span>
                Redact amounts
                <span className="hint">Every amount shows as dots, for showing the app to someone.</span>
              </span>
            </label>

            <h2 className="section-label">Reset</h2>
            <div className="menu">
              {voidedCount > 0 && (
                <button className="danger-item" onClick={() => setPanel("purge")}>
                  Delete voided and edited history
                  <span className="menu-value">{voidedCount}</span>
                </button>
              )}
              <button
                className="danger-item"
                disabled={entries.length === 0 && recurring.length === 0}
                onClick={() => setPanel("reset")}
              >
                Delete everything…
              </button>
            </div>

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
              <button onClick={() => setPanel("signin")}>Passkeys and sign-in</button>
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

/** Shown once after a password sign-in: one tap to set up Face ID sign-in. */
function PasskeyOffer({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function add() {
    setBusy(true);
    setError(null);
    try {
      await addPasskey();
      onAdded();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "cancelled")) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
      setBusy(false);
    }
  }
  return (
    <Modal title="Sign in with Face ID?" onClose={onClose}>
      <div className="stack">
        <p>
          Add a passkey and next time you can sign in with Face ID or Touch ID, no password needed. It syncs to your
          other Apple devices through iCloud Keychain.
        </p>
        <ErrorText message={error} />
        <div className="actions-row">
          <button onClick={onClose} disabled={busy}>
            Not now
          </button>
          <button className="primary" onClick={() => void add()} disabled={busy}>
            {busy ? "One moment…" : "Add a passkey"}
          </button>
        </div>
        <p className="muted small">You can do this any time in More &gt; Passkeys and sign-in.</p>
      </div>
    </Modal>
  );
}

/** What this entry means for `userId`: "+$42.10" (owed to you) or "−$42.10" (you owe). */
function EffectAmount({ entry, userId }: { entry: Entry; userId: string }) {
  const effect = effectFor(entry, userId);
  return (
    <span className={`amount ${effect > 0 ? "pos" : effect < 0 ? "neg" : "muted"}`}>
      {effect > 0 ? "+" : effect < 0 ? "−" : ""}
      {fmt(effect)}
    </span>
  );
}

/** Your share of an expense, in percent. */
const myPctOf = (e: Entry, userId: string) => {
  const payerPct = e.payer_share_pct ?? 50;
  return e.payer_id === userId ? payerPct : 100 - payerPct;
};

/** The second line of a row, in words: who paid, and who owes whom because of it. */
function rowDetail(e: Entry, userId: string, partnerName: string): string {
  const day = dayFmt.format(asDate(e.entry_date));
  if (e.kind === "opening") return `${day} · Starting balance`;
  const iPaid = e.payer_id === userId;
  if (e.kind === "settlement") return `${day} · ${iPaid ? `You paid ${partnerName}` : `${partnerName} paid you`}`;
  const paid = `${iPaid ? "You" : partnerName} paid ${fmt(e.amount_cents)}`;
  if (e.owed_cents === 0) return `${day} · ${paid} · all ${iPaid ? "yours" : "theirs"}`;
  // The amount owed is the number on the right; this line just says which way it goes.
  return `${day} · ${paid} · ${iPaid ? `${partnerName} owes you` : `you owe ${partnerName}`}`;
}

function EntryRow({
  entry: e,
  userId,
  partnerName,
  fresh,
  addedBy,
  onOpen,
}: {
  entry: Entry;
  userId: string;
  partnerName: string;
  fresh: boolean;
  addedBy: string | null;
  onOpen: () => void;
}) {
  let detail = rowDetail(e, userId, partnerName);
  if (addedBy) detail += ` · added by ${addedBy}`;
  if (e.voided_at) detail += e.replaced_by ? " · edited" : " · voided";
  const payment = e.kind === "settlement";

  return (
    <li
      className={
        [e.voided_at && "voided", payment && "payment", fresh && "printed"].filter(Boolean).join(" ") || undefined
      }
    >
      <button className="entry-btn" onClick={onOpen} aria-label={`${e.name}, ${detail}. Details`}>
        <span className="entry-name">
          {payment && (
            <span className="paid-stamp" aria-hidden="true">
              Paid
            </span>
          )}
          {e.recurring_id && (
            <span className="repeat" aria-label="Recurring: ">
              ↻{" "}
            </span>
          )}
          {e.name}
        </span>
        <span className="lead" aria-hidden="true" />
        <EffectAmount entry={e} userId={userId} />
        <span className="entry-detail">{detail}</span>
      </button>
    </li>
  );
}

/** The month's net change to the balance, printed like a receipt subtotal. Voided entries don't count. */
function MonthSubtotal({ entries, userId, month }: { entries: Entry[]; userId: string; month: string }) {
  const active = entries.filter((e) => !e.voided_at);
  if (active.length < 2) return null;
  const net = active.reduce((n, e) => n + effectFor(e, userId), 0);
  return (
    <li className="subtotal" aria-label={`${month}: the balance changed by ${net < 0 ? "minus " : ""}${fmt(net)}`}>
      <span>Subtotal</span>
      <span className="lead" aria-hidden="true" />
      <span className={`amount ${net > 0 ? "pos" : net < 0 ? "neg" : "muted"}`}>
        {net > 0 ? "+" : net < 0 ? "−" : ""}
        {fmt(net)}
      </span>
    </li>
  );
}

function EntryDetails({
  entry: e,
  rule,
  userId,
  nameOf,
  partnerName,
  canEdit,
  onEdit,
  onVoid,
  onRestore,
}: {
  entry: Entry;
  rule: Recurring | undefined;
  userId: string;
  nameOf: (id: string | null) => string;
  partnerName: string;
  canEdit: boolean;
  onEdit: () => void;
  onVoid: () => void;
  onRestore: () => void;
}) {
  const facts: [string, string][] = [["Date", longDayFmt.format(asDate(e.entry_date))]];
  if (e.kind === "opening") {
    facts.push(["Owed to", nameOf(e.payer_id)], ["Amount", fmt(e.amount_cents)]);
  } else {
    facts.push(["Paid by", nameOf(e.payer_id)], ["Total", fmt(e.amount_cents)]);
  }
  if (e.kind === "expense") {
    const mine = myPctOf(e, userId);
    facts.push(["Split", `You ${pctText(mine)}% · ${partnerName} ${pctText(100 - mine)}%`]);
  }
  if (e.category) facts.push(["Category", categoryLabel(e.category)]);
  if (e.recurring_id) {
    facts.push(["Repeats", rule ? describeSchedule(rule.start_date, rule.frequency) : "No longer (stopped)"]);
  }
  facts.push([
    e.recurring_id ? "Added automatically" : "Added",
    `${e.recurring_id ? "" : `${nameOf(e.created_by)}, `}${momentFmt.format(new Date(e.created_at))}`,
  ]);
  if (e.voided_at) {
    facts.push([
      e.replaced_by ? "Edited" : "Voided",
      `${nameOf(e.voided_by)}, ${momentFmt.format(new Date(e.voided_at))}`,
    ]);
  }

  return (
    <div className="stack">
      <div className="detail-head">
        <strong className={e.voided_at ? "struck" : ""}>{e.name}</strong>
        <EffectAmount entry={e} userId={userId} />
      </div>
      {e.voided_at && (
        <p className="notice">
          {e.replaced_by
            ? "This is the old version of an edited entry. It no longer counts."
            : "This entry is voided and doesn't count toward the balance."}
        </p>
      )}
      <dl className="facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {!e.voided_at && (
        <div className="actions-row">
          <button onClick={onVoid}>Void</button>
          <button className="primary" onClick={onEdit} disabled={!canEdit}>
            Edit
          </button>
        </div>
      )}
      {e.voided_at && !e.replaced_by && (
        <button className="primary" onClick={onRestore}>
          Restore entry
        </button>
      )}
    </div>
  );
}

/** "Delete everything": the user has to type DELETE, and can export a copy first. */
function ResetDialog({
  entryCount,
  ruleCount,
  onExport,
  onReset,
  onClose,
}: {
  entryCount: number;
  ruleCount: number;
  onExport: () => void;
  onReset: (confirm: string) => Promise<void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      await onReset(typed.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Delete everything?" onClose={onClose}>
      <div className="stack">
        <p>
          This permanently deletes all {entryCount} {entryCount === 1 ? "entry" : "entries"} and {ruleCount} recurring{" "}
          {ruleCount === 1 ? "expense" : "expenses"} for both of you, and the balance goes back to zero. Your accounts,
          the household and the default split stay.
        </p>
        <p className="notice">It can't be undone in the app. Export a copy first if you might want it back.</p>
        <button onClick={onExport} disabled={entryCount === 0}>
          Export ledger as CSV first
        </button>
        <label>
          Type DELETE to confirm
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <ErrorText message={error} />
        <div className="actions-row">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="danger" onClick={() => void reset()} disabled={busy || typed.trim() !== "DELETE"}>
            {busy ? "Deleting…" : "Delete everything"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
