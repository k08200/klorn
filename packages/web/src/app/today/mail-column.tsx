"use client";

/**
 * Today, the lanes column — mail by lane across every connected account
 * (productization plan §1, P6; design detail pass W1/W2). PUSH and MEETING are
 * expanded (PUSH only inside Today's window — older PUSH is a link to Mail),
 * QUEUE is a count plus its top rows, INFO is one collapsed count
 * row, and SILENT is never shown. One row per thread: the newest message of
 * each thread, a count chip when the thread holds more, and lane counts that
 * count threads. Inside a lane card a row carries no LaneChip (the card is the
 * lane) but a lane rail and the reason in the lane's ink; a mail the judge has
 * not reached sits in QUEUE marked "Sorting…".
 */

import type { EmailLaneCounts, EmailListItem, LiveTier } from "@klorn/contract";
import Link from "next/link";
import { LaneChip, useLaneName } from "../../components/ui/lane-chip";
import { MailRow } from "../../components/ui/mail-row";
import { Skeleton, SkeletonGroup } from "../../components/ui/skeleton";
import type { ConnectedAccount } from "../../lib/connected-accounts";
import { useT } from "../../lib/i18n";
import { formatRowTime, rowAccount, senderName } from "../email/_v2/model";
import {
  BlockError,
  BlockNote,
  CARD_CLASS,
  Chevron,
  LaneMoreLink,
  MailRowsSkeleton,
  TodayBlock,
} from "./block";
import { MAIL_HREF, preselectMailLane } from "./mail-link";
import {
  EXPANDED_LANE_ROWS,
  laneBlock,
  olderOutsideWindow,
  QUEUE_LANE_ROWS,
  todayLaneCount,
} from "./model";
import { useLaneCounts, useLaneMail } from "./use-today-data";

export interface TimeContext {
  now: Date;
  locale: string;
  timeZone: string;
}

type ListedLane = Exclude<LiveTier, "INFO" | "SILENT">;

const LANE_COPY: Record<ListedLane, { hint: string; empty: string; order: string }> = {
  PUSH: { hint: "today.lane.push.hint", empty: "today.lane.push.empty", order: "order-1" },
  MEETING: { hint: "today.lane.meeting.hint", empty: "today.lane.meeting.empty", order: "order-2" },
  QUEUE: { hint: "today.lane.queue.hint", empty: "today.lane.queue.empty", order: "order-4" },
};

const LANE_ROWS: Record<ListedLane, number> = {
  PUSH: EXPANDED_LANE_ROWS,
  MEETING: EXPANDED_LANE_ROWS,
  QUEUE: QUEUE_LANE_ROWS,
};

interface MailColumnProps {
  accounts: readonly ConnectedAccount[];
  time: TimeContext;
  className?: string;
}

export function MailColumn({ accounts, time, className = "" }: MailColumnProps) {
  return (
    // `contents` in the one-column layout: the lane blocks join the page's
    // single column, so the calendar can sit between MEETING and QUEUE.
    <div
      className={`contents @min-[912px]:flex @min-[912px]:flex-col @min-[912px]:gap-7 ${className}`}
    >
      <LaneBlock lane="PUSH" accounts={accounts} time={time} />
      <LaneBlock lane="MEETING" accounts={accounts} time={time} />
      <LaneBlock lane="QUEUE" accounts={accounts} time={time} />
      <InfoRow />
    </div>
  );
}

interface LaneBlockProps {
  lane: ListedLane;
  accounts: readonly ConnectedAccount[];
  time: TimeContext;
}

/** Threads in a lane: the thread count when the API sends one, else messages. */
export function laneThreads(counts: EmailLaneCounts | null, lane: LiveTier): number | null {
  if (!counts) return null;
  return counts[lane].threads ?? counts[lane].total;
}

function LaneBlock({ lane, accounts, time }: LaneBlockProps) {
  const { t } = useT();
  const laneName = useLaneName();
  const mail = useLaneMail(lane, true);
  const counts = useLaneCounts(true);
  const copy = LANE_COPY[lane];
  // The list's total is threads (the page is grouped by thread).
  const { shown, more } = laneBlock(mail.emails, mail.total, LANE_ROWS[lane]);
  const loaded = !mail.loading && !mail.failed;
  const laneTotal = laneThreads(counts.counts, lane);
  // PUSH counts its windowed threads, the same figure the header strip shows.
  const threads = todayLaneCount(lane, laneTotal, loaded ? mail.total : null);
  // PUSH older than Today's window stays in Mail; offer it once the window's
  // own rows (and their "N more") are exhausted.
  const older =
    lane === "PUSH" && loaded && more === 0 ? olderOutsideWindow(laneTotal, mail.total) : 0;
  return (
    <TodayBlock
      headingId={`today-lane-${lane}`}
      title={<LaneChip tier={lane} />}
      hint={t(copy.hint)}
      count={threads}
      countLabel={
        threads === null ? undefined : t("today.mail.threads", { count: String(threads) })
      }
      className={copy.order}
    >
      {mail.loading && <MailRowsSkeleton rows={3} label={t("today.mail.loading")} />}
      {mail.failed && <BlockError inset message={t("today.mail.error")} onRetry={mail.retry} />}
      {loaded && shown.length === 0 && <BlockNote inset>{t(copy.empty)}</BlockNote>}
      {loaded && shown.length > 0 && (
        <ul className="flex flex-col divide-y divide-line-soft">
          {shown.map((email) => (
            <li key={email.id}>
              <LaneRow lane={lane} email={email} accounts={accounts} time={time} />
            </li>
          ))}
        </ul>
      )}
      {loaded && mail.isDemo && shown.length > 0 && (
        <p className="border-t border-line-soft px-4 py-2 text-caption text-ink-muted">
          {t("today.mail.sample")}
        </p>
      )}
      {loaded && more > 0 && (
        <LaneMoreLink href={MAIL_HREF} onClick={() => preselectMailLane(lane)}>
          {t("today.mail.moreInLane", { count: String(more), lane: laneName(lane) })}
        </LaneMoreLink>
      )}
      {older > 0 && (
        <LaneMoreLink href={MAIL_HREF} onClick={() => preselectMailLane(lane)}>
          {t("today.lane.push.older", { lane: laneName(lane) })}
        </LaneMoreLink>
      )}
    </TodayBlock>
  );
}

function LaneRow({
  lane,
  email,
  accounts,
  time,
}: {
  lane: ListedLane;
  email: EmailListItem;
  accounts: readonly ConnectedAccount[];
  time: TimeContext;
}) {
  const { t } = useT();
  const account = rowAccount(email, accounts);
  return (
    <MailRow
      sender={senderName(email.from)}
      subject={email.subject || t("today.mail.noSubject")}
      snippet={email.snippet ?? undefined}
      reason={email.tierReason ?? null}
      threadCount={email.threadCount}
      time={formatRowTime(email.date, time.now, time.locale, time.timeZone)}
      timeIso={email.date}
      // The card is the lane, so the row repeats no chip; a mail with no
      // recorded lane says so instead of passing as judged.
      tier={null}
      lane={email.tier ?? lane}
      rail
      tierPending={email.tier ? undefined : t("today.mail.sorting")}
      source={account ? { provider: account.provider, nickname: account.nickname } : null}
      unread={!email.isRead}
      hasAttachment={email.attachmentCount > 0}
      href={`/email/${email.id}?markRead=false&queue=all`}
    />
  );
}

/** INFO, collapsed: one row with the count, opening Mail on that lane. */
function InfoRow() {
  const { t } = useT();
  const counts = useLaneCounts(true);
  const headingId = "today-lane-INFO";
  if (counts.failed) {
    return (
      <TodayBlock
        headingId={headingId}
        title={<LaneChip tier="INFO" />}
        hint={t("today.lane.info.hint")}
        className="order-5"
      >
        <BlockError inset message={t("today.mail.error")} onRetry={counts.retry} />
      </TodayBlock>
    );
  }
  const total = laneThreads(counts.counts, "INFO") ?? 0;
  return (
    <section aria-labelledby={headingId} className={`order-5 min-w-0 ${CARD_CLASS}`}>
      <Link
        href={MAIL_HREF}
        onClick={() => preselectMailLane("INFO")}
        className="focus-ring flex min-h-12 items-center gap-2.5 px-4 text-ink-soft transition-colors duration-120 ease-fluid hover:bg-surface-raised focus-visible:-outline-offset-2"
      >
        <h2 id={headingId} className="flex shrink-0 items-center gap-2 text-head text-ink">
          <LaneChip tier="INFO" />
        </h2>
        <span className="min-w-0 truncate text-label font-normal text-ink-muted">
          {t("today.lane.info.hint")}
        </span>
        <span className="flex-1" />
        {counts.loading ? (
          <SkeletonGroup label={t("today.mail.loading")}>
            <Skeleton width="w-6" />
          </SkeletonGroup>
        ) : (
          <span className="text-caption tabular-nums text-ink-muted">
            {t("today.mail.threads", { count: String(total) })}
          </span>
        )}
        <span className="text-ink-muted">
          <Chevron />
        </span>
      </Link>
    </section>
  );
}
