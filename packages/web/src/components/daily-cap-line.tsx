"use client";

import Link from "next/link";
import { type DailyCapCode, dailyCapNotice } from "../lib/daily-cap";
import { useT } from "../lib/i18n";

/**
 * What an assistant bubble says in place of the server's English cap message
 * once the daily AI allowance is spent. Only the free allowance offers the
 * upgrade; a paying user is not upsold.
 */
export function DailyCapLine({ code }: { code: DailyCapCode }) {
  const { t } = useT();
  const notice = dailyCapNotice(code);
  if (!notice) return null;
  return (
    <>
      <p className="whitespace-pre-wrap">{t(notice.messageKey)}</p>
      {notice.upgrade && (
        <Link
          href="/billing"
          className="focus-ring inline-flex min-h-11 items-center rounded-control font-medium text-accent-deep underline"
        >
          {t("proFeature.upgrade")}
        </Link>
      )}
    </>
  );
}
