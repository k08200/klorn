"use client";

/**
 * Mail v2 reader (productization plan §1, P5b, MAIL_V2). Rendered by
 * /email/[id] only when the API reports `user.mailV2`; the legacy reader is
 * untouched. Layout only: the page still owns the mail, its actions and the
 * reused pieces (reply composer, thread, attachments, analysis), which arrive
 * here as slots. The body is the sender's HTML inside MailHtmlBody's sandboxed
 * iframe when the API sends renderHtml, else the plain-text renderer
 * (linkifyText) — no sender HTML is ever injected into this document.
 *
 * Order: a back bar that stays in reach, the header with everything that left
 * the list row, the actions, then the message first and Klorn's reading of it
 * beside (or, on a phone, below) it.
 *
 * On a phone (mobile redesign PR3, MB1, LOCKED 2026-11-14) the reader is full
 * screen: the shell drops its header, tab bar and floating assistant button
 * (app-shell.tsx), the top bar carries Back, the assistant and More, and
 * Reply · Later · Done sit on the bottom edge (reader-actions.tsx). There,
 * and on a half-folded screen, Reply opens the reply box in a sheet / the
 * bottom segment instead of inline (reply-composer.tsx, PR4).
 */

import type { LiveTier } from "@klorn/contract";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import MailHtmlBody from "../../../../components/mail-html-body";
import { useToast } from "../../../../components/toast";
import Button from "../../../../components/ui/button";
import EmptyState from "../../../../components/ui/empty-state";
import { useLaneName } from "../../../../components/ui/lane-chip";
import { Skeleton, SkeletonGroup } from "../../../../components/ui/skeleton";
import { openAssistant } from "../../../../lib/assistant-ask";
import { useT } from "../../../../lib/i18n";
import { linkifyText } from "../../../../lib/linkify";
import { useDisplayTimeZone } from "../../../../lib/use-time-zone";
import { BackIcon, ChevronDownIcon, ChevronUpIcon } from "../../_v2/icons";
import type { ReminderKey } from "../../_v2/reminders";
import { UndoBar } from "../../_v2/undo-bar";
import { UNDO_NOTICE_SECONDS, type useLaneMove } from "../../use-lane-move";
import type { EmailDetail, UndoNotice } from "../types";
import { REPLY_ENTRY_EVENT, takeReplyEntryRequest } from "../use-detail-triage";
import {
  type ReaderActionsProps,
  ReaderActionsRow,
  ReaderBottomBar,
  ReaderPhoneMore,
} from "./reader-actions";
import { type ReaderFacts, ReaderHeader } from "./reader-header";
import {
  composerEntryOnTop,
  DOCKED_READER_PADDING,
  ReplyComposer,
  type ReplyLayout,
  useComposerMode,
} from "./reply-composer";
import { SenderLabelMenu } from "./sender-label-menu";
import type { ReaderContext } from "./use-reader-context";
import { useSenderLabelCorrection } from "./use-sender-label";

export interface ReaderSlots {
  /** The reply box, laid out for the reader (inline) or the phone sheet / folded dock. */
  reply: (layout: ReplyLayout) => ReactNode;
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
  /** Ask Klorn for a reply draft (the reply box's own Draft action). */
  onDraft: () => void;
  drafting: boolean;
  /** Bumped by each sent reply; the phone sheet / folded dock closes on it. */
  replySentCount: number;
  onArchive: () => void;
  onDelete: () => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onUnsubscribe: () => void;
  onRemind: (key: ReminderKey) => void;
  slots: ReaderSlots;
}

interface TopBarProps extends ReaderV2Props {
  /** The phone's More; absent while the mail loads. */
  actions: ReaderActionsProps | null;
}

function TopBar({ reader, keyboardTriage, onOpen, actions }: TopBarProps) {
  const { t } = useT();
  const laneName = useLaneName();
  const { view, context } = reader;
  const hint = (label: string, key: string) => (keyboardTriage ? `${label} (${key})` : label);
  const newerId = context?.newerId ?? null;
  const olderId = context?.olderId ?? null;
  const router = useRouter();
  return (
    <nav
      aria-label={t("mailV2.reader.back")}
      className="sticky top-0 z-20 -mx-4 flex items-center gap-1 bg-surface-canvas px-1 max-rail:pt-[env(safe-area-inset-top)] md:-mx-8 md:px-5"
    >
      <Link
        href="/email"
        onClick={(event) => {
          // Over the open composer's history entry, not past it (reply-composer.tsx).
          // A new tab or window (modifier or middle click) keeps the browser's default.
          const plain =
            event.button === 0 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey;
          if (!plain || !composerEntryOnTop()) return;
          event.preventDefault();
          router.replace("/email");
        }}
        title={hint(t("mailV2.reader.back"), "Esc")}
        className="focus-ring flex h-11 min-w-0 items-center gap-2 rounded-control px-3 text-role-label text-ink-mid transition-colors duration-120 ease-fluid hover:bg-surface-hover hover:text-ink"
      >
        <BackIcon />
        <span className="truncate">
          {t("nav.mail")}
          <span className="text-ink-muted">
            {" · "}
            {view.lane === "ALL" ? t("mailV2.lane.all") : laneName(view.lane)}
          </span>
        </span>
      </Link>
      <span className="flex-1" />
      {/* Phone only: the floating button stands down on the full-screen reader. */}
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("assistantDock.open")}
        data-testid="reader-assistant"
        onClick={openAssistant}
        className="size-11 rail:hidden"
      >
        <span
          aria-hidden="true"
          className="flex size-7 items-center justify-center rounded-full bg-accent-solid text-role-caption font-bold text-accent-solid-ink"
        >
          K
        </span>
      </Button>
      {actions && (
        <span className="rail:hidden">
          <ReaderPhoneMore {...actions} />
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="max-rail:hidden"
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
        className="max-rail:hidden"
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

function PlainBody({ body }: { body: string }) {
  return (
    <pre className="whitespace-pre-wrap break-keep font-sans text-role-body leading-[1.55] text-ink-strong [overflow-wrap:anywhere]">
      {linkifyText(body)}
    </pre>
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
  const timeZone = useDisplayTimeZone();
  // While the next mail loads, `email` is still the previous one: never dress
  // it in the new mail's lane and neighbours.
  const current = email && (email.id === emailId || email.gmailId === emailId) ? email : null;
  const tier = reader.context?.tier ?? null;
  const senderLabel = useSenderLabelCorrection(emailId, reader);
  const composerMode = useComposerMode();
  const [replyOpen, setReplyOpen] = useState(false);
  const composing = composerMode !== "inline";
  const docked = composerMode === "dock" && replyOpen;
  // Another mail, or a width where the box is inline again: the sheet closes.
  // The draft itself lives in the page and is kept.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the mail id and mode are the triggers
  useEffect(() => {
    setReplyOpen(false);
  }, [emailId, composing]);
  // ?focus=reply and the R key ask for the reply box (focusReplyEntry); with no
  // inline box on the page, that request opens the sheet / dock.
  useEffect(() => {
    if (!composing) return;
    const open = () => {
      if (takeReplyEntryRequest()) setReplyOpen(true);
    };
    open();
    window.addEventListener(REPLY_ENTRY_EVENT, open);
    return () => window.removeEventListener(REPLY_ENTRY_EVENT, open);
  }, [composing]);
  // A sent reply closes the sheet / dock and says so (the inline box just empties).
  const { toast } = useToast();
  const sentCount = props.replySentCount;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the count is the trigger
  useEffect(() => {
    if (sentCount === 0 || !composing) return;
    setReplyOpen(false);
    toast(t("compose.toast.sent"), "success");
  }, [sentCount]);
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
    onReply: composing ? () => setReplyOpen(true) : props.onReply,
    onDraft: composing
      ? () => {
          setReplyOpen(true);
          props.onDraft();
        }
      : props.onDraft,
    drafting: props.drafting,
    onArchive: props.onArchive,
    onDelete: props.onDelete,
    onToggleRead: props.onToggleRead,
    onToggleStar: props.onToggleStar,
    onUnsubscribe: props.onUnsubscribe,
    onRemind: props.onRemind,
    onMoveLane: moveLane,
  };

  return (
    <div
      className="flex w-full max-w-[calc(1120px+4rem)] flex-col px-4 pb-28 md:px-8 md:pb-10"
      style={docked ? { paddingBottom: DOCKED_READER_PADDING } : undefined}
    >
      <TopBar {...props} actions={actions || null} />

      {props.error && current && (
        <div
          role="alert"
          className="mt-2 flex items-center gap-2 rounded-control border border-state-danger-line bg-state-danger-bg py-1 pl-3 pr-1 text-role-body text-state-danger-ink"
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
            lanes={actions}
            email={current}
            context={reader.context}
            contextPending={reader.pending}
            account={reader.account}
            facts={props.facts}
            locale={locale}
            timeZone={timeZone}
            senderLabel={
              senderLabel.label && (
                <SenderLabelMenu label={senderLabel.label} onCorrect={senderLabel.correct} />
              )
            }
          />
          <ReaderActionsRow {...actions} />

          {/* Columns by the reader's own width (the split view makes it narrower
              than the viewport). Only this grid is a container: containment on
              an ancestor of the fixed bottom bar / undo bar would pin them to it. */}
          <div className="@container">
            <div className="grid gap-6 border-t border-line-soft pt-5 @min-[880px]:grid-cols-[minmax(0,1fr)_20rem] @min-[880px]:items-start">
              <div className="flex min-w-0 flex-col gap-5 *:m-0">
                {current.renderHtml ? (
                  <section aria-label={t("emailDetail.messageTitle")}>
                    <MailHtmlBody
                      key={current.id}
                      emailId={current.id}
                      html={current.renderHtml}
                      plain={current.body ? <PlainBody body={current.body} /> : null}
                    />
                  </section>
                ) : current.body ? (
                  <section aria-label={t("emailDetail.messageTitle")}>
                    <PlainBody body={current.body} />
                  </section>
                ) : current.snippet ? (
                  <section aria-label={t("emailDetail.previewTitle")}>
                    <p className="text-role-caption text-ink-muted">
                      {t("emailDetail.previewTitle")}
                    </p>
                    <p className="mt-1 text-role-body leading-6 text-ink-mid">
                      {linkifyText(current.snippet)}
                    </p>
                  </section>
                ) : null}
                {slots.attachments}
                {slots.candidate}
                {!composing && slots.reply("inline")}
              </div>
              <aside className="flex min-w-0 flex-col gap-4 *:m-0">
                {slots.analysis}
                {slots.thread}
                {slots.context}
              </aside>
            </div>
          </div>
          <ReaderBottomBar {...actions} />
          {composerMode !== "inline" && (
            <ReplyComposer
              mode={composerMode}
              open={replyOpen}
              onClose={() => setReplyOpen(false)}
              error={props.error}
              onDismissError={props.onDismissError}
              subject={current.subject || t("common.noSubject")}
              original={current.body || current.snippet || null}
            >
              {slots.reply("sheet")}
            </ReplyComposer>
          )}
        </article>
      )}

      <Notices {...props} />
    </div>
  );
}

export default ReaderV2;
