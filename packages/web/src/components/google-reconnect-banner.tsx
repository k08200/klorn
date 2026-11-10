"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";

/**
 * The primary Google grant died and the user is still inside the app.
 *
 * This happens without any action on their part: Google returns no
 * refresh_token, the access token expires, and nothing can renew it — the
 * server reports `googleNeedsReconnect` and the background sync then fails
 * every 60 seconds forever. Someone who also connected an IMAP inbox is not
 * bounced to onboarding, so without this they are never told at all; their
 * Gmail simply stops arriving.
 *
 * Deliberately not shown on /onboarding: that page carries its own notice, and
 * two versions of the same warning on one screen reads as a fault in the app.
 */
export default function GoogleReconnectBanner() {
  const { user, googleNeedsReconnect } = useAuth();
  const { t } = useT();
  const pathname = usePathname();

  if (!user || !googleNeedsReconnect) return null;
  if (pathname?.startsWith("/onboarding") || pathname?.startsWith("/login")) return null;

  return (
    <div
      data-testid="google-reconnect-banner"
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-notice-border bg-notice-bg px-4 py-2 text-role-caption leading-5 text-notice-ink"
    >
      <span>{t("reconnect.googleExpired")}</span>
      <Link
        href="/onboarding"
        className="font-semibold text-notice-ink-strong underline underline-offset-2 transition duration-300 ease-fluid hover:no-underline focus-ring"
      >
        {t("reconnect.googleAction")}
      </Link>
    </div>
  );
}
