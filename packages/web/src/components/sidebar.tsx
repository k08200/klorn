"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  ASSISTANT_ACTIVITY,
  ASSISTANT_APPROVALS,
  ASSISTANT_BRIEFING,
  ASSISTANT_CHAT,
  ASSISTANT_ROUTES,
  assistantHref,
  TODAY_HOME,
} from "../lib/home";
import { useT } from "../lib/i18n";
import { NavIcon, type NavIconType } from "./nav-icons";
import NotificationBell from "./notification-bell";
import SidebarAccounts from "./sidebar-accounts";

// Live nav counts — server truth, cheap, and shared with the pages' own
// caches where the keys overlap. Only rendered when > 0 so the rail never
// shows a fake zero.
function useNavCounts(enabled: boolean) {
  const pendingQuery = useQuery({
    queryKey: ["sidebar", "pending-decisions"],
    queryFn: async () => {
      const data = await apiFetch<{ actions: unknown[] }>("/api/chat/pending-actions");
      return Array.isArray(data.actions) ? data.actions.length : 0;
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const replyQuery = useQuery({
    queryKey: ["sidebar", "reply-needed-total"],
    queryFn: async () => {
      const data = await apiFetch<{ total?: number }>("/api/email?filter=reply-needed&page=1");
      return typeof data.total === "number" ? data.total : 0;
    },
    enabled,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  // Real-time WS push announces new mail — refresh both counts on that signal
  // so the rail stays honest without tightening the poll.
  const refetchPending = pendingQuery.refetch;
  const refetchReply = replyQuery.refetch;
  useEffect(() => {
    if (!enabled) return;
    const handler = () => {
      void refetchPending();
      void refetchReply();
    };
    window.addEventListener("conversations-updated", handler);
    return () => window.removeEventListener("conversations-updated", handler);
  }, [enabled, refetchPending, refetchReply]);

  return {
    "/inbox": pendingQuery.data ?? 0,
    // UNIFIED_HOME: the same count sits on Assistant, which opens Approvals.
    [ASSISTANT_APPROVALS]: pendingQuery.data ?? 0,
    "/email": replyQuery.data ?? 0,
  } as Record<string, number>;
}

function NavCountBadge({ count, active }: { count: number; active: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
        active ? "bg-accent-solid text-accent-solid-ink shadow-sm" : "bg-surface-hover text-ink-mid"
      }`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

// Desktop-only workspace nav. On mobile the bottom tab bar (+ account sheet)
// is the whole navigation, so this sidebar renders `hidden md:block` and there
// is no mobile drawer anymore. Labels resolve via t() inside the component.
interface NavItem {
  href: string;
  labelKey: string;
  icon: NavIconType;
  /** Routes that light this item up; defaults to its own href. */
  routes?: readonly string[];
  /** Secondary links shown under the item. */
  children?: readonly { href: string; labelKey: string }[];
}

const NAV_ITEMS: NavItem[] = [
  { href: "/inbox", labelKey: "nav.decisionQueue", icon: "check" },
  { href: "/email", labelKey: "nav.mail", icon: "mail" },
  { href: "/calendar", labelKey: "nav.calendar", icon: "calendar" },
  { href: "/briefing", labelKey: "nav.briefing", icon: "bell" },
];

// UNIFIED_HOME (productization plan §1, P6/P7): Today · Mail · Calendar ·
// Assistant. Files joins only once a drive source exists (FD-7). Assistant
// opens the hub's Approvals page; the hub's four pages sit under it, which is
// the hub's own navigation at this width.
const UNIFIED_NAV_ITEMS: NavItem[] = [
  { href: TODAY_HOME, labelKey: "nav.v2.today", icon: "today" },
  { href: "/email", labelKey: "nav.mail", icon: "mail" },
  { href: "/calendar", labelKey: "nav.calendar", icon: "calendar" },
  {
    href: assistantHref(),
    labelKey: "nav.assistant",
    icon: "chat",
    routes: ASSISTANT_ROUTES,
    children: [
      { href: ASSISTANT_APPROVALS, labelKey: "nav.v2.approvals" },
      { href: ASSISTANT_BRIEFING, labelKey: "nav.briefing" },
      { href: ASSISTANT_ACTIVITY, labelKey: "nav.v2.activity" },
      { href: ASSISTANT_CHAT, labelKey: "nav.v2.chat" },
    ],
  },
];

function isOnRoute(pathname: string, routes: readonly string[]): boolean {
  return routes.some((route) => pathname.startsWith(route));
}

export default function Sidebar() {
  const pathname = usePathname();
  const { t } = useT();
  const { user, logout, loading: authLoading, googleConnected } = useAuth();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const navCounts = useNavCounts(!!user);
  const unified = user?.unifiedHome === true;
  const navItems = unified ? UNIFIED_NAV_ITEMS : NAV_ITEMS;

  // Close user menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const initials = user
    ? (user.name || user.email)
        .split(/[\s@]/)
        .filter(Boolean)
        .slice(0, 2)
        .map((s) => s[0].toUpperCase())
        .join("")
    : "";

  return (
    <aside className="hidden md:block w-[260px] h-dvh shrink-0 sticky top-0">
      <div className="relative flex h-full flex-col overflow-hidden border-r border-line/70 bg-surface-panel/55 backdrop-blur-xl pt-safe pb-safe">
        {/* Header */}
        <div className="relative flex items-center justify-between px-3 py-4">
          <Link
            href={unified ? TODAY_HOME : "/inbox"}
            aria-label={unified ? t("nav.v2.openToday") : "Open decision queue"}
            className="flex items-center gap-2.5 rounded-lg px-1 py-1 text-sm font-semibold text-ink transition hover:text-ink"
          >
            <img src="/brand/mark.svg?v=matte2" alt="" className="h-8 w-8" />
            <span>
              <span className="block text-[15px] leading-none tracking-tight">Klorn</span>
              {/* The home is Today under UNIFIED_HOME, so the wordmark carries
                  no surface name. */}
              {!unified && (
                <span className="mt-1.5 block text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-dim">
                  {t("nav.decisionQueue")}
                </span>
              )}
            </span>
          </Link>
          <div className="flex items-center gap-1">
            {user && <NotificationBell userId={user.id} />}
          </div>
        </div>

        {/* Workspace nav — top-anchored so the first glance lands on where you
            can go, not on empty space. */}
        <div className="relative px-2 pt-2">
          <div className="space-y-0.5">
            {navItems.map((item) => {
              const active = isOnRoute(pathname, item.routes ?? [item.href]);
              return (
                <Link
                  key={item.labelKey}
                  href={item.href}
                  // A section with links under it is highlighted, but the
                  // current page is the link below it, not the section.
                  aria-current={active && !item.children ? "page" : undefined}
                  className={`focus-ring relative flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition ${
                    active
                      ? "bg-state-info-bg font-medium text-accent-deeper shadow-[0_1px_2px_rgba(2,60,110,0.06)] ring-1 ring-inset ring-accent-dim"
                      : "text-ink-mid hover:bg-surface-hover/70 hover:text-ink"
                  }`}
                >
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-accent"
                    />
                  )}
                  <NavIcon type={item.icon} size={16} />
                  <span className="flex-1">{t(item.labelKey)}</span>
                  <NavCountBadge count={navCounts[item.href] ?? 0} active={active} />
                </Link>
              );
            })}
            {navItems.map((item) =>
              item.children ? (
                <ul key={`${item.labelKey}.children`} className="space-y-0.5 pl-7">
                  {item.children.map((child) => {
                    const current = pathname.startsWith(child.href);
                    return (
                      <li key={child.href}>
                        <Link
                          href={child.href}
                          aria-current={current ? "page" : undefined}
                          className={`focus-ring flex min-h-10 items-center rounded-lg px-3 py-1.5 text-label transition-colors duration-120 ease-fluid ${
                            current
                              ? "text-ink"
                              : "font-normal text-ink-mid hover:bg-surface-hover/70 hover:text-ink"
                          }`}
                        >
                          {t(child.labelKey)}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : null,
            )}
            {user?.role === "ADMIN" && (
              <Link
                href="/admin"
                aria-current={pathname.startsWith("/admin") ? "page" : undefined}
                className={`focus-ring relative flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition ${
                  pathname.startsWith("/admin")
                    ? "bg-state-info-bg font-medium text-accent-deeper shadow-[0_1px_2px_rgba(2,60,110,0.06)] ring-1 ring-inset ring-accent-dim"
                    : "text-ink-mid hover:bg-surface-hover/70 hover:text-ink"
                }`}
              >
                {pathname.startsWith("/admin") && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-accent"
                  />
                )}
                <NavIcon type="settings" size={16} />
                {t("nav.admin")}
              </Link>
            )}
          </div>
        </div>

        {/* Connected accounts and their health — a status list, never a
            switcher (FD-2). */}
        {unified && user && <SidebarAccounts />}

        {/* Spacer pushes the account card to the bottom. */}
        <div aria-hidden="true" className="flex-1" />

        {/* Real-time status — only shown when Google is actually connected
            (the Gmail watch auto-registers on connect), so this is a true
            statement, not decoration. Under UNIFIED_HOME the Accounts group
            above states each account's health instead. */}
        {user && googleConnected === true && !unified && (
          <div className="mx-2 mb-2 rounded-xl border border-state-info-line bg-state-info-bg p-3 shadow-[0_1px_2px_rgba(2,60,110,0.05)]">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-state-info-ink">
              <span aria-hidden="true" className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:animate-none" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              Real-time on
            </div>
            <p className="mt-1 text-[11px] leading-4 text-ink-mid">
              New mail lands in seconds — no refresh.
            </p>
          </div>
        )}

        {/* User */}
        <div className="border-t border-line/70 p-2" ref={userMenuRef}>
          {authLoading ? (
            <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-surface-hover" />
              <div className="h-3 w-24 animate-pulse rounded bg-surface-hover" />
            </div>
          ) : user ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowUserMenu((p) => !p)}
                className="w-full flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-surface-hover/70 transition text-left"
              >
                <div className="avatar-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-solid to-accent-solid-hover text-[11px] font-bold text-accent-solid-ink">
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink">
                    {user.name || user.email}
                  </p>
                  {user.name && <p className="truncate text-[11px] text-ink-dim">{user.email}</p>}
                </div>
                <svg
                  aria-hidden="true"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-ink-dim shrink-0"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              {showUserMenu && (
                <div className="absolute bottom-full left-0 right-0 mb-1 bg-surface-panel border border-line rounded-xl shadow-xl shadow-slate-900/10 z-50 py-1 animate-slide-up">
                  <Link
                    href="/billing"
                    onClick={() => setShowUserMenu(false)}
                    className="block px-3 py-2 text-sm text-ink-mid hover:bg-surface-hover rounded-md mx-1 transition"
                  >
                    {t("nav.billing")}
                  </Link>
                  <Link
                    href="/usage"
                    onClick={() => setShowUserMenu(false)}
                    className="block px-3 py-2 text-sm text-ink-mid hover:bg-surface-hover rounded-md mx-1 transition"
                  >
                    {t("nav.usage")}
                  </Link>
                  <Link
                    href="/settings"
                    onClick={() => setShowUserMenu(false)}
                    className="block px-3 py-2 text-sm text-ink-mid hover:bg-surface-hover rounded-md mx-1 transition"
                  >
                    {t("settings.title")}
                  </Link>
                  <div className="border-t border-line my-1" />
                  <button
                    type="button"
                    onClick={() => {
                      setShowUserMenu(false);
                      logout();
                    }}
                    className="w-[calc(100%-0.5rem)] text-left px-3 py-2 text-sm text-state-danger-ink hover:bg-red-500/10 rounded-md mx-1 transition"
                  >
                    {t("nav.logout")}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Link
              href="/login"
              className="flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-mid hover:bg-surface-hover hover:text-ink transition"
            >
              {t("nav.logIn")}
            </Link>
          )}
        </div>
      </div>
    </aside>
  );
}
