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
    <div className="flex h-dvh overflow-hidden bg-[#0f1115] text-stone-100">
      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile header — pt-safe respects iPhone notch in PWA */}
        <div className="relative z-10 md:hidden flex items-center gap-3 px-4 h-12 pt-safe border-b border-stone-800 bg-[#111318]/95 backdrop-blur-xl shrink-0 box-content">
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
          <img src="/brand/mark.svg?v=flow-5" alt="" className="h-6 w-6" />
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-none text-stone-100">Jigeum</p>
            <p className="mt-0.5 text-[10px] leading-none text-stone-500">Decision queue</p>
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
