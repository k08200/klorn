/**
 * The session: a Bearer JWT (the API has no cookie session) kept in the
 * Keychain / Keystore on native (platform/secure-store.ts) and mirrored in
 * memory for the API client. A 401 on any authenticated call ends the session
 * and returns to Welcome with a "session ended" notice.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { clearPersistedCache } from "../api/query-client";
import { getServices, onUnauthorized, setSessionToken } from "../app/services";
import { MOCK_API } from "../config";
import { clearToken, readToken, writeToken } from "../platform/secure-store";
import { clearHidden } from "../screens/mail/hidden-store";
import { clearLaneMoves } from "../screens/mail/lane-history";

export type SessionStatus = "loading" | "signedOut" | "signedIn";

interface SessionValue {
  status: SessionStatus;
  /** Why the last session ended, for the Welcome notice. */
  endedReason: "expired" | "deleted" | null;
  signIn(token: string): Promise<void>;
  signOut(): Promise<void>;
  /** After DELETE /api/auth/account: wipe the device and say so on Welcome. */
  accountDeleted(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

async function initialToken(): Promise<string | null> {
  const stored = await readToken();
  if (stored || !MOCK_API) return stored;
  // Mock builds start signed in unless the scenario says otherwise.
  const mock = await import("../api/mock/transport");
  return mock.currentScenario() === "signedOut" ? null : mock.MOCK_TOKEN;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [endedReason, setEndedReason] = useState<"expired" | "deleted" | null>(null);

  useEffect(() => {
    let alive = true;
    void initialToken().then((token) => {
      if (!alive) return;
      setSessionToken(token);
      setStatus(token ? "signedIn" : "signedOut");
    });
    return () => {
      alive = false;
    };
  }, []);

  const wipe = useCallback(async () => {
    setSessionToken(null);
    await clearToken();
    queryClient.clear();
    await clearPersistedCache();
    // This device's Done / Later rows belong to the account that made them.
    clearHidden();
    await clearLaneMoves();
  }, [queryClient]);

  useEffect(
    () =>
      onUnauthorized(() => {
        setEndedReason("expired");
        setStatus("signedOut");
        void wipe();
      }),
    [wipe],
  );

  const signIn = useCallback(
    async (token: string) => {
      await writeToken(token);
      setSessionToken(token);
      setEndedReason(null);
      queryClient.clear();
      setStatus("signedIn");
    },
    [queryClient],
  );

  const signOut = useCallback(async () => {
    // Best effort: drop this device's server-side session row first.
    await getServices()
      .ep.auth.logout()
      .catch(() => {});
    await wipe();
    setEndedReason(null);
    setStatus("signedOut");
  }, [wipe]);

  const accountDeleted = useCallback(async () => {
    // The server already removed the user and every session row: no logout call.
    await wipe();
    setEndedReason("deleted");
    setStatus("signedOut");
  }, [wipe]);

  const value = useMemo(
    () => ({ status, endedReason, signIn, signOut, accountDeleted }),
    [status, endedReason, signIn, signOut, accountDeleted],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}
