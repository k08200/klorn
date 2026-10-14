"use client";

/**
 * The frame every Assistant hub page shares (productization plan P7): the
 * flag gate, the page width, and the section's own navigation. On a phone that
 * navigation is a row of tabs under the app header; from 768px the sidebar
 * lists the same four pages under Assistant, so the row is not repeated.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { useAuth } from "../../lib/auth";
import {
  ASSISTANT_ACTIVITY,
  ASSISTANT_APPROVALS,
  ASSISTANT_BRIEFING,
  ASSISTANT_CHAT,
  ASSISTANT_HUB,
  legacyRouteFor,
} from "../../lib/home";
import { useT } from "../../lib/i18n";
import { usePendingApprovals } from "../today/use-today-data";

export const HUB_PAGES = [
  { href: ASSISTANT_APPROVALS, labelKey: "nav.v2.approvals" },
  { href: ASSISTANT_BRIEFING, labelKey: "nav.briefing" },
  { href: ASSISTANT_ACTIVITY, labelKey: "nav.v2.activity" },
  { href: ASSISTANT_CHAT, labelKey: "nav.v2.chat" },
] as const;

const MAX_BADGE = 99;

export function HubGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const enabled = user?.unifiedHome === true;
  useEffect(() => {
    if (!user || enabled) return;
    router.replace(legacyRouteFor(pathname, window.location.search));
  }, [user, enabled, pathname, router]);
  // The bare hub route renders nothing of its own; its page redirects.
  if (!enabled) return null;
  if (pathname === ASSISTANT_HUB) return <>{children}</>;
  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col px-4 md:px-8">
      <HubTabs pathname={pathname} />
      {children}
    </div>
  );
}

function HubTabs({ pathname }: { pathname: string }) {
  const { t } = useT();
  const approvals = usePendingApprovals(true);
  const waiting = approvals.count ?? 0;
  return (
    <nav
      aria-label={t("assistantHub.nav.label")}
      className="sticky top-0 z-10 -mx-4 border-b border-line bg-surface-panel md:hidden"
    >
      <ul className="flex overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {HUB_PAGES.map((page) => {
          const current = pathname === page.href || pathname.startsWith(`${page.href}/`);
          const badge = page.href === ASSISTANT_APPROVALS && waiting > 0;
          return (
            <li key={page.href} className="shrink-0">
              <Link
                href={page.href}
                aria-current={current ? "page" : undefined}
                className={`focus-ring relative flex min-h-11 items-center gap-1.5 rounded-control px-3 text-label transition-colors duration-120 ease-fluid ${
                  current ? "text-ink" : "font-normal text-ink-mid hover:text-ink"
                }`}
              >
                {t(page.labelKey)}
                {badge && (
                  <span className="min-w-5 rounded-full bg-accent-solid px-1.5 text-center text-caption font-semibold tabular-nums text-accent-solid-ink">
                    <span aria-hidden="true">
                      {waiting > MAX_BADGE ? `${MAX_BADGE}+` : waiting}
                    </span>
                    <span className="sr-only">
                      {t("assistantHub.approvals.waiting", { count: String(waiting) })}
                    </span>
                  </span>
                )}
                {current && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent-solid"
                  />
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

interface HubHeaderProps {
  title: string;
  /** One line under the title: a count, a time, a date. */
  subtitle?: ReactNode;
  /** Right-aligned controls. */
  actions?: ReactNode;
}

export function HubHeader({ title, subtitle, actions }: HubHeaderProps) {
  return (
    <header className="flex flex-wrap items-start gap-x-4 gap-y-2 pb-4 pt-6 md:pt-8">
      <div className="min-w-0 flex-1">
        <h1 className="text-display text-ink [word-break:keep-all]">{title}</h1>
        {subtitle && (
          <p className="mt-1 text-body text-ink-muted [word-break:keep-all]">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function RefreshGlyph({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`size-4 ${spinning ? "motion-safe:animate-spin" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5V5H11" />
    </svg>
  );
}
