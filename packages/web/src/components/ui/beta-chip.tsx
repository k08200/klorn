"use client";

import { useT } from "../../lib/i18n";

/**
 * "Beta" marker for sources that work but are newer than Gmail/Google
 * Calendar (Naver Mail, iCloud Mail). A label, not a gate: the source is live.
 */
export function BetaChip({ className = "" }: { className?: string }) {
  const { t } = useT();
  return (
    <span
      className={`inline-flex h-5.5 shrink-0 items-center rounded-control border border-line bg-surface-raised px-2 text-caption font-semibold text-ink-mid ${className}`}
    >
      {t("imap.beta")}
    </span>
  );
}
