"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "../lib/auth";
import { homePath, landingStep, TODAY_HOME, takeLegacyLanding } from "../lib/home";
import { useT } from "../lib/i18n";
import AssistantDock from "./assistant-dock";
import BottomTabs from "./bottom-tabs";
import IosInstallHint from "./ios-install-hint";
import ShellSkeleton from "./shell-skeleton";
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
  "/assistant",
  "/billing",
  "/briefing",
  "/calendar",
  "/chat",
  "/email",
  "/files",
  "/graph",
  "/inbox",
  "/settings",
  "/today",
  "/usage",
];

const DOCKLESS_ROUTES = ["/chat", "/assistant"];

function isAppShellRoute(pathname: string): boolean {
  return APP_SHELL_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

// Returns an i18n key — the component resolves it via t(). `unified` is the
// UNIFIED_HOME vocabulary: the approvals page is "Approvals", not a queue.
function currentSectionLabelKey(pathname: string, unified: boolean): string {
  if (pathname === "/today") return "nav.v2.today";
  if (pathname === "/assistant" || pathname.startsWith("/assistant/")) return "nav.assistant";
  if (pathname === "/inbox" || pathname.startsWith("/inbox/")) {
    return unified ? "nav.v2.approvals" : "nav.decisionQueue";
  }
  if (pathname === "/graph" || pathname.startsWith("/graph/")) return "nav.graph";
  if (pathname === "/email" || pathname.startsWith("/email/")) return "nav.mail";
  if (pathname === "/calendar" || pathname.startsWith("/calendar/")) return "nav.calendar";
  if (pathname === "/files" || pathname.startsWith("/files/")) return "nav.files";
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
  const router = useRouter();

  // UNIFIED_HOME: a visitor the root redirect (or the native sign-in) sent to
  // the legacy home before the server had answered is moved on to Today once
  // it has. Only a marked landing moves — opening /inbox on purpose does not,
  // and the mark is dropped as soon as the visitor is on any other route
  // (see landingStep).
  const unifiedHome = user?.unifiedHome === true;
  const userLoaded = user !== null;
  useEffect(() => {
    const step = landingStep(pathname, userLoaded);
    if (step === "wait") return;
    const marked = takeLegacyLanding();
    if (step === "resolve" && marked && unifiedHome) router.replace(TODAY_HOME);
  }, [userLoaded, unifiedHome, pathname, router]);

  const showSidebar = !NO_SIDEBAR_ROUTES.includes(pathname) && isAppShellRoute(pathname);
  const sectionLabel = t(currentSectionLabelKey(pathname, user?.unifiedHome === true));

  if (!showSidebar) {
    return <>{children}</>;
  }

  if (loading) {
    return <ShellSkeleton label={t("appShell.checkingSession")} />;
  }

  if (!user) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-surface-panel text-ink">
      {/* Skip link (WCAG 2.4.1) — the first focusable element, hidden until a
          keyboard user tabs to it, so they can jump past the whole sidebar to
          the content on every route. */}
      <a
        href="#main"
        className="sr-only rounded-md bg-accent-solid px-4 py-2 text-sm font-semibold text-accent-solid-ink focus-visible:not-sr-only focus-visible:absolute focus-visible:left-4 focus-visible:top-4 focus-visible:z-50"
      >
        {t("appShell.skipToContent")}
      </a>
      <Sidebar />
      <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile header — pt-safe respects iPhone notch in PWA. The hamburger
            is gone: the bottom tab bar + account sheet are the whole mobile nav. */}
        <div className="relative z-10 md:hidden flex items-center gap-3 px-4 h-12 pt-safe border-b border-line bg-surface-panel/95 backdrop-blur-xl shrink-0 box-content">
          <img src="/brand/mark.svg?v=matte2" alt="" className="h-6 w-6" />
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-none text-ink">Klorn</p>
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
          // Phone: clear the 62px tab bar AND the assistant button above it
          // (W7: 72px + the home-indicator inset), so the last row is never
          // under the button.
          className="relative z-10 flex-1 overflow-y-auto pb-[calc(62px+72px+env(safe-area-inset-bottom))] md:pb-[env(safe-area-inset-bottom)] focus:outline-none"
        >
          {/* Inline, so it pushes content down rather than covering it; only on
              the home screen and Settings, where installing is on-topic. */}
          {(pathname === homePath(user) || pathname.startsWith("/settings")) && <IosInstallHint />}
          {children}
        </main>
        <BottomTabs />
      </div>
      {/* Global assistant — bottom-right on every app surface. The chat page
          and the whole assistant hub (W7) are the assistant already, so the
          dock stays out of the way there. */}
      {!DOCKLESS_ROUTES.some((route) => pathname.startsWith(route)) && (
        <AssistantDock unified={unifiedHome} />
      )}
    </div>
  );
}
