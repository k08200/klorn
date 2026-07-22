"use client";

import { usePathname } from "next/navigation";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
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
  "/chat",
  "/email",
  "/graph",
  "/inbox",
  "/settings",
];

function isAppShellRoute(pathname: string): boolean {
  return APP_SHELL_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

// Returns an i18n key — the component resolves it via t().
function currentSectionLabelKey(pathname: string): string {
  if (pathname === "/inbox" || pathname.startsWith("/inbox/")) return "nav.decisionQueue";
  if (pathname === "/graph" || pathname.startsWith("/graph/")) return "nav.graph";
  if (pathname === "/email" || pathname.startsWith("/email/")) return "nav.mail";
  if (pathname === "/calendar" || pathname.startsWith("/calendar/")) return "nav.calendar";
  if (pathname === "/briefing" || pathname.startsWith("/briefing/")) return "nav.briefing";
  if (pathname === "/chat" || pathname.startsWith("/chat/")) return "nav.assistant";
  if (pathname === "/billing" || pathname.startsWith("/billing/")) return "nav.billing";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "nav.admin";
  if (pathname.startsWith("/settings")) return "settings.title";
  return "nav.workspace";
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t } = useT();
  const { user, loading } = useAuth();

  const showSidebar = !NO_SIDEBAR_ROUTES.includes(pathname) && isAppShellRoute(pathname);
  const sectionLabel = t(currentSectionLabelKey(pathname));

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
    <div className="flex h-dvh overflow-hidden bg-white text-slate-900">
      {/* Skip link (WCAG 2.4.1) — the first focusable element, hidden until a
          keyboard user tabs to it, so they can jump past the whole sidebar to
          the content on every route. */}
      <a
        href="#main"
        className="sr-only rounded-md bg-sky-500 px-4 py-2 text-sm font-semibold text-white focus-visible:not-sr-only focus-visible:absolute focus-visible:left-4 focus-visible:top-4 focus-visible:z-50"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile header — pt-safe respects iPhone notch in PWA. The hamburger
            is gone: the bottom tab bar + account sheet are the whole mobile nav. */}
        <div className="relative z-10 md:hidden flex items-center gap-3 px-4 h-12 pt-safe border-b border-slate-200 bg-white/95 backdrop-blur-xl shrink-0 box-content">
          <img src="/brand/mark.svg?v=matte2" alt="" className="h-6 w-6" />
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-none text-slate-900">Klorn</p>
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
      className="flex min-h-dvh items-center justify-center bg-white px-6 text-slate-900"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <img src="/brand/mark.svg?v=matte2" alt="" className="h-10 w-10" />
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-sky-300 border-t-transparent" />
        <p className="text-sm text-slate-500">{label}...</p>
      </div>
    </main>
  );
}
