"use client";

/**
 * Today on a phone (mobile redesign PR2, MB1 "Editorial Brief", LOCKED
 * 2026-11-14) — below 600px. Top to bottom:
 *
 *   eyebrow    the date in the user's zone · the day's meetings
 *   headline   how many PUSH mail wait — Today's windowed PUSH read, so only
 *              PUSH inside the locked 72h window (model.ts todayLaneQuery)
 *   next       the running and upcoming events (one line below 360px)
 *   cards      one per PUSH mail: why it rang, the subject, Reply / Later
 *   held back  what the interrupt budget held today (v3 policy only)
 *   quiet      "Quietly sorted · Queue 14 · Info 9 · Silent 30", each lane a
 *              link into Mail on that lane
 *
 * Then the rest of the phone home, on the same tokens: Meeting, the calendar,
 * files and the assistant. Below 360px (a Fold's cover screen) the brief ends
 * with the whole-inbox link instead, as the cover view did.
 */

import Link from "next/link";
import { Fragment } from "react";
import { AlertHealthBanner } from "../../components/alert-health-banner";
import { useLaneName } from "../../components/ui/lane-chip";
import { useAuth } from "../../lib/auth";
import { filesEnabled } from "../../lib/home";
import { useT } from "../../lib/i18n";
import type { ConnectedAccountsState } from "../../lib/use-connected-accounts";
import { AssistantColumn } from "./assistant-column";
import { BlockError, LaneMoreLink, MailRowsSkeleton } from "./block";
import { briefHeadlineKey, meetingCount, quietLanes } from "./brief-model";
import { CalendarColumn } from "./calendar-column";
import { RecentFilesBlock } from "./files-block";
import { HeldBackGroup } from "./held-back";
import { InterruptMeter } from "./interrupt-meter";
import { LaneBlock, type TimeContext } from "./mail-column";
import { MAIL_HREF, preselectMailLane } from "./mail-link";
import { coverMeter, EXPANDED_LANE_ROWS, laneBlock } from "./model";
import { NextEvents } from "./next-events";
import { PushBriefCard } from "./push-brief-card";
import { AccountAttention, longDate } from "./today-header";
import { useLaneCounts, useLaneMail, useTodayEvents } from "./use-today-data";

interface PhoneTodayProps {
  time: TimeContext;
  accounts: ConnectedAccountsState;
  /** Below 360px: one-line next event, icon-only Later, no lower sections. */
  compact: boolean;
}

export function PhoneToday({ time, accounts, compact }: PhoneTodayProps) {
  const { t } = useT();
  const { user } = useAuth();
  const mail = useLaneMail("PUSH", true);
  const calendar = useTodayEvents(time.now, time.timeZone, true);
  const meter = coverMeter(mail.interruptBudget);
  const loaded = !mail.loading && !mail.failed;
  const { shown, more } = laneBlock(mail.emails, mail.total, EXPANDED_LANE_ROWS);
  const laneName = useLaneName();

  return (
    <div data-testid="today-brief" className="flex flex-col gap-5 px-4 pb-6 pt-5">
      <header className="flex flex-col gap-2">
        <Eyebrow time={time} meetings={calendar.loading ? null : meetingCount(calendar.events)} />
        <h1 className="text-role-page font-[650] text-ink [word-break:keep-all]">
          {loaded
            ? t(briefHeadlineKey(mail.total), { count: String(mail.total) })
            : t("nav.v2.today")}
        </h1>
        {meter && <InterruptMeter meter={meter} />}
        {!calendar.failed && <NextEvents events={calendar.events} time={time} compact={compact} />}
      </header>
      <AccountAttention accounts={accounts} />
      <AlertHealthBanner place="today" />
      {mail.loading && <MailRowsSkeleton rows={2} label={t("today.mail.loading")} />}
      {mail.failed && <BlockError message={t("today.mail.error")} onRetry={mail.retry} />}
      {loaded && shown.length > 0 && (
        <section aria-label={t("today.lane.push.hint")} className="flex flex-col gap-3">
          <ul className="flex flex-col gap-3">
            {shown.map((email, index) => (
              <li key={email.id}>
                <PushBriefCard
                  email={email}
                  time={time}
                  isDemo={mail.isDemo}
                  primary={index === 0}
                  compact={compact}
                />
              </li>
            ))}
          </ul>
          {more > 0 && (
            <div className="overflow-hidden rounded-card ring-1 ring-inset ring-line">
              <LaneMoreLink href={MAIL_HREF} onClick={() => preselectMailLane("PUSH")}>
                {t("today.mail.moreInLane", { count: String(more), lane: laneName("PUSH") })}
              </LaneMoreLink>
            </div>
          )}
        </section>
      )}
      <HeldBackGroup time={time} idPrefix="brief-held" />
      <QuietLine />
      {compact ? (
        <Link
          href={MAIL_HREF}
          className="focus-ring flex min-h-11 w-full items-center justify-center rounded-control border border-line-strong bg-surface-panel px-4 text-role-label text-ink transition-colors duration-120 ease-fluid hover:bg-surface-hover"
        >
          {t("today.cover.openInbox")}
        </Link>
      ) : (
        <div className="flex flex-col gap-7 pt-2">
          {/* LaneBlock carries its desktop order (order-2); the rest follow it. */}
          <LaneBlock lane="MEETING" accounts={accounts.accounts} time={time} />
          <CalendarColumn time={time} className="order-3" />
          {filesEnabled(user) && <RecentFilesBlock timeZone={time.timeZone} className="order-6" />}
          <AssistantColumn className="order-7" />
        </div>
      )}
    </div>
  );
}

function Eyebrow({ time, meetings }: { time: TimeContext; meetings: number | null }) {
  const { t } = useT();
  return (
    <p
      data-testid="brief-eyebrow"
      className="text-role-meta font-medium uppercase tracking-[0.08em] text-ink-muted"
    >
      <time dateTime={time.now.toISOString().slice(0, 10)}>{longDate(time)}</time>
      {meetings !== null && meetings > 0 && (
        <>
          {" · "}
          {t(meetings === 1 ? "today.brief.meetings.one" : "today.brief.meetings.many", {
            count: String(meetings),
          })}
        </>
      )}
    </p>
  );
}

/** "Quietly sorted · Queue 14 · Info 9 · Silent 30" — only lanes that hold mail. */
function QuietLine() {
  const { t } = useT();
  const laneName = useLaneName();
  const { counts } = useLaneCounts(true);
  const lanes = quietLanes(counts);
  if (lanes.length === 0) return null;
  return (
    <p data-testid="brief-quiet" className="text-role-meta tabular-nums text-ink-muted">
      {t("today.brief.quiet")}
      {lanes.map(({ lane, count }) => (
        <Fragment key={lane}>
          {" · "}
          <Link
            href={MAIL_HREF}
            onClick={() => preselectMailLane(lane)}
            className="focus-ring relative rounded-chip underline-offset-2 transition-colors duration-120 ease-fluid hover:text-ink-soft hover:underline pointer-coarse:after:absolute pointer-coarse:after:-inset-y-3.5 pointer-coarse:after:inset-x-0 pointer-coarse:after:content-['']"
          >
            {laneName(lane)} {count}
          </Link>
        </Fragment>
      ))}
    </p>
  );
}
