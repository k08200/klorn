"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import NotificationBell from "./notification-bell";

const NAV_ITEMS = [
  { href: "/inbox", label: "Decision queue", icon: "check" },
  { href: "/graph", label: "Graph", icon: "graph" },
  { href: "/email", label: "Mail", icon: "mail" },
  { href: "/calendar", label: "Calendar", icon: "calendar" },
  { href: "/briefing", label: "Briefing", icon: "bell" },
];

// Routes that already have a bottom-tab on mobile — hidden in the mobile drawer
// to avoid duplicating the nav (the desktop sidebar still shows them).
const BOTTOM_TAB_HREFS = new Set(["/inbox", "/email", "/calendar", "/briefing"]);

function NavIcon({ type, size = 16 }: { type: string; size?: number }) {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (type) {
    case "mail":
      return (
        <svg aria-hidden="true" {...props}>
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
      );
    case "check":
      return (
        <svg aria-hidden="true" {...props}>
          <polyline points="9 11 12 14 22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      );
    case "calendar":
      return (
        <svg aria-hidden="true" {...props}>
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      );
    case "bell":
      return (
        <svg aria-hidden="true" {...props}>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
    case "graph":
      return (
        <svg aria-hidden="true" {...props}>
          <circle cx="5" cy="6" r="2" />
          <circle cx="19" cy="6" r="2" />
          <circle cx="12" cy="18" r="2" />
          <line x1="6.7" y1="7.3" x2="10.5" y2="16.4" />
          <line x1="17.3" y1="7.3" x2="13.5" y2="16.4" />
          <line x1="7" y1="6" x2="17" y2="6" />
        </svg>
      );
    case "settings":
      return (
        <svg aria-hidden="true" {...props}>
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    default:
      return null;
  }
}

export default function Sidebar({
  mobileOpen,
  onMobileClose,
}: {
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const pathname = usePathname();
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

  const sidebarContent = (
    <div className="relative flex h-full flex-col overflow-hidden border-r border-stone-800 bg-[#111318] pt-safe pb-safe">
      {/* Header */}
      <div className="relative flex items-center justify-between px-3 py-3">
        <Link
          href="/inbox"
          aria-label="Open decision queue"
          className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm font-semibold text-stone-100 transition hover:text-white"
          onClick={onMobileClose}
        >
          <img src="/brand/mark.svg?v=matte2" alt="" className="h-7 w-7" />
          <span>
            <span className="block leading-none">Klorn</span>
            <span className="mt-1 block text-[10px] font-medium uppercase tracking-[0.16em] text-stone-500">
              Decision queue
            </span>
          </span>
        </Link>
        <div className="flex items-center gap-1">
          {user && <NotificationBell userId={user.id} />}
        </div>
      </div>

      {/* Spacer pushes nav to the bottom on desktop. On the mobile drawer that
          leaves a huge empty void with the nav crammed at the bottom, so drop it
          below md — nav then sits directly under the header. */}
      <div aria-hidden="true" className="hidden flex-1 md:block" />

      {/* Workspace nav */}
      <div className="relative border-t border-stone-800 px-2 py-2">
        <div className="space-y-0.5">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={onMobileClose}
              // The bottom tab bar already covers these on mobile, so hide the
              // duplicates in the drawer below md (desktop sidebar keeps them —
              // it's the only nav there).
              className={`${BOTTOM_TAB_HREFS.has(item.href) ? "hidden md:flex" : "flex"} items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition ${
                pathname.startsWith(item.href)
                  ? "bg-stone-800 text-stone-100"
                  : "text-stone-500 hover:bg-stone-800/70 hover:text-stone-300"
              }`}
            >
              <NavIcon type={item.icon} size={14} />
              <span className="flex-1">{item.label}</span>
            </Link>
          ))}
          {user?.role === "ADMIN" && (
            <Link
              href="/admin"
              onClick={onMobileClose}
              className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition ${
                pathname.startsWith("/admin")
                  ? "bg-stone-800/80 text-white"
                  : "text-stone-500 hover:bg-stone-800/50 hover:text-stone-300"
              }`}
            >
              <NavIcon type="settings" size={14} />
              Admin
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
                  onClick={() => {
                    setShowUserMenu(false);
                    onMobileClose();
                  }}
                  className="block px-3 py-2 text-sm text-stone-300 hover:bg-stone-800 rounded-md mx-1 transition"
                >
                  Settings
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
                  Log out
                </button>
              </div>
            )}
          </div>
        ) : (
          <Link
            href="/login"
            className="flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm text-stone-400 hover:bg-stone-800/50 hover:text-white transition"
          >
            Log in
          </Link>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:block w-[260px] h-dvh shrink-0 sticky top-0">
        {sidebarContent}
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40 md:hidden" onClick={onMobileClose} />
          <aside className="fixed inset-y-0 left-0 w-[280px] max-w-[85vw] z-50 md:hidden animate-slide-in-left pl-safe">
            {sidebarContent}
          </aside>
        </>
      )}
    </>
  );
}
