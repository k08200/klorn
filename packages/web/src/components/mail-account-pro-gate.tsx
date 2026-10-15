"use client";

import Link from "next/link";
import { useT } from "../lib/i18n";

/**
 * The Pro gate for connecting a mailbox, shared by every connect section
 * (Google, Outlook, iCloud, Naver). Free covers ONE mail account whatever the
 * provider; a second one is Pro (api billing/mail-account-entitlement.ts).
 */

/** apiFetch throws `API <status>: <body>`; the gate is 403 ENTITLEMENT_REQUIRED. */
export function isEntitlementRefusal(message: string): boolean {
  return message.startsWith("API 403") && message.includes("ENTITLEMENT_REQUIRED");
}

export function MailAccountProGate() {
  const { t } = useT();
  return (
    <div className="rounded-xl border border-state-info-line bg-state-info-bg p-4">
      <p className="text-sm text-ink">{t("mailAccount.proGate.title")}</p>
      <p className="mt-1 text-xs text-ink-mid">{t("mailAccount.proGate.body")}</p>
      <Link
        href="/billing"
        className="focus-ring mt-2 inline-flex min-h-11 items-center rounded-control text-sm font-medium text-accent-deep underline"
      >
        {t("mailAccount.proGate.upgrade")}
      </Link>
    </div>
  );
}
