"use client";

/**
 * Mail v2 reader (productization plan §1, P5b, MAIL_V2). Rendered by
 * /email/[id] only when the API reports `user.mailV2`; the legacy reader is
 * untouched. Layout only: the page still owns the mail, its actions and the
 * reused pieces (reply composer, thread, attachments, analysis), which arrive
 * here as slots. The body is the existing plain-text renderer (linkifyText) —
 * no HTML from a sender is ever injected.
 *
 * Order: a back bar that stays in reach, the header with everything that left
 * the list row, the actions, then the message first and Klorn's reading of it
 * beside (or, on a phone, below) it.
 */

import type { LiveTier } from "@klorn/contract";
import Link from "next/link";
import { type ReactNode, useEffect } from "react";
import Button from "../../../../components/ui/button";
import EmptyState from "../../../../components/ui/empty-state";
import { Skeleton, SkeletonGroup } from "../../../../components/ui/skeleton";
import { useAuth } from "../../../../lib/auth";
import { useT } from "../../../../lib/i18n";
import { linkifyText } from "../../../../lib/linkify";
import { BackIcon, ChevronDownIcon, ChevronUpIcon } from "../../_v2/icons";
import type { ReminderKey } from "../../_v2/reminders";
import { UndoBar } from "../../_v2/undo-bar";
import { UNDO_NOTICE_SECONDS, type useLaneMove } from "../../use-lane-move";
import type { EmailDetail, UndoNotice } from "../types";
import { ReaderActionsRow, ReaderBottomBar } from "./reader-actions";
import { type ReaderFacts, ReaderHeader } from "./reader-header";
import type { ReaderContext } from "./use-reader-context";

const DEFAULT_TIME_ZONE = "Asia/Seoul";

export interface ReaderSlots {
  reply: ReactNode;
  thread: ReactNode;
  attachments: ReactNode;
  candidate: ReactNode;
  analysis: ReactNode;
  /** Thread brief and sender context. */
  context: ReactNode;
}

export interface ReaderV2Props {
  /** The id in the URL; `email` may still be the previous mail while it loads. */
  emailId: string | undefined;
  email: EmailDetail | null;
  loading: boolean;
  error: string | null;
  onDismissError: () => void;
  onRetry: () => void;
  reader: ReaderContext;
  facts: ReaderFacts;
  busy: string | null;
  reminderBusy: boolean;
  keyboardTriage: boolean;
  laneMove: ReturnType<typeof useLaneMove>;
  undo: { notice: UndoNotice | null; onUndo: () => void; onDismiss: () => void };
  onOpen: (emailId: string) => void;
  onReply: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onUnsubscribe: () => void;
  onRemind: (key: ReminderKey) => void;
  slots: ReaderSlots;
}

function TopBar({ reader, keyboardTriage, onOpen }: ReaderV2Props) {
  const { t } = useT();
  const { view, context } = reader;
  const hint = (label: string, key: string) => (keyboardTriage ? `${label} (${key})` : label);
  const newerId = context?.newerId ?? null;
  const olderId = context?.olderId ?? null;
  return (
    <nav
      aria-label={t("mailV2.reader.back")}
      className="sticky top-0 z-20 -mx-4 flex items-center gap-1 bg-surface-canvas px-1 md:-mx-8 md:px-5"
    >
      <Link
        href="/email"
        title={hint(t("mailV2.reader.back"), "Esc")}
        className="focus-ring flex h-11 min-w-0 items-center gap-2 rounded-control px-3 text-label text-ink-mid transition-colors duration-120 ease-fluid hover:bg-surface-hover hover:text-ink"
      >
        <BackIcon />
        <span className="truncate">
          {t("nav.mail")}
          <span className="text-ink-muted">
            {" · "}
            {view.lane === "ALL" ? t("mailV2.lane.all") : view.lane}
          </span>
        </span>
      </Link>
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("keys.prev")}
        title={newerId ? hint(t("keys.prev"), "K") : t("mailV2.reader.noPrev")}
        disabled={!newerId}
        onClick={() => newerId && onOpen(newerId)}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("keys.next")}
        title={olderId ? hint(t("keys.next"), "J") : t("mailV2.reader.noNext")}
        disabled={!olderId}
        onClick={() => olderId && onOpen(olderId)}
      >
        <ChevronDownIcon />
      </Button>
    </nav>
  );
}

function ReaderSkeleton() {
  const { t } = useT();
  return (
    <SkeletonGroup label={t("emailDetail.loadingLabel")} className="flex flex-col gap-4 pt-2">
      <Skeleton variant="block" width="w-2/3" height="h-8" />
      <Skeleton width="w-1/2" />
      <Skeleton width="w-1/3" />
      <Skeleton variant="block" height="h-64" className="mt-4" />
    </SkeletonGroup>
  );
}

/** The single undo notice: a lane move first, then an archive / delete handed over. */
function Notices({ laneMove, undo, busy, keyboardTriage }: ReaderV2Props) {
  const { t } = useT();
  const undoLabel = t(keyboardTriage ? "undo.action" : "mailV2.undo");
  const { notice, onDismiss } = undo;

  // The archive / delete offer leaves on its own, like the lane notice does.
  const noticeId = notice?.gmailId ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the notice's identity is the trigger; onDismiss is a fresh closure every render
  useEffect(() => {
    if (!noticeId) return;
    const timer = setTimeout(onDismiss, UNDO_NOTICE_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [noticeId]);

  if (laneMove.notice) {
    return (
      <UndoBar
        raised
        title={t("undo.lane.moved", { lane: laneMove.notice.tier })}
        detail={laneMove.notice.subject ?? undefined}
        undoLabel={undoLabel}
        busy={laneMove.busy}
        onUndo={() => void laneMove.undo()}
        onDismiss={laneMove.dismiss}
      />
    );
  }
  if (notice) {
    return (
      <UndoBar
        raised
        title={t(notice.action === "archive" ? "mailV2.archive.done" : "mailV2.delete.done")}
        detail={notice.subject ?? undefined}
        undoLabel={undoLabel}
        busy={busy === "undo"}
        onUndo={undo.onUndo}
        onDismiss={onDismiss}
      />
    );
  }
  return null;
}

export function ReaderV2(props: ReaderV2Props) {
  const { emailId, email, reader, slots, laneMove } = props;
  const { t, locale } = useT();
  const { user } = useAuth();
  // While the next mail loads, `email` is still the previous one: never dress
  // it in the new mail's lane and neighbours.
  const current = email && (email.id === emailId || email.gmailId === emailId) ? email : null;
  const tier = reader.context?.tier ?? null;
  const moveLane = (lane: LiveTier) => {
    if (current && tier) {
      laneMove.move({ id: current.id, subject: current.subject || null, tier }, lane);
    }
  };
  const actions = current && {
    email: current,
    tier,
    busy: props.busy ?? (laneMove.busy ? "lane" : null),
    reminderBusy: props.reminderBusy,
    isDemo: current.id.startsWith("demo-"),
    accountNeedsReconnect: reader.account?.needsReconnect === true,
    keyboardTriage: props.keyboardTriage,
    onReply: props.onReply,
    onArchive: props.onArchive,
    onDelete: props.onDelete,
    onToggleRead: props.onToggleRead,
    onToggleStar: props.onToggleStar,
    onUnsubscribe: props.onUnsubscribe,
    onRemind: props.onRemind,
    onMoveLane: moveLane,
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col px-4 pb-40 md:px-8 md:pb-10">
      <TopBar {...props} />

      {props.error && current && (
        <div
          role="alert"
          className="mt-2 flex items-center gap-2 rounded-card border border-state-danger-line bg-state-danger-bg py-1 pl-3 pr-1 text-body text-state-danger-ink"
        >
          <p className="min-w-0 flex-1">{props.error}</p>
          <Button variant="ghost" size="sm" onClick={props.onDismissError}>
            {t("mailV2.dismiss")}
          </Button>
        </div>
      )}

      {!current && props.loading && <ReaderSkeleton />}

      {!current && !props.loading && (
        <div role="alert">
          <EmptyState
            headingLevel="h2"
            title={t("mailV2.reader.error.title")}
            description={props.error ?? t("emailDetail.error.load")}
            primaryAction={{ label: t("mailV2.retry"), onClick: props.onRetry }}
          />
        </div>
      )}

      {current && actions && (
        <article className="flex flex-col gap-5 pt-2">
          <ReaderHeader
            email={current}
            context={reader.context}
            contextPending={reader.pending}
            account={reader.account}
            facts={props.facts}
            locale={locale}
            timeZone={user?.timezone || DEFAULT_TIME_ZONE}
          />
          <ReaderActionsRow {...actions} />

          <div className="grid gap-6 border-t border-line-soft pt-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
            <div className="flex min-w-0 flex-col gap-5 *:m-0">
              {current.body ? (
                <section aria-label={t("emailDetail.messageTitle")}>
                  <pre className="whitespace-pre-wrap break-keep font-sans text-body leading-6 text-ink-strong [overflow-wrap:anywhere]">
                    {linkifyText(current.body)}
                  </pre>
                </section>
              ) : current.snippet ? (
                <section aria-label={t("emailDetail.previewTitle")}>
                  <p className="text-caption text-ink-muted">{t("emailDetail.previewTitle")}</p>
                  <p className="mt-1 text-body leading-6 text-ink-mid">
                    {linkifyText(current.snippet)}
                  </p>
                </section>
              ) : null}
              {slots.attachments}
              {slots.candidate}
              {slots.reply}
            </div>
            <aside className="flex min-w-0 flex-col gap-4 *:m-0">
              {slots.analysis}
              {slots.thread}
              {slots.context}
            </aside>
          </div>
          <ReaderBottomBar {...actions} />
        </article>
      )}

      <Notices {...props} />
    </div>
  );
}

export default ReaderV2;
