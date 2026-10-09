"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { ASSISTANT_ROUTES, assistantHref, TODAY_HOME } from "../lib/home";
import { useT } from "../lib/i18n";
import { NavIcon, type NavIconType } from "./nav-icons";

interface Tab {
  href: string;
  labelKey: string;
  icon: NavIconType;
  /** Routes that light this tab up; defaults to its own href. */
  routes?: readonly string[];
}

// Labels resolve via t() inside the component.
const TABS: Tab[] = [
  { href: "/inbox", labelKey: "tabs.queue", icon: "inbox" },
  { href: "/email", labelKey: "nav.mail", icon: "mail" },
  { href: "/calendar", labelKey: "nav.calendar", icon: "calendar" },
  { href: "/briefing", labelKey: "nav.briefing", icon: "bell" },
];

// UNIFIED_HOME (productization plan §1, P6): Today · Mail · Calendar ·
// Assistant. Files joins only once a drive source exists (FD-7).
const UNIFIED_TABS: Tab[] = [
  { href: TODAY_HOME, labelKey: "nav.v2.today", icon: "today" },
  { href: "/email", labelKey: "nav.mail", icon: "mail" },
  { href: "/calendar", labelKey: "nav.calendar", icon: "calendar" },
  { href: assistantHref(), labelKey: "nav.assistant", icon: "chat", routes: ASSISTANT_ROUTES },
];

// Routes the account sheet owns — the account tab reads as "active" on these so
// the bottom bar still reflects where you are after tapping through the sheet.
const ACCOUNT_ROUTES = ["/settings", "/admin"];

export default function BottomTabs() {
  const pathname = usePathname();
  const { t } = useT();
  const { user } = useAuth();
  const [accountOpen, setAccountOpen] = useState(false);
  // Stable identity so the sheet's focus/Escape effect doesn't re-run on every
  // parent re-render (AuthProvider hands a fresh context value each render).
  const closeAccount = useCallback(() => setAccountOpen(false), []);
  const unified = user?.unifiedHome === true;
  const tabs = unified ? UNIFIED_TABS : TABS;

  const accountActive = ACCOUNT_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));

  const initials = user
    ? (user.name || user.email)
        .split(/[\s@]/)
        .filter(Boolean)
        .slice(0, 2)
        .map((s) => s[0]?.toUpperCase() ?? "")
        .join("")
    : "";

  return (
    <>
      <nav
        aria-label="Primary navigation"
        className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-line bg-surface-panel/92 pb-safe shadow-[0_-16px_44px_rgba(0,0,0,0.35)] backdrop-blur-xl"
      >
        <ul className={unified ? "grid grid-cols-5" : "grid grid-cols-6"}>
          {tabs.map((tab) => {
            const active = (tab.routes ?? [tab.href]).some((route) => isActive(pathname, route));
            return (
              <li key={tab.labelKey}>
                <Link
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={`focus-ring flex min-h-[62px] flex-col items-center justify-center gap-1 py-2 text-[10px] transition ${
                    active ? "text-accent-deep" : "text-ink-mid"
                  }`}
                >
                  <NavIcon type={tab.icon} size={22} strokeWidth={active ? 2 : 1.6} />
                  <span className={active ? "font-medium" : ""}>{t(tab.labelKey)}</span>
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setAccountOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={accountOpen}
              className={`focus-ring flex w-full min-h-[62px] flex-col items-center justify-center gap-1 py-2 text-[10px] transition ${
                accountActive || accountOpen ? "text-accent-deep" : "text-ink-mid"
              }`}
            >
              <span
                aria-hidden="true"
                className={`flex h-[22px] w-[22px] items-center justify-center rounded-full bg-gradient-to-br from-accent-solid to-accent-solid-hover text-[9px] font-bold text-accent-solid-ink ring-1 transition ${
                  accountActive || accountOpen ? "ring-accent" : "ring-transparent"
                }`}
              >
                {initials || "?"}
              </span>
              <span className={accountActive || accountOpen ? "font-medium" : ""}>
                {t("tabs.account")}
              </span>
            </button>
          </li>
        </ul>
      </nav>

      {accountOpen && <AccountSheet onClose={closeAccount} initials={initials} />}
    </>
  );
}

function AccountSheet({ onClose, initials }: { onClose: () => void; initials: string }) {
  const { t } = useT();
  const { user, logout } = useAuth();
  const sheetRef = useRef<HTMLDivElement>(null);

  // Close on Escape, move focus into the sheet on open (restore on unmount), and
  // trap Tab focus inside the dialog so keyboard/SR users can't wander into the
  // dimmed page behind the backdrop while it claims aria-modal.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const focusables = sheet.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === first || activeEl === sheet)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  const isAdmin = user?.role === "ADMIN";

  return (
    <div className="md:hidden fixed inset-0 z-50">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close account menu"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      {/* Sheet */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Account and settings"
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 animate-slide-up rounded-t-2xl border-t border-line bg-surface-panel pb-safe shadow-2xl shadow-slate-900/15 focus:outline-none"
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-300" aria-hidden="true" />

        {user && (
          <div className="flex items-center gap-3 px-5 py-4">
            <span
              aria-hidden="true"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-accent-solid to-accent-solid-hover text-xs font-bold text-accent-solid-ink"
            >
              {initials || "?"}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{user.name || user.email}</p>
              {user.name && <p className="truncate text-xs text-ink-dim">{user.email}</p>}
            </div>
          </div>
        )}

        <div className="border-t border-line px-2 py-2">
          <SheetLink
            href="/settings"
            icon="settings"
            label={t("settings.title")}
            onNavigate={onClose}
          />
          {isAdmin && (
            <SheetLink href="/admin" icon="settings" label={t("nav.admin")} onNavigate={onClose} />
          )}
          <button
            type="button"
            onClick={() => {
              onClose();
              logout();
            }}
            className="focus-ring flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-state-danger-ink transition hover:bg-red-500/10"
          >
            <span className="flex h-5 w-5 items-center justify-center" aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </span>
            {t("nav.logout")}
          </button>
        </div>
      </div>
    </div>
  );
}

function SheetLink({
  href,
  icon,
  label,
  onNavigate,
}: {
  href: string;
  icon: NavIconType;
  label: string;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className="focus-ring flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-ink transition hover:bg-surface-hover"
    >
      <span className="flex h-5 w-5 items-center justify-center text-ink-mid" aria-hidden="true">
        <NavIcon type={icon} size={16} />
      </span>
      {label}
    </Link>
  );
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
