"use client";

/**
 * Mail v2 actions (productization plan P5, MAIL_V2): sync, archive with undo,
 * read state, and the lane move it shares with the reader (use-lane-move).
 * Each one changes the list first and tells the user when the server refuses —
 * never a silent revert. The server resolves every mail's own account from its
 * id, so nothing here assumes the primary one.
 */

import type {
  EmailBulkActionResponse,
  EmailListItem,
  EmailUndoActionResponse,
  LiveTier,
} from "@klorn/contract";
import { useCallback, useEffect, useState } from "react";
import { useToast } from "../../../components/toast";
import { apiFetch } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { captureClientError } from "../../../lib/sentry";
import { serverErrorMessage } from "../../../lib/server-error";
import { UNDO_NOTICE_SECONDS, useLaneMove } from "../use-lane-move";
import { REMINDER_LABEL_KEYS, type ReminderKey, reminderDate } from "./reminders";
import type { MailList } from "./use-mail-list";

export interface ArchivedNotice {
  emails: ReadonlyArray<{ id: string; gmailId: string; subject: string }>;
}

type Busy = "sync" | "row" | "undo" | "reanalyze" | "remind";

interface SyncResult {
  synced?: number;
  newCount?: number;
  error?: string;
}

const isNotConnected = (message: string) => message.toLowerCase().includes("not connected");

export function useMailActions(list: MailList) {
  const { t } = useT();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [archived, setArchived] = useState<ArchivedNotice | null>(null);
  const { patchRows, restoreRows, refresh } = list;

  const applyLane = useCallback(
    (emailId: string, tier: LiveTier | null) => {
      patchRows((rows) => rows.map((row) => (row.id === emailId ? { ...row, tier } : row)));
    },
    [patchRows],
  );
  const settle = useCallback(() => void refresh(), [refresh]);
  const laneMove = useLaneMove({ apply: applyLane, onError: setError, onSettled: settle });

  // The archive notice leaves on its own, like the lane notice does.
  useEffect(() => {
    if (!archived) return;
    const timer = setTimeout(() => setArchived(null), UNDO_NOTICE_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [archived]);

  const bulk = async (ids: string[], action: "archive" | "mark-read" | "mark-unread") => {
    const data = await apiFetch<EmailBulkActionResponse>("/api/email/bulk", {
      method: "POST",
      body: JSON.stringify({ ids, action }),
    });
    const failure = data.failed?.[0];
    if (failure) throw new Error(`API 200: ${JSON.stringify({ error: failure.error })}`);
  };

  /** The rows leave at once; a refusal puts them back and says why. */
  const archive = async (emails: readonly EmailListItem[]) => {
    if (busy || emails.length === 0) return;
    const ids = new Set(emails.map((email) => email.id));
    setBusy("row");
    setError(null);
    laneMove.dismiss();
    const snapshot = patchRows((rows) => rows.filter((row) => !ids.has(row.id)));
    setArchived({
      emails: emails.map((email) => ({
        id: email.id,
        gmailId: email.gmailId,
        subject: email.subject || t("mailV2.noSubject"),
      })),
    });
    try {
      await bulk([...ids], "archive");
    } catch (err) {
      captureClientError(err, { scope: "email.v2.archive", count: ids.size });
      restoreRows(snapshot);
      setArchived(null);
      setError(serverErrorMessage(err, t("undo.archive.failed")));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const undoArchive = async () => {
    if (!archived || busy) return;
    setBusy("undo");
    setError(null);
    const results = await Promise.allSettled(
      archived.emails.map((email) =>
        apiFetch<EmailUndoActionResponse>(
          `/api/email/${encodeURIComponent(email.gmailId)}/archive/undo`,
          { method: "POST", body: JSON.stringify({ gmailId: email.gmailId }) },
        ),
      ),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      captureClientError(failures[0].reason, { scope: "email.v2.archive.undo" });
      setError(t("mailV2.undo.failed"));
    } else {
      toast(t("mailV2.undo.restored"), "success");
    }
    setArchived(null);
    setBusy(null);
    void refresh();
  };

  const setRead = async (emails: readonly EmailListItem[], isRead: boolean) => {
    if (busy || emails.length === 0) return;
    const ids = new Set(emails.map((email) => email.id));
    setBusy("row");
    setError(null);
    const snapshot = patchRows((rows) =>
      rows.map((row) => (ids.has(row.id) ? { ...row, isRead } : row)),
    );
    try {
      await bulk([...ids], isRead ? "mark-read" : "mark-unread");
    } catch (err) {
      captureClientError(err, { scope: "email.v2.read", count: ids.size });
      restoreRows(snapshot);
      setError(serverErrorMessage(err, t("mailV2.read.failed")));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  /** A reminder about one mail. Nothing on the row changes; the toast confirms it. */
  const remind = async (email: EmailListItem, key: ReminderKey) => {
    if (busy) return;
    setBusy("remind");
    setError(null);
    const subject = email.subject || t("mailV2.noSubject");
    try {
      await apiFetch("/api/reminders", {
        method: "POST",
        body: JSON.stringify({
          title: t(
            email.needsReply
              ? "emailDetail.reminderTitle.replyTo"
              : "emailDetail.reminderTitle.review",
            { subject },
          ),
          remindAt: reminderDate(key, new Date()).toISOString(),
          description: [`From: ${email.from}`, `Open: /email/${email.id}`].join("\n"),
        }),
      });
      toast(t("mailV2.list.remind.set", { when: t(REMINDER_LABEL_KEYS[key]) }), "success");
    } catch (err) {
      captureClientError(err, { scope: "email.v2.remind", option: key });
      setError(serverErrorMessage(err, t("mailV2.list.remind.failed")));
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    if (busy) return;
    setBusy("sync");
    setError(null);
    try {
      const result = await apiFetch<SyncResult>("/api/email/sync", {
        method: "POST",
        body: JSON.stringify({}),
      });
      // The route answers 200 with { error } on a dead token; treating that as
      // success is how a broken connection once looked healthy for days.
      if (result?.error) throw new Error(result.error);
      await refresh();
      const fresh = typeof result?.newCount === "number" ? result.newCount : 0;
      toast(
        fresh > 0 ? t("mailV2.sync.new", { count: String(fresh) }) : t("mailV2.sync.nothingNew"),
        "success",
      );
    } catch (err) {
      captureClientError(err, { scope: "email.v2.sync" });
      const message = err instanceof Error ? err.message : "";
      setError(t(isNotConnected(message) ? "mailV2.sync.notConnected" : "mailV2.sync.failed"));
    } finally {
      setBusy(null);
    }
  };

  const reanalyzeAttachments = async () => {
    if (busy) return;
    setBusy("reanalyze");
    setError(null);
    try {
      await apiFetch("/api/email/attachments/analyze", {
        method: "POST",
        body: JSON.stringify({ retryFallback: true, limit: 50 }),
      });
      await refresh();
      toast(t("mailV2.reanalyze.done"), "success");
    } catch (err) {
      captureClientError(err, { scope: "email.v2.reanalyze" });
      setError(t("mailV2.reanalyze.failed"));
    } finally {
      setBusy(null);
    }
  };

  return {
    error,
    setError,
    busy,
    archived,
    dismissArchived: () => setArchived(null),
    archive,
    undoArchive,
    setRead,
    remind,
    sync,
    reanalyzeAttachments,
    laneMove,
  };
}

export type MailActions = ReturnType<typeof useMailActions>;
