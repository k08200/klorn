"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "../lib/auth";

/** Redirects to /login if user is not authenticated. Wraps protected pages. */
export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading, authError } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (authError === "api_unavailable") return;
    if (!loading && !user) {
      const query = typeof window !== "undefined" ? window.location.search.slice(1) : "";
      const next = `${pathname}${query ? `?${query}` : ""}`;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [user, loading, authError, pathname, router]);

  if (loading) {
    return (
      <main
        className="flex items-center justify-center min-h-[calc(100vh-3.5rem)]"
        role="status"
        aria-live="polite"
      >
        <div
          className="w-6 h-6 border-2 border-amber-300 border-t-transparent rounded-full animate-spin"
          aria-hidden="true"
        />
        <span className="sr-only">Checking session...</span>
      </main>
    );
  }

  if (authError === "api_unavailable") {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-300">
          Connection issue
        </p>
        <h1 className="mt-3 text-2xl font-semibold text-stone-50">Klorn API is offline.</h1>
        <p className="mt-3 text-sm leading-6 text-stone-400">
          Your session is still saved. Start the API service, then retry this screen.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 inline-flex min-h-11 items-center rounded-md bg-amber-300 px-5 text-sm font-semibold text-stone-950 transition hover:bg-amber-200"
        >
          Retry
        </button>
      </main>
    );
  }

  if (!user) return null;

  return <>{children}</>;
}
