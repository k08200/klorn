"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { NavIcon, type NavIconType } from "./nav-icons";
import NotificationBell from "./notification-bell";

// Desktop-only workspace nav. On mobile the bottom tab bar (+ account sheet)
// is the whole navigation, so this sidebar renders `hidden md:block` and there
// is no mobile drawer anymore. Labels resolve via t() inside the component.
const NAV_ITEMS: { href: string; labelKey: string; icon: NavIconType }[] = [
  { href: "/inbox", labelKey: "nav.decisionQueue", icon: "check" },
  { href: "/email", labelKey: "nav.mail", icon: "mail" },
  { href: "/calendar", labelKey: "nav.calendar", icon: "calendar" },
  { href: "/briefing", labelKey: "nav.briefing", icon: "bell" },
  { href: "/chat", labelKey: "nav.assistant", icon: "chat" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { t } = useT();
  const { user, logout, loading: authLoading } = useAuth();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

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
      <div className="relative flex h-full flex-col overflow-hidden border-r border-stone-800 bg-[#111318] pt-safe pb-safe">
        {/* Header */}
        <div className="relative flex items-center justify-between px-3 py-3">
          <Link
            href="/inbox"
            aria-label="Open decision queue"
            className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm font-semibold text-stone-100 transition hover:text-white"
          >
            <img src="/brand/mark.svg?v=matte2" alt="" className="h-7 w-7" />
            <span>
              <span className="block leading-none">Klorn</span>
              <span className="mt-1 block text-[10px] font-medium uppercase tracking-[0.16em] text-stone-500">
                {t("nav.decisionQueue")}
              </span>
            </span>
          </Link>
          <div className="flex items-center gap-1">
            {user && <NotificationBell userId={user.id} />}
          </div>
        </div>

        {/* Spacer pushes nav + user to the bottom on desktop. */}
        <div aria-hidden="true" className="flex-1" />

        {/* Workspace nav */}
        <div className="relative border-t border-stone-800 px-2 py-2">
          <div className="space-y-0.5">
            {NAV_ITEMS.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`focus-ring flex min-h-11 items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition ${
                    active
                      ? "bg-accent/10 text-accent"
                      : "text-stone-400 hover:bg-stone-800/70 hover:text-stone-300"
                  }`}
                >
                  <NavIcon type={item.icon} size={14} />
                  <span className="flex-1">{t(item.labelKey)}</span>
                </Link>
              );
            })}
            {user?.role === "ADMIN" && (
              <Link
                href="/admin"
                aria-current={pathname.startsWith("/admin") ? "page" : undefined}
                className={`focus-ring flex min-h-11 items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition ${
                  pathname.startsWith("/admin")
                    ? "bg-accent/10 text-accent"
                    : "text-stone-400 hover:bg-stone-800/50 hover:text-stone-300"
                }`}
              >
                <NavIcon type="settings" size={14} />
                {t("nav.admin")}
              </Link>
            )}
          </div>
        </div>

        {/* User */}
        <div className="border-t border-stone-800/40 p-2" ref={userMenuRef}>
          {authLoading ? (
            <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
              <div className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-stone-800" />
              <div className="h-3 w-24 animate-pulse rounded bg-stone-800" />
            </div>
          ) : user ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowUserMenu((p) => !p)}
                className="w-full flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-stone-800/50 transition text-left"
              >
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-amber-300 to-stone-700 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-stone-300 truncate">{user.name || user.email}</p>
                </div>
                <svg
                  aria-hidden="true"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-stone-500 shrink-0"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              {showUserMenu && (
                <div className="absolute bottom-full left-0 right-0 mb-1 bg-stone-900 border border-stone-700 rounded-xl shadow-2xl shadow-black/60 z-50 py-1 animate-slide-up">
                  <Link
                    href="/settings"
                    onClick={() => setShowUserMenu(false)}
                    className="block px-3 py-2 text-sm text-stone-300 hover:bg-stone-800 rounded-md mx-1 transition"
                  >
                    {t("settings.title")}
                  </Link>
                  <div className="border-t border-stone-800 my-1" />
                  <button
                    type="button"
                    onClick={() => {
                      setShowUserMenu(false);
                      logout();
                    }}
                    className="w-[calc(100%-0.5rem)] text-left px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 rounded-md mx-1 transition"
                  >
                    {t("nav.logout")}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Link
              href="/login"
              className="flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm text-stone-400 hover:bg-stone-800/50 hover:text-white transition"
            >
              {t("nav.logIn")}
            </Link>
          )}
        </div>
      </div>
    </aside>
  );
}
