import { useCallback, useEffect, useState } from "react";
import { getMe, setSessionLostHandler, type Membership, type User } from "./api";
import AuthScreen from "./AuthScreen";
import LedgerScreen from "./LedgerScreen";
import Onboarding from "./Onboarding";
import { ErrorText } from "./ui";

type Account = { user: User; membership: Membership | null };

export default function App() {
  // undefined = still checking, null = signed out
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await getMe();
      setAccount(me.user ? { user: me.user, membership: me.membership ?? null } : null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach the server.");
      setAccount((prev) => (prev === undefined ? null : prev));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // If any later call finds we're signed out, re-check the account so the right screen shows.
    setSessionLostHandler(() => void refresh());
    return () => setSessionLostHandler(null);
  }, [refresh]);

  if (account === undefined) {
    return (
      <main className="narrow">
        <p className="muted">Loading...</p>
      </main>
    );
  }
  if (!account) {
    return (
      <>
        <ErrorText message={error} />
        <AuthScreen onDone={() => void refresh()} />
      </>
    );
  }
  if (!account.membership) {
    return <Onboarding onDone={() => void refresh()} />;
  }
  return (
    <LedgerScreen
      userId={account.user.id}
      email={account.user.email}
      householdId={account.membership.household_id}
      onSignedOut={() => void refresh()}
    />
  );
}
