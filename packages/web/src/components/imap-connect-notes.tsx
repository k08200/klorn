"use client";

import { useT } from "../lib/i18n";

/** After an IMAP connect: the first poll started now, or the next scheduler tick (≤ ~5 min). */
export function FirstSyncNote({ started }: { started: boolean }) {
  const { t } = useT();
  return (
    <p role="status" className="text-xs text-ink-mid">
      {started ? t("imapConnect.firstSync.started") : t("imapConnect.firstSync.delayed")}
    </p>
  );
}
