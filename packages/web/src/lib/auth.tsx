"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { apiFetch, clearStoredAuthToken, getStoredAuthToken, setStoredAuthToken } from "./api";
import { trackAppOpenOnce } from "./track";

interface User {
  id: string;
  email: string;
  name: string | null;
  plan: string;
  role: string;
  // Whether the user may use paid features (active sub / trial / comped /
  // admin). Server-computed; always true while the paywall is off. Gates
  // Pro-only surfaces (e.g. the Settings subscription state).
  entitled?: boolean;
  // Whether to hard-wall the app on entry (pure subscriber-only mode). Always
  // false with the usable free tier — free users get in, bounded by the free
  // daily cost cap. The client shows the full paywall only when this is true.
  paywalled?: boolean;
  // Whether the web (Stripe) checkout can complete server-side (secret key +
  // PRO price configured). When false the web paywall/subscription surfaces
  // disable their subscribe button instead of firing a checkout that 400s
  // (e.g. a native-IAP-only launch). Undefined (older API) = assume available.
  webCheckoutAvailable?: boolean;
  // IANA timezone (e.g., "Asia/Seoul"). Always present — defaults server-side
  // to "Asia/Seoul" when the column is null. Used for date/time rendering so
  // the UI doesn't silently fall back to the browser timezone, which on iOS
  // PWA can disagree with the user's actual locale (e.g., shows UTC).
  timezone: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  authError: "api_unavailable" | null;
  googleConnected: boolean | null;
  initSync: InitSyncState;
  login: (email: string, password: string, redirectTo?: string) => Promise<void>;
  register: (email: string, password: string, name?: string, redirectTo?: string) => Promise<void>;
  loginWithToken: (token: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

type InitSyncStatus = "idle" | "syncing" | "done" | "skipped" | "failed";

interface InitSyncState {
  status: InitSyncStatus;
  calendar: number;
  contacts: number;
  emails: number;
  reason: string | null;
}

const INIT_SYNC_IDLE: InitSyncState = {
  status: "idle",
  calendar: 0,
  contacts: 0,
  emails: 0,
  reason: null,
};

interface InitSyncResponse {
  synced: boolean;
  reason?: string;
  calendar?: number;
  contacts?: number;
  emails?: number;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<"api_unavailable" | null>(null);
  const [googleConnected, setGoogleConnected] = useState<boolean | null>(null);
  const [initSync, setInitSync] = useState<InitSyncState>(INIT_SYNC_IDLE);
  const router = useRouter();

  const runInitialSync = useCallback((authToken: string) => {
    setInitSync((prev) => ({ ...prev, status: "syncing", reason: null }));
    apiFetch<InitSyncResponse>("/api/auth/init-sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((data) => {
        if (!data.synced) {
          if (data.reason === "google_not_connected") {
            setGoogleConnected(false);
          }
          setInitSync({
            status: "skipped",
            calendar: 0,
            contacts: 0,
            emails: 0,
            reason: data.reason || "not_synced",
          });
          return;
        }
        setGoogleConnected(true);
        setInitSync({
          status: "done",
          calendar: data.calendar ?? 0,
          contacts: data.contacts ?? 0,
          emails: data.emails ?? 0,
          reason: null,
        });
      })
      .catch(() => {
        setInitSync((prev) => ({ ...prev, status: "failed", reason: "sync_failed" }));
      });
  }, []);

  // Load token from localStorage on mount
  useEffect(() => {
    const stored = getStoredAuthToken();
    if (stored) {
      setToken(stored);
      // Verify token
      apiFetch<{ user: User & { googleConnected?: boolean } }>("/api/auth/me", {
        headers: { Authorization: `Bearer ${stored}` },
      })
        .then((data) => {
          setUser(data.user);
          setGoogleConnected(data.user.googleConnected ?? false);
          // Retention analytics: an authenticated session bootstrapped = the
          // user opened the app. Fires once per browser session (DAU signal).
          trackAppOpenOnce();
          // Auto-sync on app reload if Google is connected
          if (data.user.googleConnected) {
            runInitialSync(stored);
          }
        })
        .catch((err) => {
          const isUnauthorized = err instanceof Error && err.message.startsWith("API 401:");
          if (isUnauthorized) {
            clearStoredAuthToken();
            setToken(null);
          } else {
            setAuthError("api_unavailable");
          }
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [runInitialSync]);

  const login = useCallback(
    async (email: string, password: string, redirectTo = "/inbox") => {
      const data = await apiFetch<{ token: string; user: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setStoredAuthToken(data.token);
      setToken(data.token);
      setUser(data.user);
      setAuthError(null);
      router.push(redirectTo);

      // Trigger bootstrap sync. If Google is not connected yet, the card can show that clearly.
      runInitialSync(data.token);
    },
    [router, runInitialSync],
  );

  const register = useCallback(
    async (email: string, password: string, name?: string, redirectTo = "/onboarding") => {
      const data = await apiFetch<{ token: string; user: User }>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, name }),
      });
      setStoredAuthToken(data.token);
      setToken(data.token);
      setUser(data.user);
      setAuthError(null);
      setGoogleConnected(false);
      router.push(redirectTo);
    },
    [router],
  );

  const loginWithToken = useCallback(
    async (newToken: string) => {
      setStoredAuthToken(newToken);
      setToken(newToken);
      try {
        const data = await apiFetch<{ user: User & { googleConnected?: boolean } }>(
          "/api/auth/me",
          {
            headers: { Authorization: `Bearer ${newToken}` },
          },
        );
        setUser(data.user);
        setAuthError(null);
        setGoogleConnected(data.user.googleConnected ?? true);
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: critical auth failure, always log
        console.error("[auth] loginWithToken: /api/auth/me FAILED", err);
        throw err;
      }

      // Trigger initial sync (calendar, contacts, recent emails) after Google login.
      runInitialSync(newToken);

      window.location.href = "/inbox";
    },
    [runInitialSync],
  );

  const logout = useCallback(() => {
    clearStoredAuthToken();
    setToken(null);
    setUser(null);
    setAuthError(null);
    setGoogleConnected(null);
    setInitSync(INIT_SYNC_IDLE);
    router.push("/login");
  }, [router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        authError,
        googleConnected,
        initSync,
        login,
        register,
        loginWithToken,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
