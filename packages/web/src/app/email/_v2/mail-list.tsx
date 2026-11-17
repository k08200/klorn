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
 * in progress; Shift extends the range) and the trailing actions — lane,
 * remind, read state, archive.
 *
 * On touch a row also swipes (P10; directions from the mobile redesign PR3,
 * MB1, LOCKED 2026-11-14): right is Done (the archive), left is Later (a
 * reminder later today, POST /api/email/:id/later). Both read the same plan
 * as the row's own actions (row-actions.ts), so a swipe never offers what a
 * button cannot reach, and a blocked action says why instead of doing
 * nothing. On a touch screen (hover: none) the hover overlay never shows, so
 * the row keeps one 44px "More actions" button with Later, Done, read state,
 * Select, the other reminders and the lanes.
 *
 * The row is MailRow's `brief` variant: a monogram, the sender and time, the
 * subject, and why the mail is in its lane by the notification center's rule
 * (pushWhy: a verified quote, else "Klorn's call · …", plain text only).
 */

import type { EmailListItem, EmailThreadRow, LiveTier } from "@klorn/contract";
import { useEffect, useRef, useState } from "react";
import { useToast } from "../../../components/toast";
import Button from "../../../components/ui/button";
import EmptyState from "../../../components/ui/empty-state";
import { MailRow, type MailRowWhy } from "../../../components/ui/mail-row";
import { Menu, type MenuSection } from "../../../components/ui/menu";
import { MailRowSkeleton, SkeletonGroup } from "../../../components/ui/skeleton";
import { SwipeRow } from "../../../components/ui/swipe-row";
import { useT } from "../../../lib/i18n";
import { CORE_TIERS } from "../../../lib/tiers";
import { pushWhy } from "../../today/brief-model";
import { TRIAGE_ROW_ATTR } from "../use-list-triage";
import {
  ArchiveIcon,
  ClockIcon,
  InboxIcon,
  LanesIcon,
  MoreIcon,
  ReadIcon,
  UnreadIcon,
} from "./icons";
import { LANE_DOT } from "./mail-header";
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
import { QUICK_LATER, RowActionSheet, type RowActionTarget } from "./row-action-sheet";
import { type RowActionPlan, rowActionPlan } from "./row-actions";

const SKELETON_ROWS = ["a", "b", "c", "d", "e", "f", "g", "h"];
/** Start loading the next page this far before the end scrolls into view. */
const PRELOAD_MARGIN = "400px";

/** The cursor row carries an accent bar as well as the tint: tint alone is not a 3:1 indicator. */
const PICKED_CLASS = "bg-state-info-bg";
/**
 * The last rows open their menus upward: the lane menu is ~260px, more than
 * the space left under the final rows, and on a phone the fixed tab bar would
 * cover what runs past the end of the list.
 */
const MENU_UP_ROWS = 3;

interface TimeContext {
  now: Date;
  locale: string;
  timeZone: string;
}

interface MailRowsProps {
  emails: readonly EmailListItem[];
  /** The split view's list column (280–440px): 14px subjects. */
  compact?: boolean;
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
  /** Reclassify only (use-lane-move: optimistic, with undo). */
  onMoveLane: (email: EmailListItem, tier: LiveTier) => void;
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
    // The avatar's column (56px), the row's full height: past 44px either way.
    <label className="flex h-full w-full cursor-pointer items-center justify-center">
      <input
        type="checkbox"
        aria-label={label}
        checked={picked}
        onChange={(event) => onPick((event.nativeEvent as MouseEvent).shiftKey === true)}
        className="focus-ring size-4 cursor-pointer rounded-chip accent-accent-solid pointer-coarse:size-5 [@media(hover:none)]:size-5"
      />
    </label>
  );
}

/** The lane menu on a row: the reader's lane menu, for one row. */
function laneMenuSection(
  email: EmailListItem,
  plan: RowActionPlan,
  t: (key: string) => string,
  onMove: (tier: LiveTier) => void,
): MenuSection {
  const blocked = plan.lanes.blockedReason;
  return {
    id: "lanes",
    // The heading doubles as the reason when lanes cannot be changed.
    heading: blocked ? t(blocked) : t("mailV2.reader.moveTo"),
    items: CORE_TIERS.map((lane) => ({
      id: lane,
      label: lane,
      leading: <span aria-hidden="true" className={`size-2 rounded-full ${LANE_DOT[lane]}`} />,
      kind: "radio" as const,
      checked: email.tier === lane,
      disabled: blocked !== null,
      onSelect: () => {
        if (lane !== email.tier) onMove(lane);
      },
    })),
  };
}

interface RowActionsProps {
  email: EmailListItem;
  plan: RowActionPlan;
  busy: boolean;
  archiveBlocked: string | null;
  onArchive: () => void;
  onSetRead: (isRead: boolean) => void;
  onRemind: (key: ReminderKey) => void;
  onMoveLane: (tier: LiveTier) => void;
  /** Open the menus upward (rows near the end, where below runs off the list). */
  menuSide: "top" | "bottom";
}

/** The row's trailing actions: every swipe action is here too (no swipe-only actions). */
function RowActions({ email, plan, busy, archiveBlocked, menuSide, ...on }: RowActionsProps) {
  const { t } = useT();
  const readKey = email.isRead ? "mailV2.row.markUnread" : "mailV2.row.markRead";
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("mailV2.row.archive")}
        title={archiveBlocked ?? t("mailV2.row.archive")}
        disabled={busy || archiveBlocked !== null}
        onClick={on.onArchive}
      >
        <ArchiveIcon />
      </Button>
      <Menu
        label={t("mailV2.list.remind")}
        variant="icon"
        align="end"
        side={menuSide}
        disabled={busy}
        sections={[
          {
            id: "remind",
            heading: t("mailV2.list.remind"),
            items: REMINDER_KEYS.map((key) => ({
              id: key,
              label: t(REMINDER_LABEL_KEYS[key]),
              onSelect: () => on.onRemind(key),
            })),
          },
        ]}
      >
        <ClockIcon />
      </Menu>
      <Menu
        label={t("mailV2.reader.moveTo")}
        variant="icon"
        align="end"
        side={menuSide}
        disabled={busy}
        sections={[laneMenuSection(email, plan, t, on.onMoveLane)]}
      >
        <LanesIcon />
      </Menu>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t(readKey)}
        title={t(readKey)}
        disabled={busy}
        onClick={() => on.onSetRead(!email.isRead)}
      >
        {email.isRead ? <UnreadIcon /> : <ReadIcon />}
      </Button>
    </>
  );
}

/**
 * A touch screen's way to every row action (hover: none, where the overlay
 * never shows): one 44px button, named for the mail, that opens the row's
 * action sheet (row-action-sheet.tsx).
 */
function TouchActions({ subject, onOpen }: { subject: string; onOpen: () => void }) {
  const { t } = useT();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t("mailV2.row.moreFor", { subject })}
      aria-haspopup="dialog"
      onClick={onOpen}
      className="size-11"
    >
      <MoreIcon />
    </Button>
  );
}

/** Why the mail is in its lane, worded for the row; null when nothing is recorded. */
function useRowWhy(email: EmailListItem): MailRowWhy | null {
  const { t } = useT();
  const why = pushWhy(email);
  if (!why) return null;
  return why.kind === "quote"
    ? why
    : { kind: "judgment", text: t("notifCenter.judgment", { text: why.text }) };
}

interface MailRowItemProps extends Omit<MailRowsProps, "emails" | "cursorId" | "pickedIds"> {
  email: EmailListItem;
  cursor: boolean;
  picked: boolean;
  selecting: boolean;
  /** One of the last rows: its menus open upward so they stay on screen. */
  nearEnd: boolean;
  /** Open the touch action sheet for this row. */
  onActions: (target: RowActionTarget) => void;
}

function MailRowItem(props: MailRowItemProps) {
  const { email, view, accounts, time, cursor, picked, selecting } = props;
  const { t } = useT();
  const { toast } = useToast();
  const why = useRowWhy(email);
  const account = rowAccount(email, accounts);
  const subject = email.subject || t("mailV2.noSubject");
  const plan = rowActionPlan({
    isDemo: props.readOnly,
    needsReconnect: account?.needsReconnect === true,
    tier: email.tier,
  });
  const archiveBlocked = plan.archive.blockedReason ? t(plan.archive.blockedReason) : null;
  const laterBlocked = plan.later.blockedReason ? t(plan.later.blockedReason) : null;
  const laneBlocked = plan.lanes.blockedReason ? t(plan.lanes.blockedReason) : null;
  const menuSide = props.nearEnd ? "top" : "bottom";
  return (
    <li {...{ [TRIAGE_ROW_ATTR]: email.id }}>
      {picked && <span className="sr-only">{t("mailV2.bulk.rowSelected")}</span>}
      <SwipeRow
        disabled={selecting || props.busy}
        right={{
          label: t("mailV2.reader.done"),
          icon: <ArchiveIcon />,
          blockedReason: archiveBlocked,
          exits: true,
        }}
        left={{ label: t("mailV2.reader.later"), icon: <ClockIcon />, blockedReason: laterBlocked }}
        onCommit={(direction) => {
          if (direction === "right") props.onArchive(email);
          else props.onRemind(email, QUICK_LATER);
        }}
        onBlocked={(_direction, reason) => toast(reason, "info")}
      >
        <MailRow
          variant="brief"
          sender={senderName(email.from)}
          subject={subject}
          snippet={email.snippet ?? undefined}
          why={why}
          threadCount={email.threadCount}
          lane={email.tier}
          time={formatRowTime(email.date, time.now, time.locale, time.timeZone)}
          timeIso={email.date}
          tier={rowLane(view, email.tier)}
          compact={props.compact}
          // No AttentionItem yet: the mail is listed, but no lane is claimed.
          tierPending={email.tier === null ? t("mailV2.row.sorting") : undefined}
          source={account ? { provider: account.provider, nickname: account.nickname } : null}
          unread={!email.isRead}
          hasAttachment={email.attachmentCount > 0}
          selected={cursor}
          href={`/email/${email.id}?markRead=false&queue=${readerQueue(view.filter)}`}
          className={!cursor && picked ? PICKED_CLASS : ""}
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
              <RowActions
                email={email}
                plan={plan}
                busy={props.busy}
                archiveBlocked={archiveBlocked}
                onArchive={() => props.onArchive(email)}
                onSetRead={(isRead) => props.onSetRead(email, isRead)}
                onRemind={(key) => props.onRemind(email, key)}
                onMoveLane={(tier) => props.onMoveLane(email, tier)}
                menuSide={menuSide}
              />
            )
          }
          touchActions={
            props.readOnly || selecting ? undefined : (
              <TouchActions
                subject={subject}
                onOpen={() =>
                  props.onActions({
                    email,
                    subject,
                    blocked: { archive: archiveBlocked, later: laterBlocked, lanes: laneBlocked },
                  })
                }
              />
            )
          }
        />
      </SwipeRow>
    </li>
  );
}

export function MailRows(props: MailRowsProps) {
  const { emails, cursorId, pickedIds, ...rest } = props;
  const selecting = pickedIds.size > 0;
  const [sheet, setSheet] = useState<RowActionTarget | null>(null);
  return (
    <>
      <ul className="flex flex-col divide-y divide-line-soft">
        {emails.map((email, index) => (
          <MailRowItem
            key={email.id}
            {...rest}
            email={email}
            cursor={cursorId === email.id}
            picked={pickedIds.has(email.id)}
            selecting={selecting}
            nearEnd={index >= emails.length - MENU_UP_ROWS}
            onActions={setSheet}
          />
        ))}
      </ul>
      <RowActionSheet
        target={sheet}
        busy={props.busy}
        onClose={() => setSheet(null)}
        onArchive={props.onArchive}
        onRemind={props.onRemind}
        onSetRead={props.onSetRead}
        onSelect={(email) => props.onPick(email, false)}
        onMoveLane={props.onMoveLane}
      />
    </>
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
    <ul className="flex flex-col divide-y divide-line-soft">
      {threads.map((thread) => {
        const names = thread.participants.map(senderName).join(", ");
        return (
          <li key={thread.threadId}>
            <MailRow
              sender={names}
              threadCount={thread.messageCount}
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
    <SkeletonGroup label={t("mailV2.loading")} className="divide-y divide-line-soft">
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
      <p className="text-role-caption tabular-nums text-ink-muted">
        {t("mailV2.shown", { shown: String(shown), total: String(total) })}
      </p>
    </div>
  );
}
