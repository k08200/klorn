"use client";

import Link from "next/link";
import { useT } from "../lib/i18n";

/**
 * The upgrade notice for a paid action a FREE user tried: the API answered 403
 * ENTITLEMENT_REQUIRED (lib/entitlement.ts). One sentence and a link to /billing
 * instead of the server's English refusal or a silent failure. The mailbox
 * connect sections keep their own MailAccountProGate.
 */
export function ProFeatureNotice({
  messageKey = "proFeature.title",
  className = "",
}: {
  messageKey?: string;
  className?: string;
}) {
  const { t } = useT();
  return (
    <div
      role="status"
      className={`rounded-xl border border-state-info-line bg-state-info-bg px-3 py-2 ${className}`}
    >
      <p className="text-sm text-ink">{t(messageKey)}</p>
      <Link
        href="/billing"
        className="focus-ring inline-flex min-h-11 items-center rounded-control text-sm font-medium text-accent-deep underline"
      >
        {t("proFeature.upgrade")}
      </Link>
    </div>
  );
}
