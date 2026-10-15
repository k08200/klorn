"use client";

import Link from "next/link";
import { useT } from "../lib/i18n";

/**
 * Shared notes for the IMAP connect sections (iCloud, Naver): the Pro gate with
 * an upgrade link, and what to expect right after a successful connect.
 */

/** apiFetch throws `API <status>: <body>`; a Pro gate is 403 ENTITLEMENT_REQUIRED. */
export function isEntitlementRefusal(message: string): boolean {
  return message.startsWith("API 403") && message.includes("ENTITLEMENT_REQUIRED");
}

/**
 * Free covers one Google account (billing/stripe.ts `multi_account`), so an IMAP
 * mailbox is Pro whether it would be the user's first source or a second one —
 * the copy says exactly that instead of assuming a Google inbox already exists.
 */
export function ImapProGate({ provider }: { provider: string }) {
  const { t } = useT();
  return (
    <div className="rounded-xl border border-state-info-line bg-state-info-bg p-4">
      <p className="text-sm text-ink">{t("imapConnect.proGate.title", { provider })}</p>
      <p className="mt-1 text-xs text-ink-mid">{t("imapConnect.proGate.body")}</p>
      <Link
        href="/billing"
        className="focus-ring mt-2 inline-flex min-h-11 items-center rounded-control text-sm font-medium text-accent-deep underline"
      >
        {t("imapConnect.proGate.upgrade")}
      </Link>
    </div>
  );
}

/** After connect: the first poll started now, or the next scheduler tick (≤ ~5 min). */
export function FirstSyncNote({ started }: { started: boolean }) {
  const { t } = useT();
  return (
    <p role="status" className="text-xs text-ink-mid">
      {started ? t("imapConnect.firstSync.started") : t("imapConnect.firstSync.delayed")}
    </p>
  );
}
