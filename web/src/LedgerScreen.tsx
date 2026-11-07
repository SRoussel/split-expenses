import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeSchedule } from "../shared/recurring";
import { addEntry, editEntry, loadHousehold, signOut, stopRecurring, unvoidEntry, voidEntry } from "./api";
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
import { balanceFor, effectFor, exportLedgerCsv, fmt } from "./ledger";
import type { Entry, Member, NewEntry, Recurring } from "./types";
import { ConfirmDialog, ErrorText, Modal, Toast, type ToastState } from "./ui";

type Panel = null | "add" | "settle" | "opening" | "import" | "more" | "password" | "split" | "recurring";

// Entry dates are plain calendar days, so format them in UTC to avoid shifting a day.
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const longDayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
// created_at / voided_at are real moments, so show them in local time.
const momentFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [voiding, setVoiding] = useState<Entry | null>(null);
  const [showVoided, setShowVoided] = useState(false);
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
  const ready = Boolean(me && partner);
  // Look the selected entry up fresh, so the sheet reflects the latest refresh.
  const selected = entries.find((e) => e.id === selectedId) ?? null;

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
  const saveEdit = (entry: NewEntry) => editEntry(editing!.id, entry);

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
                  who={nameOf(e.payer_id)}
                  addedBy={e.created_by !== userId ? nameOf(e.created_by) : null}
                  onOpen={() => setSelectedId(e.id)}
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
              <strong>{voiding.name}</strong> ({fmt(voiding.amount_cents)}) stays in the history but stops
              counting toward the balance. You can undo this right away, or restore it later from the voided
              entries.
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
            <AddExpenseForm me={me} partner={partner} initial={editing} save={saveEdit} onSaved={() => saved("Changes saved")} />
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
            <OpeningForm me={me} partner={partner} initial={editing} save={saveEdit} onSaved={() => saved("Changes saved")} />
          )}
        </Modal>
      )}

      {panel === "add" && me && partner && (
        <Modal title="Add expense" onClose={closePanel}>
          <AddExpenseForm me={me} partner={partner} save={addEntry} onSaved={() => saved("Expense added")} />
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
            onStop={ruleEditing === "new" ? undefined : () => {
              setStopping(ruleEditing);
              setRuleEditing(null);
            }}
          />
        </Modal>
      )}

      {stopping && (
        <ConfirmDialog
          title="Stop this recurring expense?"
          message={
            <>
              <strong>{stopping.name}</strong> won't be added again. The ones already in the ledger stay. To
              take a break instead, edit it and turn on Paused.
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
              <input
                type="checkbox"
                checked={showVoided}
                onChange={(e) => setShowVoided(e.target.checked)}
              />
              Show voided and edited entries
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

function EntryRow({
  entry: e,
  userId,
  who,
  addedBy,
  onOpen,
}: {
  entry: Entry;
  userId: string;
  who: string;
  addedBy: string | null;
  onOpen: () => void;
}) {
  const day = dayFmt.format(asDate(e.entry_date));

  let detail: string;
  if (e.kind === "opening") {
    detail = `${day} · Starting balance`;
  } else {
    const myPct = myPctOf(e, userId);
    detail =
      `${day} · ${who} paid ${fmt(e.amount_cents)}` +
      (e.kind === "expense" && myPct !== 50 ? ` · ${pctText(myPct)}% yours` : "");
  }
  if (addedBy) detail += ` · added by ${addedBy}`;
  if (e.voided_at) detail += e.replaced_by ? " · edited" : " · voided";

  return (
    <li className={e.voided_at ? "voided" : ""}>
      <button className="entry-btn" onClick={onOpen} aria-label={`${e.name}, details`}>
        <span className={`dot ${e.kind}`} aria-hidden="true" />
        <span className="grow">
          <strong>
            {e.recurring_id && (
              <span className="repeat" aria-label="Recurring: ">
                ↻{" "}
              </span>
            )}
            {e.name}
          </strong>
          <span className="muted small">{detail}</span>
        </span>
        <EffectAmount entry={e} userId={userId} />
        <span className="chevron" aria-hidden="true">
          ›
        </span>
      </button>
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
  if (e.recurring_id) {
    facts.push(["Repeats", rule ? describeSchedule(rule.start_date, rule.frequency) : "No longer (stopped)"]);
  }
  facts.push([
    e.recurring_id ? "Added automatically" : "Added",
    `${e.recurring_id ? "" : `${nameOf(e.created_by)}, `}${momentFmt.format(new Date(e.created_at))}`,
  ]);
  if (e.voided_at) {
    facts.push([e.replaced_by ? "Edited" : "Voided", `${nameOf(e.voided_by)}, ${momentFmt.format(new Date(e.voided_at))}`]);
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
