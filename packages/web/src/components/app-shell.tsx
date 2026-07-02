"use client";

import { usePathname } from "next/navigation";
import { useAuth } from "../lib/auth";
import BottomTabs from "./bottom-tabs";
import Sidebar from "./sidebar";

const NO_SIDEBAR_ROUTES = [
  "/",
  "/login",
  "/auth/callback",
  "/reset-password",
  "/verify-email",
  "/privacy",
  "/terms",
  "/early-access",
  "/playground",
];

const APP_SHELL_ROUTES = [
  "/admin",
  "/billing",
  "/briefing",
  "/calendar",
  "/email",
  "/graph",
  "/inbox",
  "/settings",
];

function isAppShellRoute(pathname: string): boolean {
  return APP_SHELL_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

function currentSectionLabel(pathname: string): string {
  if (pathname === "/inbox" || pathname.startsWith("/inbox/")) return "Decision queue";
  if (pathname === "/graph" || pathname.startsWith("/graph/")) return "Graph";
  if (pathname === "/email" || pathname.startsWith("/email/")) return "Mail";
  if (pathname === "/calendar" || pathname.startsWith("/calendar/")) return "Calendar";
  if (pathname === "/briefing" || pathname.startsWith("/briefing/")) return "Briefing";
  if (pathname === "/billing" || pathname.startsWith("/billing/")) return "Plan and billing";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "Admin";
  if (pathname.startsWith("/settings")) return "Settings";
  return "Workspace";
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, loading } = useAuth();

  const showSidebar = !NO_SIDEBAR_ROUTES.includes(pathname) && isAppShellRoute(pathname);
  const sectionLabel = currentSectionLabel(pathname);

  if (!showSidebar) {
    return <>{children}</>;
  }

  if (loading) {
    return <SessionTransition label="Checking session" />;
  }

  if (!user) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-[#0f1115] text-stone-100">
      {/* Skip link (WCAG 2.4.1) — the first focusable element, hidden until a
          keyboard user tabs to it, so they can jump past the whole sidebar to
          the content on every route. */}
      <a
        href="#main"
        className="sr-only rounded-md bg-amber-300 px-4 py-2 text-sm font-semibold text-stone-950 focus-visible:not-sr-only focus-visible:absolute focus-visible:left-4 focus-visible:top-4 focus-visible:z-50"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile header — pt-safe respects iPhone notch in PWA. The hamburger
            is gone: the bottom tab bar + account sheet are the whole mobile nav. */}
        <div className="relative z-10 md:hidden flex items-center gap-3 px-4 h-12 pt-safe border-b border-stone-800 bg-[#111318]/95 backdrop-blur-xl shrink-0 box-content">
          <img src="/brand/mark.svg?v=matte2" alt="" className="h-6 w-6" />
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-none text-stone-100">Klorn</p>
            {/* The section name is redundant with each screen's large title, so
                it's visually hidden — kept in the DOM (sr-only) for screen
                readers and the navigation e2e checks. */}
            <p className="sr-only" data-testid="mobile-section-label">
              {sectionLabel}
            </p>
          </div>
        </div>
        <main
          id="main"
          tabIndex={-1}
          className="relative z-10 flex-1 overflow-y-auto pb-[calc(62px+env(safe-area-inset-bottom))] md:pb-safe focus:outline-none"
        >
          {children}
        </main>
        <BottomTabs />
      </div>
    </div>
  );
}

function SessionTransition({ label }: { label: string }) {
  return (
    <main
      id="main"
      className="flex min-h-dvh items-center justify-center bg-[#0f1115] px-6 text-stone-100"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <img src="/brand/mark.svg?v=matte2" alt="" className="h-10 w-10" />
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
        <p className="text-sm text-stone-400">{label}...</p>
      </div>
    </main>
  );
}
