"use client";

/**
 * Mail v2 rows and list states (productization plan §1/§2, P5).
 *
 * One-badge rule: a row is the P2 MailRow — sender, subject, snippet, time,
 * LaneChip (or a neutral "Sorting…" while the judge has not assigned a lane),
 * SourceBadge, unread dot, attachment glyph. Needs-reply, priority,
 * category, candidate and the reason are not on the row; they belong to the
 * reader header. Inside one lane the chip would repeat the selected segment on
 * every row, so it shows only where the view mixes lanes (model.rowLane).
 *
 * A row's controls are siblings of its link, never inside it: a select
 * checkbox over the unread dot (hover / focus, or pinned while a selection is
 * in progress; Shift extends the range) and the trailing actions — remind,
 * read state, archive.
 */

import type { EmailListItem, EmailThreadRow } from "@klorn/contract";
import { useEffect, useRef } from "react";
import Button from "../../../components/ui/button";
import EmptyState from "../../../components/ui/empty-state";
import { MailRow } from "../../../components/ui/mail-row";
import { Menu } from "../../../components/ui/menu";
import { MailRowSkeleton, SkeletonGroup } from "../../../components/ui/skeleton";
import { useT } from "../../../lib/i18n";
import { TRIAGE_ROW_ATTR } from "../use-list-triage";
import { ArchiveIcon, ClockIcon, InboxIcon, ReadIcon, UnreadIcon } from "./icons";
import {
  type AccountOption,
  formatRowTime,
  isNarrowed,
  type LaneView,
  type ListView,
  readerQueue,
  rowAccount,
  rowLane,
  senderName,
} from "./model";
import { REMINDER_KEYS, REMINDER_LABEL_KEYS, type ReminderKey } from "./reminders";

const SKELETON_ROWS = ["a", "b", "c", "d", "e", "f", "g", "h"];
/** Start loading the next page this far before the end scrolls into view. */
const PRELOAD_MARGIN = "400px";

/** The cursor row carries an accent bar as well as the tint: tint alone is not a 3:1 indicator. */
const CURSOR_CLASS = "shadow-[inset_2px_0_0_var(--accent-solid)]";
const PICKED_CLASS = "bg-state-info-bg";

interface TimeContext {
  now: Date;
  locale: string;
  timeZone: string;
}

interface MailRowsProps {
  emails: readonly EmailListItem[];
  view: ListView;
  accounts: readonly AccountOption[];
  time: TimeContext;
  cursorId: string | null;
  pickedIds: ReadonlySet<string>;
  /** Demo rows cannot be changed, so they offer no actions. */
  readOnly: boolean;
  busy: boolean;
  onArchive: (email: EmailListItem) => void;
  onSetRead: (email: EmailListItem, isRead: boolean) => void;
  onRemind: (email: EmailListItem, key: ReminderKey) => void;
  /** Toggle a row's selection; `range` extends it from the last toggled row. */
  onPick: (email: EmailListItem, range: boolean) => void;
}

interface RowPickProps {
  label: string;
  picked: boolean;
  onPick: (range: boolean) => void;
}

/**
 * The select control. The label is the hit area (the row's full height, 36px
 * wide with a mouse and 44px on touch); the native checkbox inside it carries
 * the state and the name. Shift is read from the click behind the change,
 * which a keyboard toggle (Space) reports as unset.
 */
function RowPick({ label, picked, onPick }: RowPickProps) {
  return (
    <label className="flex h-full w-9 cursor-pointer items-center pl-1.5 pointer-coarse:w-11 pointer-coarse:pl-2">
      <input
        type="checkbox"
        aria-label={label}
        checked={picked}
        onChange={(event) => onPick((event.nativeEvent as MouseEvent).shiftKey === true)}
        className="focus-ring size-4 cursor-pointer rounded-control accent-accent-solid"
      />
    </label>
  );
}

export function MailRows(props: MailRowsProps) {
  const { emails, view, accounts, time, cursorId, pickedIds } = props;
  const { t } = useT();
  const queue = readerQueue(view.filter);
  const selecting = pickedIds.size > 0;
  return (
    <ul className="flex flex-col">
      {emails.map((email) => {
        const account = rowAccount(email, accounts);
        const cursor = cursorId === email.id;
        const picked = pickedIds.has(email.id);
        const subject = email.subject || t("mailV2.noSubject");
        return (
          <li key={email.id} {...{ [TRIAGE_ROW_ATTR]: email.id }}>
            {picked && <span className="sr-only">{t("mailV2.bulk.rowSelected")}</span>}
            <MailRow
              sender={senderName(email.from)}
              subject={subject}
              snippet={email.snippet ?? undefined}
              time={formatRowTime(email.date, time.now, time.locale, time.timeZone)}
              timeIso={email.date}
              tier={rowLane(view, email.tier)}
              // No AttentionItem yet: the mail is listed, but no lane is claimed.
              tierPending={email.tier === null ? t("mailV2.row.sorting") : undefined}
              source={account ? { provider: account.provider, nickname: account.nickname } : null}
              unread={!email.isRead}
              hasAttachment={email.attachmentCount > 0}
              selected={cursor}
              href={`/email/${email.id}?markRead=false&queue=${queue}`}
              className={cursor ? CURSOR_CLASS : picked ? PICKED_CLASS : ""}
              leading={
                props.readOnly ? undefined : (
                  <RowPick
                    label={t("mailV2.list.select", { subject })}
                    picked={picked}
                    onPick={(range) => props.onPick(email, range)}
                  />
                )
              }
              leadingPinned={selecting}
              actions={
                props.readOnly ? undefined : (
                  <>
                    <Menu
                      label={t("mailV2.list.remind")}
                      variant="icon"
                      align="end"
                      disabled={props.busy}
                      sections={[
                        {
                          id: "remind",
                          heading: t("mailV2.list.remind"),
                          items: REMINDER_KEYS.map((key) => ({
                            id: key,
                            label: t(REMINDER_LABEL_KEYS[key]),
                            onSelect: () => props.onRemind(email, key),
                          })),
                        },
                      ]}
                    >
                      <ClockIcon />
                    </Menu>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t(email.isRead ? "mailV2.row.markUnread" : "mailV2.row.markRead")}
                      title={t(email.isRead ? "mailV2.row.markUnread" : "mailV2.row.markRead")}
                      disabled={props.busy}
                      onClick={() => props.onSetRead(email, !email.isRead)}
                    >
                      {email.isRead ? <UnreadIcon /> : <ReadIcon />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("mailV2.row.archive")}
                      title={t("mailV2.row.archive")}
                      disabled={props.busy}
                      onClick={() => props.onArchive(email)}
                    >
                      <ArchiveIcon />
                    </Button>
                  </>
                )
              }
            />
          </li>
        );
      })}
    </ul>
  );
}

export function ThreadRows({
  threads,
  time,
}: {
  threads: readonly EmailThreadRow[];
  time: TimeContext;
}) {
  const { t } = useT();
  return (
    <ul className="flex flex-col">
      {threads.map((thread) => {
        const names = thread.participants.map(senderName).join(", ");
        return (
          <li key={thread.threadId}>
            <MailRow
              sender={thread.messageCount > 1 ? `${names} (${thread.messageCount})` : names}
              subject={thread.subject || t("mailV2.noSubject")}
              snippet={thread.summary ?? thread.lastMessage.snippet ?? undefined}
              time={formatRowTime(
                thread.lastMessage.receivedAt,
                time.now,
                time.locale,
                time.timeZone,
              )}
              timeIso={thread.lastMessage.receivedAt}
              unread={thread.hasUnread}
              href={`/email/${thread.lastMessage.id}?markRead=false`}
            />
          </li>
        );
      })}
    </ul>
  );
}

export function MailListLoading() {
  const { t } = useT();
  return (
    <SkeletonGroup label={t("mailV2.loading")}>
      {SKELETON_ROWS.map((row) => (
        <MailRowSkeleton key={row} />
      ))}
    </SkeletonGroup>
  );
}

export function MailListError({ onRetry }: { onRetry: () => void }) {
  const { t } = useT();
  return (
    <div role="alert">
      <EmptyState
        headingLevel="h2"
        title={t("mailV2.error.title")}
        description={t("mailV2.error.body")}
        primaryAction={{ label: t("mailV2.retry"), onClick: onRetry }}
      />
    </div>
  );
}

const EMPTY_COPY: Record<LaneView, { title: string; body: string }> = {
  PUSH: { title: "mailV2.empty.push.title", body: "mailV2.empty.push.body" },
  MEETING: { title: "mailV2.empty.meeting.title", body: "mailV2.empty.meeting.body" },
  QUEUE: { title: "mailV2.empty.queue.title", body: "mailV2.empty.queue.body" },
  INFO: { title: "mailV2.empty.info.title", body: "mailV2.empty.info.body" },
  SILENT: { title: "mailV2.empty.silent.title", body: "mailV2.empty.silent.body" },
  ALL: { title: "mailV2.empty.all.title", body: "mailV2.empty.all.body" },
};

/**
 * Nothing in this view. A narrowed view says so and offers the way out; a
 * plain lane gets day-one copy: what will show up here, not that it is missing.
 */
export function MailListEmpty({ view, onClear }: { view: ListView; onClear: () => void }) {
  const { t } = useT();
  if (isNarrowed(view)) {
    return (
      <EmptyState
        headingLevel="h2"
        icon={<InboxIcon />}
        title={t("mailV2.empty.narrowed.title")}
        description={t("mailV2.empty.narrowed.body")}
        primaryAction={{ label: t("mailV2.clearFilters"), onClick: onClear }}
      />
    );
  }
  const copy = EMPTY_COPY[view.lane];
  return (
    <EmptyState
      headingLevel="h2"
      icon={<InboxIcon />}
      title={t(copy.title)}
      description={t(copy.body)}
    />
  );
}

interface LoadMoreProps {
  shown: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}

/**
 * Infinite scroll with a real button behind it: the sentinel loads the next
 * page before the end is reached, and the button stays for keyboard users and
 * for a browser that throttles the observer.
 */
export function LoadMore({ shown, total, hasMore, loading, onLoadMore }: LoadMoreProps) {
  const { t } = useT();
  const sentinel = useRef<HTMLDivElement>(null);
  const latest = useRef(onLoadMore);
  useEffect(() => {
    latest.current = onLoadMore;
  });

  useEffect(() => {
    const node = sentinel.current;
    if (!hasMore || loading || !node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin: PRELOAD_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading]);

  return (
    <div ref={sentinel} className="flex flex-col items-center gap-1 py-4">
      {hasMore && (
        <Button variant="secondary" size="sm" onClick={onLoadMore} loading={loading}>
          {t(loading ? "mailV2.loadingMore" : "mailV2.loadMore")}
        </Button>
      )}
      <p className="text-caption tabular-nums text-ink-muted">
        {t("mailV2.shown", { shown: String(shown), total: String(total) })}
      </p>
    </div>
  );
}
