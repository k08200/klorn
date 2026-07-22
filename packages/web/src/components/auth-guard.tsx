"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { API_BASE } from "../lib/api";
import { useAuth } from "../lib/auth";
import PaywallScreen from "./paywall-screen";

// Routes a non-entitled user can still reach: billing (to subscribe), settings
// (manage/cancel), and the sign-in flow. Everything else shows the paywall.
const PAYWALL_BYPASS_PREFIXES = ["/billing", "/settings", "/login", "/auth"];

function isPaywallBypass(pathname: string): boolean {
  return PAYWALL_BYPASS_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// Pages that stay reachable while Google is unconnected. /onboarding is the
// gate itself; /settings is where the user manages the connection; /billing
// must be reachable so a user can upgrade BEFORE connecting Google (otherwise
// a paying customer is bounced to onboarding and can never check out); any
// path under /auth or /login is the sign-in flow.
const GOOGLE_OPTIONAL_PREFIXES = ["/onboarding", "/settings", "/billing", "/login", "/auth"];

function isGoogleOptional(pathname: string): boolean {
  return GOOGLE_OPTIONAL_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Redirects to /login if user is not authenticated. Wraps protected pages. */
export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading, authError, googleConnected } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (authError === "api_unavailable") return;
    if (!loading && !user) {
      const query = typeof window !== "undefined" ? window.location.search.slice(1) : "";
      const next = `${pathname}${query ? `?${query}` : ""}`;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    // User is signed in but Google is not connected — Klorn cannot do its
    // job without mail/calendar access, so route them through the onboarding
    // gate. Settings and the gate itself stay reachable.
    if (!loading && user && googleConnected === false && !isGoogleOptional(pathname)) {
      router.replace("/onboarding");
    }
  }, [user, loading, authError, googleConnected, pathname, router]);

  if (loading) {
    return (
      <main
        className="flex items-center justify-center min-h-[calc(100vh-3.5rem)]"
        role="status"
        aria-live="polite"
      >
        <div
          className="w-6 h-6 border-2 border-sky-300 border-t-transparent rounded-full animate-spin"
          aria-hidden="true"
        />
        <span className="sr-only">Checking session...</span>
      </main>
    );
  }

  if (authError === "api_unavailable") {
    return <ApiOfflineScreen />;
  }

  if (!user) return null;

  // Hard paywall: only when the server says this user is fully walled out —
  // pure subscriber-only mode (no free tier). With the usable free tier this
  // is always false, so free users get into the app and are bounded by the
  // free daily cost cap instead; the upgrade path lives in Settings. Inert
  // until launch flips PAYWALL_ENABLED, and even then only if FREE grants
  // nothing. Billing/settings/sign-in paths stay reachable regardless.
  if (user.paywalled === true && !isPaywallBypass(pathname)) {
    return <PaywallScreen />;
  }

  return <>{children}</>;
}

// Render free tier sleeps after ~15 min idle. Cold starts take 10–30 s. The
// old screen made the user wake the API themselves by mashing Retry — fine
// at a desk, awful on mobile during a meeting. Now we poll /api/health
// automatically with backoff and reload when it comes back. Eight attempts
// over ~28 s covers most cold starts; after that we fall back to manual
// retry so the user still has an escape hatch when Render is actually down.

const ATTEMPT_DELAYS_MS = [1500, 3000, 3000, 3000, 4000, 5000, 5000, 5000];
const TOTAL_BUDGET_MS = ATTEMPT_DELAYS_MS.reduce((a, b) => a + b, 0);

function ApiOfflineScreen() {
  const [attempt, setAttempt] = useState(0);
  const [exhausted, setExhausted] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (exhausted) return;
    const delay = ATTEMPT_DELAYS_MS[attempt];
    if (delay === undefined) {
      setExhausted(true);
      return;
    }

    const timer = setTimeout(async () => {
      if (cancelledRef.current) return;
      try {
        const res = await fetch(`${API_BASE}/api/health`, {
          cache: "no-store",
          credentials: "omit",
        });
        if (cancelledRef.current) return;
        if (res.ok) {
          const data = (await res.json()) as { status?: string; db?: string };
          // Only reload when the API + DB are both back. Half-up state would
          // bounce the user straight back into the offline screen.
          if (data.status === "ok" && data.db === "connected") {
            window.location.reload();
            return;
          }
        }
      } catch {
        // Network error / timeout — fall through to next attempt
      }
      if (!cancelledRef.current) setAttempt((n) => n + 1);
    }, delay);

    return () => clearTimeout(timer);
  }, [attempt, exhausted]);

  const elapsedMs = ATTEMPT_DELAYS_MS.slice(0, attempt).reduce((a, b) => a + b, 0);
  const elapsedSec = Math.round(elapsedMs / 1000);
  const totalSec = Math.round(TOTAL_BUDGET_MS / 1000);

  const retryNow = () => {
    setExhausted(false);
    setAttempt(0);
  };

  return (
    <main
      className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center"
      role="status"
      aria-live="polite"
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-600">
        Connection issue
      </p>
      <h1 className="mt-3 text-2xl font-semibold text-slate-900">
        {exhausted ? "Couldn't reach the API." : "Waking the API up…"}
      </h1>
      <p className="mt-3 text-sm leading-6 text-slate-500">
        {exhausted
          ? "Render free tier may be down. Your session is still saved — tap Retry to try again, or check Render."
          : `First request after idle wakes the server (≈${totalSec}s). Your session is still saved.`}
      </p>

      {!exhausted && (
        <div className="mt-5 flex items-center gap-3 text-xs text-slate-400">
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-sky-300 border-t-transparent"
          />
          <span className="tabular-nums">
            Attempt {attempt + 1} / {ATTEMPT_DELAYS_MS.length} · {elapsedSec}s elapsed
          </span>
        </div>
      )}

      {exhausted && (
        <button
          type="button"
          onClick={retryNow}
          className="mt-6 inline-flex min-h-11 items-center rounded-md bg-sky-500 px-5 text-sm font-semibold text-white transition hover:bg-sky-600"
        >
          Retry
        </button>
      )}
    </main>
  );
}
