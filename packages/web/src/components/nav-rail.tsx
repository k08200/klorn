"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { useAuth } from "../lib/auth";
import { TODAY_HOME } from "../lib/home";
import { useT } from "../lib/i18n";
import { ACCOUNT_ROUTES, AccountSheet, isTabActive, shellTabs, userInitials } from "./bottom-tabs";
import { NavIcon } from "./nav-icons";
import NotificationBell from "./notification-bell";

/**
 * The navigation rail: 600px up to 840px (rail: … wide:hidden), between the
 * phone's bottom tab bar and the full sidebar — a Fold opened, a phone on
 * its side, an iPad in portrait or split view. The same destinations as the
 * tab bar, stacked down the left edge so the content keeps the full height;
 * the account button opens the tab bar's account sheet beside the rail.
 * 72px wide plus the left safe-area inset (a phone on its side puts the
 * notch here); every target is at least 44px. A phone on its side (under
 * 500px tall, the phone-landscape variant in globals.css) gets a 56px rail:
 * 44px icon targets, the labels kept for screen readers only, and the column
 * scrolls if the destinations ever outgrow the height.
 */
export default function NavRail() {
  const pathname = usePathname();
  const { t } = useT();
  const { user } = useAuth();
  const [accountOpen, setAccountOpen] = useState(false);
  const closeAccount = useCallback(() => setAccountOpen(false), []);
  const tabs = shellTabs(user);
  const unified = user?.unifiedHome === true;
  const initials = userInitials(user);
  const accountActive =
    accountOpen || ACCOUNT_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));

  return (
    <>
      <aside
        data-testid="nav-rail"
        className="hidden h-dvh w-[calc(72px+env(safe-area-inset-left))] shrink-0 flex-col items-center phone-landscape:w-[calc(56px+env(safe-area-inset-left))] phone-landscape:overflow-y-auto border-r border-line/70 bg-surface-panel/55 pb-safe pl-safe pt-safe backdrop-blur-xl rail:flex wide:hidden"
      >
        <div className="flex flex-col items-center gap-1 py-3 phone-landscape:gap-0 phone-landscape:py-1">
          <Link
            href={unified ? TODAY_HOME : "/inbox"}
            aria-label={unified ? t("nav.v2.openToday") : t("nav.v2.openApprovals")}
            className="focus-ring flex size-11 items-center justify-center rounded-control"
          >
            <img src="/brand/mark.svg?v=matte2" alt="" className="h-8 w-8" />
          </Link>
          {user && <NotificationBell userId={user.id} />}
        </div>

        <nav aria-label={t("bottomTabs.nav")} className="w-full px-1.5 phone-landscape:px-1">
          <ul className="flex flex-col gap-1 phone-landscape:gap-0.5">
            {tabs.map((tab) => {
              const active = isTabActive(pathname, tab);
              return (
                <li key={tab.labelKey}>
                  <Link
                    href={tab.href}
                    aria-current={active ? "page" : undefined}
                    className={`focus-ring flex min-h-14 flex-col items-center justify-center gap-1 rounded-control py-1.5 text-center text-role-caption leading-tight transition phone-landscape:min-h-11 phone-landscape:py-0 ${
                      active ? "text-accent-deep" : "text-ink-mid hover:text-ink"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`flex h-7 w-12 items-center justify-center rounded-chip transition phone-landscape:h-9 phone-landscape:w-10 ${
                        active ? "bg-state-info-bg" : ""
                      }`}
                    >
                      <NavIcon type={tab.icon} size={20} strokeWidth={active ? 2 : 1.6} />
                    </span>
                    <span
                      className={`max-w-full break-words phone-landscape:sr-only ${active ? "font-medium" : ""}`}
                    >
                      {t(tab.labelKey)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div aria-hidden="true" className="flex-1" />

        <div className="w-full px-1.5 pb-3 phone-landscape:px-1 phone-landscape:pb-1">
          <button
            type="button"
            onClick={() => setAccountOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={accountOpen}
            className={`focus-ring flex min-h-14 w-full flex-col items-center justify-center gap-1 rounded-control py-1.5 text-role-caption leading-tight transition phone-landscape:min-h-11 phone-landscape:py-0 ${
              accountActive ? "text-accent-deep" : "text-ink-mid hover:text-ink"
            }`}
          >
            <span
              aria-hidden="true"
              className={`flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-accent-solid to-accent-solid-hover text-role-caption font-bold text-accent-solid-ink ring-1 transition ${
                accountActive ? "ring-accent" : "ring-transparent"
              }`}
            >
              {initials || "?"}
            </span>
            <span className={`phone-landscape:sr-only ${accountActive ? "font-medium" : ""}`}>
              {t("tabs.account")}
            </span>
          </button>
        </div>
      </aside>
      {/* Outside the aside: its backdrop blur would otherwise become the
          containing block of the sheet's fixed backdrop. */}
      {accountOpen && <AccountSheet onClose={closeAccount} initials={initials} />}
    </>
  );
}
