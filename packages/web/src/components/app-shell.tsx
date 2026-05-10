"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
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
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const showSidebar = !NO_SIDEBAR_ROUTES.includes(pathname);

  if (!showSidebar) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-[#10100d] text-stone-100">
      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(217,119,6,0.14),transparent_30%),radial-gradient(circle_at_88%_12%,rgba(20,184,166,0.12),transparent_28%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:48px_48px]" />
        {/* Mobile header — pt-safe respects iPhone notch in PWA */}
        <div className="relative z-10 md:hidden flex items-center gap-3 px-4 h-12 pt-safe border-b border-stone-700/40 bg-[#10100d]/90 backdrop-blur-xl shrink-0 box-content">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="flex items-center justify-center min-w-[44px] min-h-[44px] -ml-2 text-stone-400 hover:text-white active:text-white transition"
            aria-label="Menu"
          >
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <img src="/brand/mark.svg" alt="" className="h-6 w-6" />
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-none text-stone-100">EVE</p>
            <p className="mt-0.5 text-[10px] leading-none text-stone-500">Decision OS</p>
          </div>
        </div>
        <main className="relative z-10 flex-1 overflow-y-auto pb-[calc(62px+env(safe-area-inset-bottom))] md:pb-safe">
          {children}
        </main>
        <BottomTabs />
      </div>
    </div>
  );
}
