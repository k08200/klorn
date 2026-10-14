"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { apiFetch, clearStoredAuthToken, getStoredAuthToken, setStoredAuthToken } from "./api";
import { storedAttribution } from "./attribution";
import { forgetHome, homePath, LEGACY_HOME, rememberHome, signInDestination } from "./home";
import { clearSensitiveStorage, revokeServerSession } from "./logout-cleanup";
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
  // Server-driven client flag: the API's KEYBOARD_TRIAGE (productization plan
  // P4). True turns on the hotkey registry beyond Cmd+K / B / /, the `?` sheet
  // and optimistic lane moves with undo. Undefined (older API) = off.
  keyboardTriage?: boolean;
  // Server-driven client flag: the API's MAIL_V2 (productization plan P5).
  // True renders /email as the lane-first list. Undefined (older API) = off.
  mailV2?: boolean;
  // Server-driven client flag: the API's UNIFIED_HOME (productization plan
  // P6). True makes Today (/today) the home and switches the nav to Today ·
  // Mail · Calendar · Assistant. Undefined (older API) = off.
  unifiedHome?: boolean;
  // Server-driven client flag: the API's ONBOARDING_V2 (productization plan
  // P8). True renders /onboarding as the multi-provider first run. Undefined
  // (older API) = off.
  onboardingV2?: boolean;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  authError: "api_unavailable" | null;
  googleConnected: boolean | null;
  /** Google was connected once and the grant is now unusable — reconnect. */
  googleNeedsReconnect: boolean;
  // Whether ANY mail source is attached (primary Google grant OR a linked/
  // IMAP inbox) — server-computed on /api/auth/me. The AuthGuard keys its
  // onboarding redirect on this, so an Apple/Naver-login user who connected
  // Naver IMAP instead of Gmail is not bounced out of the app. null = unknown.
  hasMailSource: boolean | null;
  initSync: InitSyncState;
  /** Run the primary account's sign-in sync again (the first run's retry). */
  retryInitSync: () => void;
  /** `redirectTo` omitted = the user's home (Today under UNIFIED_HOME); the same for register. */
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
  const [googleNeedsReconnect, setGoogleNeedsReconnect] = useState(false);
  const [hasMailSource, setHasMailSource] = useState<boolean | null>(null);
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
            setGoogleNeedsReconnect(false);
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
        setHasMailSource(true);
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
      apiFetch<{
        user: User & {
          googleConnected?: boolean;
          googleNeedsReconnect?: boolean;
          hasAnyMailSource?: boolean;
        };
      }>("/api/auth/me", {
        headers: { Authorization: `Bearer ${stored}` },
      })
        .then((data) => {
          setUser(data.user);
          // UNIFIED_HOME: keep the home hint for the callers that route before
          // this answer exists (the root redirect, the native sign-in).
          rememberHome(data.user);
          setGoogleConnected(data.user.googleConnected ?? false);
          setGoogleNeedsReconnect(data.user.googleNeedsReconnect ?? false);
          // Older API without the field: fall back to googleConnected so the
          // guard behaves exactly as before this field existed.
          setHasMailSource(data.user.hasAnyMailSource ?? data.user.googleConnected ?? false);
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
    async (email: string, password: string, redirectTo?: string) => {
      const data = await apiFetch<{ token: string; user: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setStoredAuthToken(data.token);
      setToken(data.token);
      setUser(data.user);
      setAuthError(null);
      rememberHome(data.user);
      router.push(signInDestination(redirectTo, data.user));

      // Trigger bootstrap sync. If Google is not connected yet, the card can show that clearly.
      runInitialSync(data.token);
    },
    [router, runInitialSync],
  );

  const register = useCallback(
    async (email: string, password: string, name?: string, redirectTo?: string) => {
      const data = await apiFetch<{ token: string; user: User }>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          email,
          password,
          name,
          attribution: storedAttribution() ?? undefined,
        }),
      });
      setStoredAuthToken(data.token);
      setToken(data.token);
      setUser(data.user);
      setAuthError(null);
      setGoogleConnected(false);
      setGoogleNeedsReconnect(false);
      setHasMailSource(false); // fresh account — nothing attached yet
      rememberHome(data.user);
      router.push(signInDestination(redirectTo, data.user));
    },
    [router],
  );

  const loginWithToken = useCallback(
    async (newToken: string) => {
      setStoredAuthToken(newToken);
      setToken(newToken);
      let connected = false;
      let home = LEGACY_HOME;
      try {
        const data = await apiFetch<{
          user: User & { googleConnected?: boolean; hasAnyMailSource?: boolean };
        }>("/api/auth/me", {
          headers: { Authorization: `Bearer ${newToken}` },
        });
        setUser(data.user);
        setAuthError(null);
        rememberHome(data.user);
        home = homePath(data.user);
        connected = data.user.googleConnected ?? false;
        setGoogleConnected(connected);
        setHasMailSource(data.user.hasAnyMailSource ?? connected);
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: critical auth failure, always log
        console.error("[auth] loginWithToken: /api/auth/me FAILED", err);
        throw err;
      }

      // Login is identity-only (incremental auth): a fresh Google sign-in has
      // no Gmail/Calendar grant yet, so syncing would just 403. Send those
      // users straight to onboarding's Connect step instead of bouncing
      // /inbox → AuthGuard → /onboarding.
      if (connected) {
        runInitialSync(newToken);
        window.location.href = home;
      } else {
        window.location.href = "/onboarding";
      }
    },
    [runInitialSync],
  );

  const retryInitSync = useCallback(() => {
    if (token) runInitialSync(token);
  }, [token, runInitialSync]);

  const logout = useCallback(() => {
    // Order matters: revoke server-side BEFORE clearing the token (the call
    // needs it), then wipe secrets from browser storage (CASA 2.2.1 / 6.6.1).
    revokeServerSession();
    clearStoredAuthToken();
    clearSensitiveStorage();
    // UNIFIED_HOME: the home hint belongs to the session that is ending.
    forgetHome();
    setToken(null);
    setUser(null);
    setAuthError(null);
    setGoogleConnected(null);
    setHasMailSource(null);
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
        googleNeedsReconnect,
        hasMailSource,
        initSync,
        retryInitSync,
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
