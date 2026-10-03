"use client";

/**
 * Mail v2 list (productization plan §1, P5a, MAIL_V2): lanes are Mail's
 * primary filter, accounts are one unified list with a source badge and a
 * facet, and a row carries one badge of each kind. Rendered by /email only
 * when the API reports `user.mailV2`; the legacy list is untouched.
 *
 * This file owns the view state and wires the pieces: the header (controls),
 * the list (rows and states), the actions hook and — when KEYBOARD_TRIAGE is
 * also on — the P4 hotkey registry.
 */

import type { EmailListItem, EmailUndoActionResponse } from "@klorn/contract";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ComposeModal } from "../../../components/compose-modal";
import { useToast } from "../../../components/toast";
import Button from "../../../components/ui/button";
import { apiFetch } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";
import { captureClientError } from "../../../lib/sentry";
import { useKeyboardTriage } from "../../../lib/use-hotkeys";
import { UNDO_NOTICE_SECONDS } from "../use-lane-move";
import { useListTriage } from "../use-list-triage";
import { MailHeader } from "./mail-header";
import {
  LoadMore,
  MailListEmpty,
  MailListError,
  MailListLoading,
  MailRows,
  ThreadRows,
} from "./mail-list";
import { MailNotices, SelectionBar } from "./mail-notices";
import { ALL_ACCOUNTS, type ListView, readerQueue } from "./model";
import { useMailActions } from "./use-mail-actions";
import { useMailList } from "./use-mail-list";
import { useViewState } from "./use-view-state";

const DEFAULT_TIME_ZONE = "Asia/Seoul";

interface ReaderUndo {
  action: "archive" | "delete";
  gmailId: string;
  subject: string | null;
}

/** The reader hands an archive / delete back to the list to offer its undo. */
function readerUndoFrom(params: ReturnType<typeof useSearchParams>): ReaderUndo | null {
  const action = params?.get("undoAction");
  const gmailId = params?.get("undoGmailId")?.trim();
  if ((action !== "archive" && action !== "delete") || !gmailId) return null;
  return { action, gmailId, subject: params?.get("undoSubject") || null };
}

export function MailV2() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, locale } = useT();
  const { toast } = useToast();
  const { user } = useAuth();
  const keyboardTriage = useKeyboardTriage();
  const searchRef = useRef<HTMLInputElement>(null);

  const [view, setView] = useViewState();
  const [searchDraft, setSearchDraft] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [readerUndoBusy, setReaderUndoBusy] = useState(false);

  const list = useMailList(view);
  const actions = useMailActions(list);
  const { emails, threads, isDemo } = list;
  const readerUndo = useMemo(() => readerUndoFrom(searchParams), [searchParams]);

  const { lane, account, filter, search } = view;

  // A selection must never outlive the rows it was made on: every dimension
  // that changes the visible set clears it, or a bulk action could hit mail
  // that is no longer on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view's parts are the triggers; the setter is stable
  useEffect(() => {
    setPickedIds(new Set());
  }, [lane, account, filter, search]);

  // An account that was disconnected elsewhere must not leave the list scoped
  // to nothing: fall back to every account once the real set is known.
  useEffect(() => {
    if (account === ALL_ACCOUNTS || list.accounts.length === 0) return;
    if (!list.accounts.some((option) => option.scope === account)) {
      setView((prev) => ({ ...prev, account: ALL_ACCOUNTS }));
    }
  }, [account, list.accounts, setView]);

  // The reader's undo offer leaves on its own, like the other two notices.
  useEffect(() => {
    if (!readerUndo) return;
    const timer = setTimeout(() => router.replace("/email"), UNDO_NOTICE_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [readerUndo, router]);

  const changeView = (patch: Partial<ListView>) => {
    actions.setError(null);
    setView((prev) => ({ ...prev, ...patch }));
  };
  const clearNarrowing = () => {
    setSearchDraft("");
    changeView({ account: ALL_ACCOUNTS, filter: "none", search: "" });
  };

  const openEmail = (email: EmailListItem, intent?: "reply") => {
    const params = new URLSearchParams({ markRead: "false", queue: readerQueue(filter) });
    if (intent) params.set("focus", intent);
    router.push(`/email/${email.id}?${params.toString()}`);
  };

  const undoFromReader = async () => {
    if (!readerUndo || readerUndoBusy) return;
    setReaderUndoBusy(true);
    actions.setError(null);
    try {
      const data = await apiFetch<EmailUndoActionResponse>(
        `/api/email/${encodeURIComponent(readerUndo.gmailId)}/${readerUndo.action}/undo`,
        { method: "POST", body: JSON.stringify({ gmailId: readerUndo.gmailId }) },
      );
      toast(t("mailV2.undo.restored"), "success");
      router.replace(`/email/${data.emailId}?markRead=false`);
    } catch (err) {
      captureClientError(err, { scope: "email.v2.readerUndo", action: readerUndo.action });
      actions.setError(t("mailV2.undo.failed"));
      router.replace("/email");
    } finally {
      setReaderUndoBusy(false);
    }
  };

  const { laneMove, archived } = actions;
  const undoLabel = t(keyboardTriage ? "undo.action" : "mailV2.undo");
  const undoLatest = () => {
    if (laneMove.notice) void laneMove.undo();
    else if (archived) void actions.undoArchive();
    else if (readerUndo) void undoFromReader();
  };

  // KEYBOARD_TRIAGE (P4): the same registry and hook as the legacy list, so the
  // `?` sheet and the palette describe this list without a second key table.
  const { cursorId } = useListTriage({
    active: keyboardTriage,
    emails,
    setSelectedIds: setPickedIds,
    open: openEmail,
    archive: (email) => void actions.archive([email]),
    archiveBlockedReason: () =>
      isDemo ? t("keys.reason.demo") : actions.busy ? t("keys.reason.busy") : null,
    laneBlockedReason: () => (isDemo ? t("keys.reason.demo") : null),
    moveLane: (email, tier) => {
      actions.setError(null);
      actions.dismissArchived();
      laneMove.move({ id: email.id, subject: email.subject || null, tier: email.tier }, tier);
    },
    undo: undoLatest,
    canUndo: Boolean(laneMove.notice || archived || readerUndo) && !actions.busy,
    compose: () => setComposeOpen(true),
    focusSearch: () => searchRef.current?.focus(),
  });

  const picked = emails.filter((email) => pickedIds.has(email.id));
  const time = {
    now: new Date(),
    locale,
    timeZone: user?.timezone || DEFAULT_TIME_ZONE,
  };
  const rowCount = emails.length + threads.length;

  return (
    <>
      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 pb-24 pt-4 md:px-8 md:pb-10 md:pt-8">
        <MailHeader
          view={view}
          onChange={changeView}
          searchDraft={searchDraft}
          onSearchDraft={setSearchDraft}
          searchRef={searchRef}
          counts={list.counts}
          accounts={list.accounts}
          isDemo={isDemo}
          syncing={actions.busy === "sync"}
          onCompose={() => setComposeOpen(true)}
          onSync={() => void actions.sync()}
          onReanalyze={() => void actions.reanalyzeAttachments()}
        />

        {isDemo && (
          <p className="flex flex-wrap items-center gap-x-2 rounded-card border border-state-info-line bg-state-info-bg px-3 py-2 text-body text-state-info-ink">
            {t("mailV2.demo")}
            <Link
              href="/settings/accounts"
              className="focus-ring rounded-control font-medium underline"
            >
              {t("mailV2.demo.connect")}
            </Link>
          </p>
        )}

        {actions.error && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-card border border-state-danger-line bg-state-danger-bg py-1 pl-3 pr-1 text-body text-state-danger-ink"
          >
            <p className="min-w-0 flex-1">{actions.error}</p>
            <Button variant="ghost" size="sm" onClick={() => actions.setError(null)}>
              {t("mailV2.dismiss")}
            </Button>
          </div>
        )}

        <SelectionBar
          count={picked.length}
          readOnly={isDemo}
          onMarkRead={() => void actions.setRead(picked, true)}
          onArchive={() => void actions.archive(picked)}
          onClear={() => setPickedIds(new Set())}
        />

        <section aria-label={t("nav.mail")} aria-busy={list.loading}>
          {list.loading ? (
            <MailListLoading />
          ) : list.failed ? (
            <MailListError onRetry={list.retry} />
          ) : rowCount === 0 ? (
            <MailListEmpty view={view} onClear={clearNarrowing} />
          ) : (
            <>
              {filter === "threads" ? (
                <ThreadRows threads={threads} time={time} />
              ) : (
                <MailRows
                  emails={emails}
                  view={view}
                  accounts={list.accounts}
                  time={time}
                  cursorId={cursorId}
                  pickedIds={pickedIds}
                  readOnly={isDemo}
                  busy={actions.busy !== null}
                  onArchive={(email) => void actions.archive([email])}
                  onSetRead={(email, isRead) => void actions.setRead([email], isRead)}
                />
              )}
              <LoadMore
                shown={rowCount}
                total={list.total}
                hasMore={list.hasMore}
                loading={list.loadingMore}
                onLoadMore={list.loadMore}
              />
            </>
          )}
        </section>
      </div>

      <MailNotices
        actions={actions}
        undoLabel={undoLabel}
        reader={
          readerUndo && {
            action: readerUndo.action,
            subject: readerUndo.subject,
            busy: readerUndoBusy,
            onUndo: () => void undoFromReader(),
            onDismiss: () => router.replace("/email"),
          }
        }
      />
    </>
  );
}

export default MailV2;
