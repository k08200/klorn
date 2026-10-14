"use client";

/**
 * Today, column A — mail by lane across every connected account
 * (productization plan §1, P6). PUSH and MEETING are expanded, QUEUE is a
 * count plus its top rows, INFO is one collapsed count row, and SILENT is
 * never shown. Inside a lane block a row carries no LaneChip (the block is the
 * lane); a mail the judge has not reached sits in QUEUE marked "Sorting…".
 */

import type { EmailLaneCounts, EmailListItem, LiveTier } from "@klorn/contract";
import Link from "next/link";
import { LaneChip } from "../../components/ui/lane-chip";
import { MailRow } from "../../components/ui/mail-row";
import { Skeleton, SkeletonGroup } from "../../components/ui/skeleton";
import type { ConnectedAccount } from "../../lib/connected-accounts";
import { useT } from "../../lib/i18n";
import { formatRowTime, rowAccount, senderName } from "../email/_v2/model";
import { BlockError, BlockLink, BlockNote, Chevron, MailRowsSkeleton, TodayBlock } from "./block";
import { MAIL_HREF, preselectMailLane } from "./mail-link";
import { EXPANDED_LANE_ROWS, laneBlock, QUEUE_LANE_ROWS } from "./model";
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
    // `contents` below md: the lane blocks join the page's single column, so
    // the calendar can sit between MEETING and QUEUE on a phone.
    <div className={`contents md:flex md:flex-col md:gap-8 ${className}`}>
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

function LaneBlock({ lane, accounts, time }: LaneBlockProps) {
  const { t } = useT();
  const mail = useLaneMail(lane, true);
  const copy = LANE_COPY[lane];
  const { shown, more } = laneBlock(mail.emails, mail.total, LANE_ROWS[lane]);
  const loaded = !mail.loading && !mail.failed;
  return (
    <TodayBlock
      headingId={`today-lane-${lane}`}
      title={<LaneChip tier={lane} />}
      hint={t(copy.hint)}
      count={loaded ? mail.total : null}
      countLabel={loaded ? t("today.mail.count", { count: String(mail.total) }) : undefined}
      className={copy.order}
    >
      {mail.loading && <MailRowsSkeleton rows={3} label={t("today.mail.loading")} />}
      {mail.failed && <BlockError message={t("today.mail.error")} onRetry={mail.retry} />}
      {loaded && shown.length === 0 && <BlockNote>{t(copy.empty)}</BlockNote>}
      {loaded && shown.length > 0 && (
        <ul className="-mx-3 flex flex-col pt-1">
          {shown.map((email) => (
            <li key={email.id}>
              <LaneRow email={email} accounts={accounts} time={time} />
            </li>
          ))}
        </ul>
      )}
      {loaded && mail.isDemo && shown.length > 0 && (
        <p className="pt-1 text-caption text-ink-muted">{t("today.mail.sample")}</p>
      )}
      {loaded && more > 0 && (
        <BlockLink href={MAIL_HREF} onClick={() => preselectMailLane(lane)}>
          {t("today.mail.more", { count: String(more) })}
        </BlockLink>
      )}
    </TodayBlock>
  );
}

function LaneRow({
  email,
  accounts,
  time,
}: {
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
      time={formatRowTime(email.date, time.now, time.locale, time.timeZone)}
      timeIso={email.date}
      // The block is the lane, so the row repeats no chip; a mail with no
      // recorded lane says so instead of passing as judged.
      tier={null}
      tierPending={email.tier ? undefined : t("today.mail.sorting")}
      source={account ? { provider: account.provider, nickname: account.nickname } : null}
      unread={!email.isRead}
      hasAttachment={email.attachmentCount > 0}
      href={`/email/${email.id}?markRead=false&queue=all`}
    />
  );
}

function infoTotal(counts: EmailLaneCounts | null): number {
  return counts?.INFO.total ?? 0;
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
        <BlockError message={t("today.mail.error")} onRetry={counts.retry} />
      </TodayBlock>
    );
  }
  const total = infoTotal(counts.counts);
  return (
    <section aria-labelledby={headingId} className="order-5 min-w-0">
      <Link
        href={MAIL_HREF}
        onClick={() => preselectMailLane("INFO")}
        className="focus-ring flex min-h-11 items-center gap-2 border-b border-line text-ink-soft transition-colors duration-120 ease-fluid hover:text-ink"
      >
        <h2 id={headingId} className="flex items-center gap-2 text-head text-ink">
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
          <span className="text-label tabular-nums">
            <span aria-hidden="true">{total}</span>
            <span className="sr-only">{t("today.mail.count", { count: String(total) })}</span>
          </span>
        )}
        <Chevron />
      </Link>
    </section>
  );
}
