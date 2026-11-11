"use client";

/**
 * Today on a cover screen (founder decision 2026-11-07): below 360px — a
 * Galaxy Fold's cover display at 344dp, or any phone that narrow — home is
 * one "Needs you now" list instead of the phone layout. Only PUSH, inside
 * Today's locked window (the same windowed read as the PUSH block,
 * model.ts todayLaneQuery); each mail is a card with Reply and Later, and
 * the foot opens the whole inbox. At 360px and up nothing here renders
 * (today-view.tsx, COVER_QUERY).
 *
 * Below the list, the "Held back" group (held-back.tsx) when the budget held
 * anything today.
 *
 * The interruption meter draws only from the budget the Today read already
 * carries (attention engine v3, behind its flag); without it there is no
 * meter at all — never a made-up count.
 */

import Link from "next/link";
import { useT } from "../../lib/i18n";
import { BlockError, MailRowsSkeleton } from "./block";
import { HeldBackGroup } from "./held-back";
import type { TimeContext } from "./mail-column";
import { MAIL_HREF } from "./mail-link";
import { type CoverMeter, coverMeter } from "./model";
import { ReplyLaterCard } from "./reply-later-card";
import { useLaneMail } from "./use-today-data";

export function CoverToday({ time }: { time: TimeContext }) {
  const { t } = useT();
  const mail = useLaneMail("PUSH", true);
  const meter = coverMeter(mail.interruptBudget);
  const loaded = !mail.loading && !mail.failed;
  return (
    <div className="flex flex-col gap-4 px-4 pb-6 pt-5">
      <header className="flex flex-col gap-2">
        <h1 className="text-role-title text-ink">{t("today.lane.push.hint")}</h1>
        {meter && <InterruptMeter meter={meter} />}
      </header>
      {mail.loading && <MailRowsSkeleton rows={2} label={t("today.mail.loading")} />}
      {mail.failed && <BlockError message={t("today.mail.error")} onRetry={mail.retry} />}
      {loaded && mail.emails.length === 0 && (
        <p className="py-2 text-role-body text-ink-soft [word-break:keep-all]">
          {t("today.lane.push.empty")}
        </p>
      )}
      {loaded && mail.emails.length > 0 && (
        <ul className="flex flex-col gap-3">
          {mail.emails.map((email) => (
            <li key={email.id}>
              <ReplyLaterCard email={email} time={time} isDemo={mail.isDemo} idPrefix="cover" />
            </li>
          ))}
        </ul>
      )}
      <HeldBackGroup time={time} idPrefix="cover-held" />
      <Link
        href={MAIL_HREF}
        className="focus-ring flex min-h-11 w-full items-center justify-center rounded-control border border-line-strong bg-surface-panel px-4 text-role-label text-ink transition-colors duration-120 ease-fluid hover:bg-surface-hover"
      >
        {t("today.cover.openInbox")}
      </Link>
    </div>
  );
}

function InterruptMeter({ meter }: { meter: CoverMeter }) {
  const { t, locale } = useT();
  const number = new Intl.NumberFormat(locale);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-role-caption tabular-nums text-ink-muted">
        {t("today.cover.meter", {
          used: number.format(meter.used),
          limit: number.format(meter.limit),
        })}
      </p>
      <div aria-hidden="true" className="h-1 w-full overflow-hidden rounded-full bg-surface-inset">
        <div
          className="h-full rounded-full bg-tier-push-ink"
          style={{ width: `${meter.ratio * 100}%` }}
        />
      </div>
    </div>
  );
}
