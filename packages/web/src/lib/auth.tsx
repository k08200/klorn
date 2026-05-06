"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { apiFetch } from "./api";

interface User {
  id: string;
  email: string;
  name: string | null;
  plan: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  googleConnected: boolean | null;
  initSync: InitSyncState;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
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
    const stored = localStorage.getItem("eve-token");
    if (stored) {
      setToken(stored);
      // Verify token
      apiFetch<{ user: User & { googleConnected?: boolean } }>("/api/auth/me", {
        headers: { Authorization: `Bearer ${stored}` },
      })
        .then((data) => {
          setUser(data.user);
          setGoogleConnected(data.user.googleConnected ?? false);
          // Auto-sync on app reload if Google is connected
          if (data.user.googleConnected) {
            runInitialSync(stored);
          }
        })
        .catch(() => {
          localStorage.removeItem("eve-token");
          setToken(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [runInitialSync]);

  const login = useCallback(
    async (email: string, password: string) => {
      const data = await apiFetch<{ token: string; user: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      localStorage.setItem("eve-token", data.token);
      setToken(data.token);
      setUser(data.user);
      router.push("/inbox");

      // Trigger bootstrap sync. If Google is not connected yet, the card can show that clearly.
      runInitialSync(data.token);
    },
    [router, runInitialSync],
  );

  const register = useCallback(
    async (email: string, password: string, name?: string) => {
      const data = await apiFetch<{ token: string; user: User }>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, name }),
      });
      localStorage.setItem("eve-token", data.token);
      setToken(data.token);
      setUser(data.user);
      setGoogleConnected(false);
      router.push("/inbox");
    },
    [router],
  );

  const loginWithToken = useCallback(
    async (newToken: string) => {
      console.log("[auth] loginWithToken: start");
      localStorage.setItem("eve-token", newToken);
      setToken(newToken);
      console.log("[auth] loginWithToken: token stored, calling /api/auth/me");
      try {
        const data = await apiFetch<{ user: User & { googleConnected?: boolean } }>(
          "/api/auth/me",
          {
            headers: { Authorization: `Bearer ${newToken}` },
          },
        );
        console.log("[auth] loginWithToken: /api/auth/me success", data.user?.email);
        setUser(data.user);
        setGoogleConnected(data.user.googleConnected ?? true);
      } catch (err) {
        console.error("[auth] loginWithToken: /api/auth/me FAILED", err);
        throw err;
      }

      // Trigger initial sync (calendar, contacts, recent emails) after Google login.
      runInitialSync(newToken);

      console.log("[auth] loginWithToken: redirecting to /inbox");
      window.location.href = "/inbox";
    },
    [runInitialSync],
  );

  const logout = useCallback(() => {
    localStorage.removeItem("eve-token");
    setToken(null);
    setUser(null);
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
