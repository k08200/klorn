"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { useConfirm } from "../../../components/confirm-dialog";
import { useToast } from "../../../components/toast";
import { TrustBadgeChip } from "../../../components/trust-badge";
import ErrorAlert from "../../../components/ui/error-alert";
import LoadingState from "../../../components/ui/loading-state";
import { API_BASE, apiFetch, authHeaders } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { linkifyText } from "../../../lib/linkify";
import { captureClientError } from "../../../lib/sentry";
import { serverErrorMessage } from "../../../lib/server-error";
import { formatBytes, ProfileFact, senderName } from "./atoms";
import { AttachmentAnalysis } from "./attachment-analysis";
import { EmailActionToolbar, EmailReminderQuickActions, UndoActionBanner } from "./toolbar";

// Domain types and the reminder option list live in ./types.ts so
// sibling components (atoms.tsx, toolbar.tsx, future
// candidate/attachment/reply extractions) can import them without
// going through page.tsx.
import type {
  AttachmentCandidateProfile,
  CandidateIntake,
  CandidateIntakeStatus,
  EmailAttachment,
  EmailDetail,
  EmailPriority,
  EmailReminderKey,
  EmailReminderOption,
  NextEmailSummary,
  ReplyDraft,
  UndoActionResponse,
  UndoableEmailAction,
  UndoNotice,
} from "./types";
import { EMAIL_REMINDER_OPTIONS } from "./types";

type EmailQueueKey =
  | "all"
  | "reply-needed"
  | "urgent"
  | "unread"
  | "attachments"
  | "candidates"
  | "finance"
  | "legal"
  | "sales"
  | "support"
  | "automated";

const EMAIL_QUEUE_KEYS = new Set<EmailQueueKey>([
  "all",
  "reply-needed",
  "urgent",
  "unread",
  "attachments",
  "candidates",
  "finance",
  "legal",
  "sales",
  "support",
  "automated",
]);

function normalizeEmailQueue(value: string | null | undefined): EmailQueueKey {
  return value && EMAIL_QUEUE_KEYS.has(value as EmailQueueKey) ? (value as EmailQueueKey) : "all";
}

function parseUndoNotice(searchParams: ReturnType<typeof useSearchParams>): UndoNotice | null {
  const action = searchParams?.get("undoAction");
  const gmailId = searchParams?.get("undoGmailId")?.trim();
  if ((action !== "archive" && action !== "delete") || !gmailId) return null;
  return {
    action,
    gmailId,
    subject: searchParams?.get("undoSubject") || null,
  };
}

function appendUndoParams(
  params: URLSearchParams,
  action: UndoableEmailAction,
  email: EmailDetail | null,
) {
  if (!email?.gmailId) return;
  params.set("undoAction", action);
  params.set("undoGmailId", email.gmailId);
  if (email.subject) params.set("undoSubject", email.subject);
}

function getReminderDate(option: EmailReminderKey): Date {
  const date = new Date();
  if (option === "later-today") {
    date.setHours(date.getHours() + 4);
    return date;
  }
  if (option === "tomorrow") {
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
    return date;
  }
  date.setDate(date.getDate() + 7);
  date.setHours(9, 0, 0, 0);
  return date;
}

interface LabelFeedback {
  id: string;
  emailId: string;
  originalPriority: EmailPriority;
  correctedPriority: EmailPriority;
  reason: string | null;
  signals: string[];
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

type ReplyNeededChoice =
  | "needed"
  | "today"
  | "waiting_on_me"
  | "waiting_on_them"
  | "not_needed"
  | "later"
  | "done";

interface ReplyNeededFeedback {
  id: string;
  choice: ReplyNeededChoice;
  signal: string;
  evidence: string | null;
  createdAt: string;
}

interface ThreadDetail {
  threadId: string;
  subject: string;
  messageCount: number;
  messages: Array<{
    id: string;
    from: string;
    subject: string;
    snippet: string | null;
    date: string;
    isRead: boolean;
    priority: EmailPriority;
    summary: string | null;
    actionItems: string[];
  }>;
}

export default function EmailDetailPage() {
  return (
    <AuthGuard>
      <EmailDetailView />
    </AuthGuard>
  );
}

function EmailDetailView() {
  const { t, locale } = useT();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const id = params?.id;
  const shouldMarkRead = searchParams?.get("markRead") === "true";
  const queue = normalizeEmailQueue(searchParams?.get("queue"));
  const undoNotice = parseUndoNotice(searchParams);
  const [email, setEmail] = useState<EmailDetail | null>(null);
  const [nextEmail, setNextEmail] = useState<NextEmailSummary | null>(null);
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [ocring, setOcring] = useState(false);
  const [draft, setDraft] = useState<ReplyDraft | null>(null);
  const [draftIntent, setDraftIntent] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [sendingDraft, setSendingDraft] = useState(false);
  const [savingGmailDraft, setSavingGmailDraft] = useState(false);
  const [savingAttachmentCorrection, setSavingAttachmentCorrection] = useState<string | null>(null);
  const [gmailDraftUrl, setGmailDraftUrl] = useState<string | null>(null);
  const [selectedDraftAttachmentIds, setSelectedDraftAttachmentIds] = useState<string[]>([]);
  const [includeBriefAttachment, setIncludeBriefAttachment] = useState(true);
  const [updatingCandidate, setUpdatingCandidate] = useState(false);
  const [reminderBusy, setReminderBusy] = useState<EmailReminderKey | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<EmailDetail | { error: string }>(`/api/email/${id}`);
      if ("error" in data) {
        setError(data.error);
      } else {
        // Reading is a GET and side-effect free; marking read is an explicit
        // write on PATCH /:id/read. Fire-and-forget: a failed mark-read must
        // not break the reading pane, and the local state is set optimistically
        // so the header doesn't flash "unread".
        const markingRead = shouldMarkRead && !data.isRead;
        if (markingRead) {
          apiFetch(`/api/email/${id}/read`, {
            method: "PATCH",
            body: JSON.stringify({ isRead: true }),
          }).catch((err) => captureClientError(err, { scope: "email.markRead", id }));
        }
        setEmail(markingRead ? { ...data, isRead: true } : data);
        setSelectedDraftAttachmentIds([]);
        setIncludeBriefAttachment((data.attachments?.length ?? 0) > 0);
        apiFetch<{ next: NextEmailSummary | null }>(
          `/api/email/${id}/next?queue=${encodeURIComponent(queue)}`,
        )
          .then((nextData) => setNextEmail(nextData.next))
          .catch((err) => {
            setNextEmail(null);
            captureClientError(err, { scope: "email.next.load", id, queue });
          });
        if (data.threadId) {
          apiFetch<ThreadDetail | { error: string }>(
            `/api/email/thread/${encodeURIComponent(data.threadId)}`,
          )
            .then((threadData) => setThread("error" in threadData ? null : threadData))
            .catch((err) => captureClientError(err, { scope: "email.thread.load", id }));
        } else {
          setThread(null);
        }
      }
    } catch (err) {
      captureClientError(err, { scope: "email.detail", id });
      setError(serverErrorMessage(err, t("emailDetail.error.load")));
    } finally {
      setLoading(false);
    }
  }, [id, queue, shouldMarkRead, t]);

  useEffect(() => {
    load();
  }, [load]);

  const [summarizing, setSummarizing] = useState(false);
  // On-demand deep re-summary (AI 정리): the server persists richer
  // summary/keyPoints/actionItems, so a reload IS the merge.
  const summarize = useCallback(async () => {
    if (!id || summarizing) return;
    setSummarizing(true);
    try {
      await apiFetch(`/api/email/${id}/summarize`, {
        method: "POST",
        body: JSON.stringify({ lang: locale }),
      });
      await load();
    } catch (err) {
      captureClientError(err, { scope: "email.summarize", id });
    } finally {
      setSummarizing(false);
    }
  }, [id, summarizing, locale, load]);

  const reanalyzeAttachments = async () => {
    if (!id || reanalyzing) return;
    setReanalyzing(true);
    setError(null);
    try {
      const data = await apiFetch<{
        analyzed: number;
        attachments: EmailAttachment[];
        candidateProfile: AttachmentCandidateProfile | null;
        candidateIntake: CandidateIntake | null;
      }>(`/api/email/${id}/attachments/analyze`, {
        method: "POST",
        body: JSON.stringify({ force: true }),
      });
      setEmail((prev) =>
        prev
          ? {
              ...prev,
              attachments: data.attachments,
              attachmentCount: data.attachments.length,
              candidateProfile: data.candidateProfile,
              candidateIntake: data.candidateIntake,
            }
          : prev,
      );
    } catch (err) {
      captureClientError(err, { scope: "email.attachments.reanalyze", id });
      setError(serverErrorMessage(err, t("emailDetail.error.reanalyzeAttachments")));
    } finally {
      setReanalyzing(false);
    }
  };

  const updateCandidateIntake = async (patch: {
    status?: CandidateIntakeStatus;
    notes?: string | null;
  }) => {
    if (!id || updatingCandidate) return;
    setUpdatingCandidate(true);
    setError(null);
    try {
      const data = await apiFetch<{ candidateIntake: CandidateIntake }>(
        `/api/email/${id}/candidate-intake`,
        {
          method: "PATCH",
          body: JSON.stringify(patch),
        },
      );
      setEmail((prev) => (prev ? { ...prev, candidateIntake: data.candidateIntake } : prev));
    } catch (err) {
      captureClientError(err, { scope: "email.candidate-intake.update", id });
      setError(serverErrorMessage(err, t("emailDetail.error.saveCandidateStatus")));
    } finally {
      setUpdatingCandidate(false);
    }
  };

  const runAttachmentOcr = async () => {
    if (!id || ocring) return;
    setOcring(true);
    setError(null);
    try {
      const data = await apiFetch<{
        results: Array<{ attachmentId: string; filename: string; status: string }>;
        attachments: EmailAttachment[];
        candidateProfile: AttachmentCandidateProfile | null;
        candidateIntake: CandidateIntake | null;
      }>(`/api/email/${id}/attachments/ocr`, {
        method: "POST",
        body: JSON.stringify({ force: false }),
      });
      setEmail((prev) =>
        prev
          ? {
              ...prev,
              attachments: data.attachments,
              attachmentCount: data.attachments.length,
              candidateProfile: data.candidateProfile,
              candidateIntake: data.candidateIntake,
            }
          : prev,
      );
    } catch (err) {
      captureClientError(err, { scope: "email.attachments.ocr", id });
      setError(serverErrorMessage(err, t("emailDetail.error.ocr")));
    } finally {
      setOcring(false);
    }
  };

  const saveAttachmentCorrection = async (
    attachment: EmailAttachment,
    patch: {
      summary: string;
      category: string;
      extractedFields: Record<string, string | number | boolean | null>;
    },
  ) => {
    if (!id || savingAttachmentCorrection) return;
    setSavingAttachmentCorrection(attachment.id);
    setError(null);
    try {
      const data = await apiFetch<{
        attachments: EmailAttachment[];
        candidateProfile: AttachmentCandidateProfile | null;
        candidateIntake: CandidateIntake | null;
      }>(`/api/email/${id}/attachments/${attachment.id}/analysis`, {
        method: "PATCH",
        body: JSON.stringify({
          summary: patch.summary,
          category: patch.category,
          keyPoints: attachment.keyPoints,
          extractedFields: patch.extractedFields,
        }),
      });
      setEmail((prev) =>
        prev
          ? {
              ...prev,
              attachments: data.attachments,
              attachmentCount: data.attachments.length,
              candidateProfile: data.candidateProfile,
              candidateIntake: data.candidateIntake,
            }
          : prev,
      );
    } catch (err) {
      captureClientError(err, { scope: "email.attachment-correction", id });
      setError(serverErrorMessage(err, t("emailDetail.error.saveAttachmentCorrection")));
    } finally {
      setSavingAttachmentCorrection(null);
    }
  };

  const generateReplyDraft = async () => {
    if (!id || drafting) return;
    setDrafting(true);
    setError(null);
    try {
      const data = await apiFetch<ReplyDraft>(`/api/email/${id}/reply-draft`, {
        method: "POST",
        body: JSON.stringify({ intent: draftIntent }),
      });
      setDraft(data);
      setGmailDraftUrl(null);
    } catch (err) {
      captureClientError(err, { scope: "email.reply-draft", id });
      setError(serverErrorMessage(err, t("emailDetail.error.replyDraft")));
    } finally {
      setDrafting(false);
    }
  };

  const sendReplyDraft = async () => {
    if (!draft || sendingDraft) return;
    setSendingDraft(true);
    setError(null);
    try {
      await apiFetch("/api/email/send", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      setDraft(null);
    } catch (err) {
      captureClientError(err, { scope: "email.reply-draft.send", id });
      setError(serverErrorMessage(err, t("emailDetail.error.sendReply")));
    } finally {
      setSendingDraft(false);
    }
  };

  const saveGmailDraft = async () => {
    if (!id || !draft || savingGmailDraft) return;
    setSavingGmailDraft(true);
    setError(null);
    try {
      const data = await apiFetch<{
        success: boolean;
        draftId?: string;
        url?: string;
        attachedCount?: number;
      }>(`/api/email/${id}/gmail-draft`, {
        method: "POST",
        body: JSON.stringify({
          to: draft.to,
          subject: draft.subject,
          body: draft.body,
          attachmentIds: selectedDraftAttachmentIds,
          includeBriefAttachment,
        }),
      });
      setGmailDraftUrl(data.url ?? "https://mail.google.com/mail/u/0/#drafts");
      setEmail((prev) =>
        prev?.candidateIntake
          ? {
              ...prev,
              candidateIntake: { ...prev.candidateIntake, status: "CONTACTED" },
            }
          : prev,
      );
    } catch (err) {
      captureClientError(err, { scope: "email.reply-draft.gmail-draft", id });
      setError(serverErrorMessage(err, t("emailDetail.error.gmailDraft")));
    } finally {
      setSavingGmailDraft(false);
    }
  };

  const toggleRead = async () => {
    if (!id || !email || actionBusy) return;
    const nextRead = !email.isRead;
    setActionBusy("read");
    setError(null);
    try {
      await apiFetch(`/api/email/${id}/read`, {
        method: "PATCH",
        body: JSON.stringify({ isRead: nextRead }),
      });
      setEmail((prev) => (prev ? { ...prev, isRead: nextRead } : prev));
    } catch (err) {
      captureClientError(err, { scope: "email.detail.toggle-read", id, nextRead });
      setError(nextRead ? t("emailDetail.error.markRead") : t("emailDetail.error.markUnread"));
    } finally {
      setActionBusy(null);
    }
  };

  const toggleStar = async () => {
    if (!id || !email || actionBusy) return;
    const nextStarred = !email.isStarred;
    setActionBusy("star");
    setError(null);
    try {
      await apiFetch(`/api/email/${id}/star`, {
        method: "PATCH",
        body: JSON.stringify({ isStarred: nextStarred }),
      });
      setEmail((prev) => (prev ? { ...prev, isStarred: nextStarred } : prev));
    } catch (err) {
      captureClientError(err, { scope: "email.detail.toggle-star", id, nextStarred });
      setError(nextStarred ? t("emailDetail.error.addStar") : t("emailDetail.error.removeStar"));
    } finally {
      setActionBusy(null);
    }
  };

  const goToNextOrList = (
    nextMessage: string,
    doneMessage = t("emailDetail.toast.queueComplete"),
    undoAction?: UndoableEmailAction,
  ) => {
    if (nextEmail) {
      toast(nextMessage, "success");
      const params = new URLSearchParams({ markRead: "false", queue });
      if (undoAction) appendUndoParams(params, undoAction, email);
      router.push(`/email/${nextEmail.id}?${params.toString()}`);
    } else {
      toast(doneMessage, "success");
      const params = new URLSearchParams({ done: queue });
      if (undoAction) appendUndoParams(params, undoAction, email);
      router.push(`/email?${params.toString()}`);
    }
  };

  const dismissUndoNotice = () => {
    if (!id) return;
    const params = new URLSearchParams(searchParams?.toString() || "");
    params.delete("undoAction");
    params.delete("undoGmailId");
    params.delete("undoSubject");
    const query = params.toString();
    router.replace(`/email/${id}${query ? `?${query}` : ""}`);
  };

  const undoLastAction = async () => {
    if (!undoNotice || actionBusy) return;
    setActionBusy("undo");
    setError(null);
    try {
      const data = await apiFetch<UndoActionResponse>(
        `/api/email/${encodeURIComponent(undoNotice.gmailId)}/${undoNotice.action}/undo`,
        {
          method: "POST",
          body: JSON.stringify({ gmailId: undoNotice.gmailId }),
        },
      );
      toast(t("emailDetail.toast.restored"), "success");
      const params = new URLSearchParams({ markRead: "false", queue });
      router.replace(`/email/${data.emailId}?${params.toString()}`);
    } catch (err) {
      captureClientError(err, { scope: "email.detail.undo", action: undoNotice.action });
      setError(serverErrorMessage(err, t("emailDetail.error.undo")));
      setActionBusy(null);
    }
  };

  const createEmailReminder = async (option: EmailReminderOption) => {
    if (!id || !email || reminderBusy) return;
    setReminderBusy(option.key);
    setError(null);
    try {
      const remindAt = getReminderDate(option.key);
      const subject = email.subject || t("common.noSubject");
      await apiFetch("/api/reminders", {
        method: "POST",
        body: JSON.stringify({
          title: email.needsReply
            ? t("emailDetail.reminderTitle.replyTo", { subject })
            : t("emailDetail.reminderTitle.review", { subject }),
          remindAt: remindAt.toISOString(),
          description: [`From: ${email.from}`, `Open: /email/${email.id}`].join("\n"),
        }),
      });
      toast(t("emailDetail.toast.reminderSet", { option: option.label.toLowerCase() }), "success");
    } catch (err) {
      captureClientError(err, { scope: "email.detail.reminder", id, option: option.key });
      setError(serverErrorMessage(err, t("emailDetail.error.reminder")));
    } finally {
      setReminderBusy(null);
    }
  };

  const archiveEmailNow = async () => {
    if (!id || actionBusy) return;
    setActionBusy("archive");
    setError(null);
    try {
      await apiFetch(`/api/email/${id}/archive`, { method: "POST" });
      goToNextOrList(
        t("emailDetail.toast.archivedMovingNext"),
        t("emailDetail.toast.archivedQueueComplete"),
        "archive",
      );
    } catch (err) {
      captureClientError(err, { scope: "email.detail.archive", id });
      setError(serverErrorMessage(err, t("emailDetail.error.archive")));
      setActionBusy(null);
    }
  };

  const deleteEmailNow = async () => {
    if (!id || actionBusy) return;
    const confirmed = await confirm({
      title: t("emailDetail.confirmDelete.title"),
      message: t("emailDetail.confirmDelete.message", {
        subject: email?.subject || t("common.untitled"),
      }),
      confirmLabel: t("emailDetail.confirmDelete.confirmLabel"),
      danger: true,
    });
    if (!confirmed) return;
    setActionBusy("delete");
    setError(null);
    try {
      await apiFetch(`/api/email/${id}`, { method: "DELETE" });
      goToNextOrList(
        t("emailDetail.toast.deletedMovingNext"),
        t("emailDetail.toast.deletedQueueComplete"),
        "delete",
      );
    } catch (err) {
      captureClientError(err, { scope: "email.detail.delete", id });
      setError(serverErrorMessage(err, t("emailDetail.error.delete")));
      setActionBusy(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-5 md:py-10">
      <Link
        href="/email"
        className="ease-strong mb-5 inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface-panel/70 px-3 text-xs font-medium text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] focus-ring"
      >
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        {t("emailDetail.backToList")}
      </Link>

      {undoNotice && (
        <UndoActionBanner
          notice={undoNotice}
          busy={actionBusy === "undo"}
          onDismiss={dismissUndoNotice}
          onUndo={undoLastAction}
        />
      )}

      {loading && <LoadingState rows={3} rowHeight="h-20" label={t("emailDetail.loadingLabel")} />}

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {email && (
        <article>
          {/* Flat content-first header: the subject is the h1 on the canvas,
              sender meta stays quiet, and the classification signals collapse
              into small badges instead of boxed stat tiles. */}
          <header className="mb-6">
            <div className="flex items-start gap-3.5">
              <span
                aria-hidden="true"
                className={`avatar-ring mt-1 hidden h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-sm font-semibold text-white sm:flex ${avatarGradient(senderName(email.from))}`}
              >
                {senderInitials(senderName(email.from))}
              </span>
              <div className="min-w-0 flex-1">
                <h1 className="break-words text-[24px] font-semibold leading-tight tracking-[-0.02em] text-ink md:text-[28px]">
                  {email.subject || t("common.noSubject")}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-mid">
                  <span className="max-w-full truncate font-medium text-ink-soft">
                    {senderName(email.from)}
                  </span>
                  {email.trust && <TrustBadgeChip trust={email.trust} />}
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <time className="shrink-0 tabular-nums">{formatFull(email.date)}</time>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <span>
                    {email.isRead
                      ? t("emailDetail.status.read")
                      : t("emailDetail.status.keptUnread")}
                  </span>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <span
                    className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ring-1 ring-inset ${
                      email.priority === "URGENT"
                        ? "bg-rose-500/10 text-rose-600 ring-rose-500/20"
                        : "bg-surface-hover text-ink-mid ring-transparent"
                    }`}
                  >
                    {priorityLabel(t, email.priority)}
                  </span>
                  {email.needsReply && (
                    <span className="shrink-0 rounded-md bg-accent/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-accent-deeper ring-1 ring-inset ring-accent/20">
                      {t("mail.filterReplyNeeded")}
                    </span>
                  )}
                  {email.category && (
                    <span className="shrink-0 rounded-md bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-ink-mid">
                      {categoryLabel(t, email.category)}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-4">
              <EmailActionToolbar
                busyAction={actionBusy}
                email={email}
                nextEmail={nextEmail}
                onArchive={archiveEmailNow}
                onDelete={deleteEmailNow}
                onOpenNext={() => goToNextOrList(t("emailDetail.toast.movingToNext"))}
                onToggleRead={toggleRead}
                onToggleStar={toggleStar}
              />
              <EmailReminderQuickActions
                busyKey={reminderBusy}
                disabled={email.id.startsWith("demo-")}
                onCreate={createEmailReminder}
              />
            </div>
          </header>

          {thread && thread.messages.length > 1 && (
            <ThreadContextPanel currentEmailId={email.id} thread={thread} />
          )}

          <ReplyDraftBox
            draft={draft}
            intent={draftIntent}
            drafting={drafting}
            sending={sendingDraft}
            savingGmailDraft={savingGmailDraft}
            gmailDraftUrl={gmailDraftUrl}
            attachments={email.attachments ?? []}
            candidateProfile={email.candidateProfile ?? null}
            selectedAttachmentIds={selectedDraftAttachmentIds}
            includeBriefAttachment={includeBriefAttachment}
            onSelectedAttachmentIdsChange={setSelectedDraftAttachmentIds}
            onIncludeBriefAttachmentChange={setIncludeBriefAttachment}
            onIntentChange={setDraftIntent}
            onGenerate={generateReplyDraft}
            onDraftChange={setDraft}
            onSaveGmailDraft={saveGmailDraft}
            onSend={sendReplyDraft}
          />

          {email.candidateProfile && (
            <CandidateProfileCard
              profile={email.candidateProfile}
              intake={email.candidateIntake ?? null}
              updating={updatingCandidate}
              onUpdate={updateCandidateIntake}
            />
          )}

          {email.attachments && email.attachments.length > 0 && (
            <AttachmentAnalysis
              emailId={email.id}
              attachments={email.attachments}
              onReanalyze={reanalyzeAttachments}
              onOcr={runAttachmentOcr}
              onSaveCorrection={saveAttachmentCorrection}
              reanalyzing={reanalyzing}
              ocring={ocring}
              savingCorrectionId={savingAttachmentCorrection}
            />
          )}

          {/* Reading first: the message body leads the grid in an elevated
              panel with a comfortable reading measure; Klorn's judgment sits
              beside it as supporting context. */}
          <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
            {email.body ? (
              <section className="panel-elevated overflow-hidden rounded-2xl border border-line/70 bg-surface-panel p-5 md:p-6">
                <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
                  {t("emailDetail.messageTitle")}
                </h2>
                <pre className="whitespace-pre-wrap break-words font-sans text-[15px] leading-7 text-ink-strong">
                  {linkifyText(email.body)}
                </pre>
              </section>
            ) : email.snippet ? (
              <section className="panel-elevated overflow-hidden rounded-2xl border border-line/70 bg-surface-panel p-5 md:p-6">
                <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
                  {t("emailDetail.previewTitle")}
                </h2>
                <p className="text-[15px] leading-7 text-ink-muted">{linkifyText(email.snippet)}</p>
              </section>
            ) : null}

            <KlornAnalysis
              email={email}
              onPriorityChange={(priority) =>
                setEmail((prev) => (prev ? { ...prev, priority } : prev))
              }
              onSummarize={summarize}
              summarizing={summarizing}
            />
            <ThreadBriefCard emailId={email.id} />
            <SenderContextCard emailId={email.id} />
          </div>
        </article>
      )}
    </div>
  );
}

function CandidateProfileCard({
  profile,
  intake,
  updating,
  onUpdate,
}: {
  profile: AttachmentCandidateProfile;
  intake: CandidateIntake | null;
  updating: boolean;
  onUpdate: (patch: { status?: CandidateIntakeStatus; notes?: string | null }) => void;
}) {
  const { t } = useT();
  const status = intake?.status ?? candidatePipelineToIntakeStatus(profile.pipelineStatus);
  const candidateStatusOptions = buildCandidateStatusOptions(t);
  return (
    <section className="panel-elevated relative mt-5 overflow-hidden rounded-2xl border border-line/70 bg-surface-panel p-4 md:p-5">
      <span
        aria-hidden="true"
        className="absolute left-0 top-0 h-full w-[3px] bg-gradient-to-b from-accent-muted to-accent"
      />
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-accent-deep">
          {t("emailDetail.candidateCard.title")}
        </h2>
        <span className="text-[11px] tabular-nums text-ink-dim">
          {t("candidates.confidence", { percent: String(Math.round(profile.confidence * 100)) })}
        </span>
      </div>
      <div className="mb-3 rounded-lg border border-line-soft bg-surface-raised/70 px-3 py-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-ink-dim">
          {t("emailDetail.candidateCard.pipeline")}
        </p>
        <p className="mt-1 text-xs font-semibold text-accent-deeper">
          {candidatePipelineLabel(t, profile.pipelineStatus)}
        </p>
        <p className="mt-1 text-[11px] leading-5 text-ink-mid">{profile.nextAction}</p>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {candidateStatusOptions.map((option) => (
          <button
            key={option.status}
            type="button"
            onClick={() => onUpdate({ status: option.status })}
            disabled={updating || status === option.status}
            className={`ease-strong rounded-lg border px-2 py-1 text-[11px] font-medium transition duration-150 active:scale-[0.97] disabled:cursor-default focus-ring ${
              status === option.status
                ? "border-accent-muted bg-accent/10 text-accent-deeper"
                : "border-line bg-surface-panel/70 text-ink-mid hover:bg-surface-panel hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="text-sm font-medium leading-relaxed text-ink">{profile.summary}</p>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
        <ProfileFact label={t("emailDetail.candidateCard.fact.name")} value={profile.name} />
        <ProfileFact label={t("emailDetail.candidateCard.fact.role")} value={profile.role} />
        <ProfileFact label={t("emailDetail.candidateCard.fact.contact")} value={profile.contact} />
        <ProfileFact label={t("emailDetail.candidateCard.fact.age")} value={profile.age} />
        <ProfileFact label={t("emailDetail.candidateCard.fact.height")} value={profile.height} />
        <ProfileFact
          label={t("emailDetail.candidateCard.fact.files")}
          value={`${profile.evidenceFiles.length}`}
        />
      </div>
      {profile.skills.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {profile.skills.map((skill) => (
            <span
              key={skill}
              className="rounded-full border border-line bg-surface-panel/70 px-2 py-1 text-[11px] text-ink-muted"
            >
              {skill}
            </span>
          ))}
        </div>
      )}
      {profile.links.length > 0 && (
        <div className="mt-3 space-y-1">
          {profile.links.map((link) => (
            <p key={link} className="break-all text-[11px] text-accent-deep">
              {link}
            </p>
          ))}
        </div>
      )}
      {profile.missingFields.length > 0 && (
        <p className="mt-3 text-[11px] text-accent-deeper">
          {t("emailDetail.candidateCard.needsFollowUp", {
            fields: profile.missingFields
              .map((field) => candidateMissingLabel(t, field))
              .join(", "),
          })}
        </p>
      )}
      {profile.manualReviewFiles.length > 0 && (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
          <p className="text-[11px] font-semibold text-rose-700">
            {t("emailDetail.candidateCard.sourceReviewNeeded")}
          </p>
          <ul className="mt-1 space-y-1">
            {profile.manualReviewFiles.map((file) => (
              <li key={`${file.filename}-${file.reason}`} className="text-[11px] text-rose-600/90">
                {file.filename}: {file.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <label className="mt-3 block">
        <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-ink-mid">
          {t("emailDetail.candidateCard.reviewNoteLabel")}
        </span>
        <textarea
          defaultValue={intake?.notes ?? ""}
          rows={2}
          onBlur={(e) => onUpdate({ notes: e.target.value || null })}
          className="w-full rounded-lg border border-line bg-surface-panel/80 px-3 py-2 text-xs leading-5 text-ink-soft outline-none transition duration-150 ease-out focus:border-accent/50 focus:bg-surface-panel focus:ring-2 focus:ring-accent/15"
          placeholder={t("emailDetail.candidateCard.reviewNoteLabel")}
        />
      </label>
    </section>
  );
}

/** `t` is passed in rather than called via useT() here — this is a plain
 * builder, not a component, so it cannot use hooks itself. */
function buildCandidateStatusOptions(
  t: (key: string) => string,
): Array<{ status: CandidateIntakeStatus; label: string }> {
  return [
    { status: "NEEDS_ANALYSIS", label: t("candidates.status.needsAnalysis") },
    { status: "NEEDS_INFO", label: t("candidates.status.needsInfo") },
    { status: "READY_TO_REVIEW", label: t("candidates.status.readyToReview") },
    { status: "REVIEWING", label: t("candidates.status.reviewing") },
    { status: "CONTACTED", label: t("candidates.status.contacted") },
    { status: "SHORTLISTED", label: t("candidates.status.shortlisted") },
    { status: "REJECTED", label: t("candidates.status.rejected") },
    { status: "ARCHIVED", label: t("candidates.status.archived") },
  ];
}

function candidatePipelineToIntakeStatus(
  status: AttachmentCandidateProfile["pipelineStatus"],
): CandidateIntakeStatus {
  if (status === "needs_analysis") return "NEEDS_ANALYSIS";
  if (status === "needs_info") return "NEEDS_INFO";
  return "READY_TO_REVIEW";
}

function ThreadContextPanel({
  thread,
  currentEmailId,
}: {
  thread: ThreadDetail;
  currentEmailId: string;
}) {
  const { t } = useT();
  return (
    <section className="panel-elevated mb-5 overflow-hidden rounded-2xl border border-line/70 bg-surface-panel">
      <div className="border-b border-line-soft px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{t("emailDetail.thread.title")}</h2>
        <p className="mt-0.5 text-xs text-ink-dim">
          {t("emailDetail.thread.subtitle", { count: String(thread.messageCount) })}
        </p>
      </div>
      <ol className="divide-y divide-line-soft">
        {thread.messages.map((message) => {
          const current = message.id === currentEmailId;
          return (
            <li
              key={message.id}
              className={`row-wash relative px-4 py-2.5 ${current ? "bg-accent/5" : ""}`}
            >
              {current && (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-0 h-full w-[3px] bg-accent-light"
                />
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 truncate text-xs font-medium text-ink">
                  {senderName(message.from)}
                </p>
                <time className="shrink-0 text-[10px] tabular-nums text-ink-dim">
                  {formatFull(message.date)}
                </time>
              </div>
              <p className="mt-1 truncate text-[11px] text-ink-mid">
                {message.summary ||
                  message.snippet ||
                  message.subject ||
                  t("emailDetail.thread.noSummary")}
              </p>
              {message.actionItems.length > 0 && (
                <p className="mt-1 text-[10px] font-medium text-accent-deep">
                  {t("emailDetail.thread.taskCount", { count: String(message.actionItems.length) })}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

type EmailWorkMode =
  | "founder"
  | "sales"
  | "recruiting"
  | "legal"
  | "finance"
  | "pm"
  | "support"
  | "ops"
  | "real_estate"
  | "freelance";

/** `t` is passed in rather than called via useT() here — these are plain
 * builders, not components, so they cannot use hooks themselves. */
function buildWorkModeOptions(t: (key: string) => string): Array<{
  value: EmailWorkMode;
  label: string;
}> {
  return [
    { value: "founder", label: t("emailDetail.workMode.founder") },
    { value: "sales", label: t("emailDetail.workMode.sales") },
    { value: "recruiting", label: t("emailDetail.workMode.recruiting") },
    { value: "legal", label: t("emailDetail.workMode.legal") },
    { value: "finance", label: t("emailDetail.workMode.finance") },
    { value: "pm", label: t("emailDetail.workMode.pm") },
    { value: "support", label: t("emailDetail.workMode.support") },
    { value: "ops", label: t("emailDetail.workMode.ops") },
    { value: "real_estate", label: t("emailDetail.workMode.realEstate") },
    { value: "freelance", label: t("emailDetail.workMode.freelance") },
  ];
}

function buildModeIntents(
  t: (key: string) => string,
): Record<EmailWorkMode, Array<{ label: string; intent: string }>> {
  return {
    founder: [
      {
        label: t("emailDetail.quickIntent.founder.investorFollowUp.label"),
        intent: t("emailDetail.quickIntent.founder.investorFollowUp.intent"),
      },
      {
        label: t("emailDetail.quickIntent.founder.vipQuickReply.label"),
        intent: t("emailDetail.quickIntent.founder.vipQuickReply.intent"),
      },
    ],
    sales: [
      {
        label: t("emailDetail.quickIntent.sales.bookMeeting.label"),
        intent: t("emailDetail.quickIntent.sales.bookMeeting.intent"),
      },
      {
        label: t("emailDetail.quickIntent.sales.renewalPricing.label"),
        intent: t("emailDetail.quickIntent.sales.renewalPricing.intent"),
      },
    ],
    recruiting: [],
    legal: [
      {
        label: t("emailDetail.quickIntent.legal.reviewIntake.label"),
        intent: t("emailDetail.quickIntent.legal.reviewIntake.intent"),
      },
      {
        label: t("emailDetail.quickIntent.legal.requestContractInfo.label"),
        intent: t("emailDetail.quickIntent.legal.requestContractInfo.intent"),
      },
    ],
    finance: [
      {
        label: t("emailDetail.quickIntent.finance.confirmInvoice.label"),
        intent: t("emailDetail.quickIntent.finance.confirmInvoice.intent"),
      },
      {
        label: t("emailDetail.quickIntent.finance.paymentIssue.label"),
        intent: t("emailDetail.quickIntent.finance.paymentIssue.intent"),
      },
    ],
    pm: [
      {
        label: t("emailDetail.quickIntent.pm.issueIntake.label"),
        intent: t("emailDetail.quickIntent.pm.issueIntake.intent"),
      },
      {
        label: t("emailDetail.quickIntent.pm.decisionRequest.label"),
        intent: t("emailDetail.quickIntent.pm.decisionRequest.intent"),
      },
    ],
    support: [
      {
        label: t("emailDetail.quickIntent.support.supportIntake.label"),
        intent: t("emailDetail.quickIntent.support.supportIntake.intent"),
      },
      {
        label: t("emailDetail.quickIntent.support.escalate.label"),
        intent: t("emailDetail.quickIntent.support.escalate.intent"),
      },
    ],
    ops: [
      {
        label: t("emailDetail.quickIntent.ops.confirmLogistics.label"),
        intent: t("emailDetail.quickIntent.ops.confirmLogistics.intent"),
      },
      {
        label: t("emailDetail.quickIntent.ops.vendorFollowUp.label"),
        intent: t("emailDetail.quickIntent.ops.vendorFollowUp.intent"),
      },
    ],
    real_estate: [
      {
        label: t("emailDetail.quickIntent.realEstate.tourSchedule.label"),
        intent: t("emailDetail.quickIntent.realEstate.tourSchedule.intent"),
      },
      {
        label: t("emailDetail.quickIntent.realEstate.contractStage.label"),
        intent: t("emailDetail.quickIntent.realEstate.contractStage.intent"),
      },
    ],
    freelance: [
      {
        label: t("emailDetail.quickIntent.freelance.confirmScope.label"),
        intent: t("emailDetail.quickIntent.freelance.confirmScope.intent"),
      },
      {
        label: t("emailDetail.quickIntent.freelance.collectFeedback.label"),
        intent: t("emailDetail.quickIntent.freelance.collectFeedback.intent"),
      },
    ],
  };
}

function buildQuickReplyIntents(
  t: (key: string, vars?: Record<string, string>) => string,
  profile: AttachmentCandidateProfile | null,
  mode: EmailWorkMode,
): Array<{ label: string; intent: string }> {
  const intents: Array<{ label: string; intent: string }> = [...buildModeIntents(t)[mode]];
  if (!profile) return intents.slice(0, 4);
  const missing = profile.missingFields.map((field) => candidateMissingLabel(t, field));
  const manualFiles = profile.manualReviewFiles.map((file) => file.filename);

  if (missing.length > 0 || manualFiles.length > 0) {
    intents.push({
      label: t("emailDetail.quickIntent.requestMissingMaterials.label"),
      intent: [
        t("emailDetail.quickIntent.requestMissingMaterials.intentIntro"),
        manualFiles.length > 0
          ? t("emailDetail.quickIntent.requestMissingMaterials.intentFiles", {
              files: manualFiles.join(", "),
            })
          : "",
        missing.length > 0
          ? t("emailDetail.quickIntent.requestMissingMaterials.intentMissing", {
              fields: missing.join(", "),
            })
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
  }

  if (profile.pipelineStatus === "ready_to_review") {
    intents.push({
      label: t("emailDetail.quickIntent.confirmIntake.label"),
      intent: t("emailDetail.quickIntent.confirmIntake.intent"),
    });
  }

  intents.push({
    label: t("emailDetail.quickIntent.askAuditionTimes.label"),
    intent: t("emailDetail.quickIntent.askAuditionTimes.intent"),
  });

  return intents.slice(0, 4);
}

function ReplyDraftBox({
  draft,
  intent,
  drafting,
  sending,
  savingGmailDraft,
  gmailDraftUrl,
  attachments,
  candidateProfile,
  selectedAttachmentIds,
  includeBriefAttachment,
  onSelectedAttachmentIdsChange,
  onIncludeBriefAttachmentChange,
  onIntentChange,
  onGenerate,
  onDraftChange,
  onSaveGmailDraft,
  onSend,
}: {
  draft: ReplyDraft | null;
  intent: string;
  drafting: boolean;
  sending: boolean;
  savingGmailDraft: boolean;
  gmailDraftUrl: string | null;
  attachments: EmailAttachment[];
  candidateProfile: AttachmentCandidateProfile | null;
  selectedAttachmentIds: string[];
  includeBriefAttachment: boolean;
  onSelectedAttachmentIdsChange: (ids: string[]) => void;
  onIncludeBriefAttachmentChange: (value: boolean) => void;
  onIntentChange: (value: string) => void;
  onGenerate: () => void;
  onDraftChange: (draft: ReplyDraft) => void;
  onSaveGmailDraft: () => void;
  onSend: () => void;
}) {
  const { t } = useT();
  const [mode, setMode] = useState<EmailWorkMode>("founder");
  const toggleAttachment = (attachmentId: string) => {
    onSelectedAttachmentIdsChange(
      selectedAttachmentIds.includes(attachmentId)
        ? selectedAttachmentIds.filter((id) => id !== attachmentId)
        : [...selectedAttachmentIds, attachmentId],
    );
  };
  const selectedCount = selectedAttachmentIds.length;
  const draftAttachmentCount = selectedCount + (includeBriefAttachment ? 1 : 0);
  const workModeOptions = buildWorkModeOptions(t);
  const quickIntents = buildQuickReplyIntents(t, candidateProfile, mode);

  return (
    <section className="panel-elevated mt-5 overflow-hidden rounded-2xl border border-line/70 bg-surface-panel p-4 md:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-mid">
            {t("emailDetail.replyDraft.title")}
          </h2>
          <p className="mt-1 text-xs text-ink-dim">{t("emailDetail.replyDraft.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={onGenerate}
          disabled={drafting}
          className="ease-strong inline-flex h-9 shrink-0 items-center rounded-lg border border-sky-200 bg-sky-50/70 px-3 text-xs font-medium text-accent-deeper transition duration-150 hover:bg-sky-50 hover:text-sky-800 active:scale-[0.97] disabled:opacity-50 focus-ring"
        >
          {drafting
            ? t("emailDetail.replyDraft.drafting")
            : draft
              ? t("emailDetail.replyDraft.regenerate")
              : t("emailDetail.replyDraft.draftButton")}
        </button>
      </div>
      <input
        value={intent}
        onChange={(e) => onIntentChange(e.target.value)}
        placeholder={t("emailDetail.replyDraft.intentPlaceholder")}
        className="mb-3 w-full rounded-lg border border-line bg-surface-panel/80 px-3 py-2 text-xs text-ink-soft placeholder-ink-dim outline-none transition duration-150 ease-out focus:border-accent/50 focus:bg-surface-panel focus:ring-2 focus:ring-accent/15"
      />
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
        {workModeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setMode(option.value)}
            className={`ease-strong inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium transition duration-150 active:scale-[0.97] focus-ring ${
              mode === option.value
                ? "bg-accent/10 text-accent-deeper ring-1 ring-inset ring-accent/30"
                : "text-ink-mid hover:bg-surface-raised hover:text-ink"
            }`}
          >
            {mode === option.value && (
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
            )}
            {option.label}
          </button>
        ))}
      </div>
      {quickIntents.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {quickIntents.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => onIntentChange(item.intent)}
              className="ease-strong rounded-full border border-line bg-surface-panel/70 px-3 py-1.5 text-[11px] text-ink-mid transition duration-150 hover:bg-sky-50 hover:text-accent-deeper active:scale-[0.97] focus-ring"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      {draft && (
        <div className="space-y-2">
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-ink-mid">
                {t("emailDetail.replyDraft.toLabel")}
              </span>
              <input
                value={draft.to}
                onChange={(e) => onDraftChange({ ...draft, to: e.target.value })}
                className="w-full rounded-lg border border-line bg-surface-panel/80 px-2 py-1.5 text-ink-soft outline-none transition duration-150 ease-out focus:border-accent/50 focus:bg-surface-panel focus:ring-2 focus:ring-accent/15"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-ink-mid">
                {t("emailDetail.replyDraft.subjectLabel")}
              </span>
              <input
                value={draft.subject}
                onChange={(e) => onDraftChange({ ...draft, subject: e.target.value })}
                className="w-full rounded-lg border border-line bg-surface-panel/80 px-2 py-1.5 text-ink-soft outline-none transition duration-150 ease-out focus:border-accent/50 focus:bg-surface-panel focus:ring-2 focus:ring-accent/15"
              />
            </label>
          </div>
          <textarea
            value={draft.body}
            onChange={(e) => onDraftChange({ ...draft, body: e.target.value })}
            rows={7}
            className="w-full rounded-lg border border-line bg-surface-panel/80 px-3 py-2 text-sm leading-6 text-ink outline-none transition duration-150 ease-out focus:border-accent/50 focus:bg-surface-panel focus:ring-2 focus:ring-accent/15"
          />
          {attachments.length > 0 && (
            <div className="space-y-2 rounded-lg border border-line-soft bg-surface-raised/70 px-3 py-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-sky-200/70 bg-sky-50/60 px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={includeBriefAttachment}
                  onChange={(e) => onIncludeBriefAttachmentChange(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-line-strong bg-surface-panel text-accent focus:ring-accent focus:ring-offset-white"
                />
                <span>
                  <span className="block text-[11px] font-medium text-accent-deeper">
                    {t("emailDetail.replyDraft.attachBriefLabel")}
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-4 text-ink-dim">
                    {t("emailDetail.replyDraft.attachBriefDescription")}
                  </span>
                </span>
              </label>
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-[10px] font-medium uppercase tracking-wider text-ink-mid">
                  {t("emailDetail.replyDraft.saveOriginalAttachments")}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onSelectedAttachmentIdsChange(
                      selectedCount === attachments.length
                        ? []
                        : attachments.map((attachment) => attachment.id),
                    )
                  }
                  className="text-[11px] font-medium text-ink-dim transition duration-150 hover:text-accent-deeper focus-ring"
                >
                  {selectedCount === attachments.length
                    ? t("emailDetail.replyDraft.clearAll")
                    : t("emailDetail.replyDraft.selectAll")}
                </button>
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {attachments.map((attachment) => (
                  <label
                    key={attachment.id}
                    className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface-panel px-2 py-1.5 transition duration-150 ease-out hover:border-sky-200"
                  >
                    <input
                      type="checkbox"
                      checked={selectedAttachmentIds.includes(attachment.id)}
                      onChange={() => toggleAttachment(attachment.id)}
                      className="h-3.5 w-3.5 rounded border-line-strong bg-surface-panel text-accent focus:ring-accent focus:ring-offset-white"
                    />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
                      {attachment.filename}
                    </span>
                    <span className="shrink-0 text-[10px] text-ink-dim">
                      {formatBytes(attachment.size)}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex justify-end">
            <div className="flex flex-wrap justify-end gap-2">
              {gmailDraftUrl && (
                <a
                  href={gmailDraftUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ease-strong inline-flex h-9 items-center rounded-lg border border-sky-200 bg-sky-50/70 px-3 text-xs font-medium text-accent-deeper transition duration-150 hover:bg-sky-50 hover:text-sky-800 active:scale-[0.97] focus-ring"
                >
                  {t("emailDetail.replyDraft.openGmailDraft")}
                </a>
              )}
              <button
                type="button"
                onClick={onSaveGmailDraft}
                disabled={savingGmailDraft || !draft.to || !draft.subject || !draft.body}
                className="ease-strong inline-flex h-9 items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-xs font-medium text-ink-mid transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-50 focus-ring"
              >
                {savingGmailDraft
                  ? t("emailDetail.replyDraft.saving")
                  : draftAttachmentCount > 0
                    ? t("emailDetail.replyDraft.saveGmailDraftWithAttachments", {
                        count: String(draftAttachmentCount),
                      })
                    : t("emailDetail.replyDraft.saveGmailDraft")}
              </button>
              <button
                type="button"
                onClick={onSend}
                disabled={sending || !draft.to || !draft.subject || !draft.body}
                className="glow-primary ease-strong inline-flex h-9 items-center rounded-lg bg-gradient-to-b from-accent-light to-accent px-3.5 text-xs font-medium text-white transition duration-150 hover:from-accent-light hover:to-sky-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
              >
                {sending
                  ? t("emailDetail.replyDraft.sending")
                  : t("emailDetail.replyDraft.sendButton")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function SummarizeButton({
  onSummarize,
  summarizing,
}: {
  onSummarize?: () => void;
  summarizing?: boolean;
}) {
  const { t } = useT();
  if (!onSummarize) return null;
  return (
    <button
      type="button"
      onClick={onSummarize}
      disabled={summarizing}
      className="ml-auto text-xs font-medium text-accent-deep transition hover:text-accent disabled:opacity-50"
    >
      {summarizing ? t("emailDetail.analysis.summarizing") : t("emailDetail.analysis.summarize")}
    </button>
  );
}

/** Why this message arrived NOW — read from the whole thread, both
 *  directions. Distinct from the dossier: the dossier is who they are, this
 *  is what just happened. Fetching it here also warms the cache the reply
 *  drafter reads. */
function ThreadBriefCard({ emailId }: { emailId: string }) {
  const { t, locale } = useT();
  const [brief, setBrief] = useState<{
    whyNow: string;
    asks: string[];
    weOwe: string | null;
    stance: string | null;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    setBrief(null);
    apiFetch<{
      brief: { whyNow: string; asks: string[]; weOwe: string | null; stance: string | null } | null;
    }>(`/api/email/${emailId}/thread-brief?lang=${locale}`)
      .then((d) => {
        if (alive && d.brief?.whyNow) setBrief(d.brief);
      })
      .catch(() => {
        // Best-effort: a single-message thread or an unreachable Gmail shows
        // nothing rather than an error the user can do nothing about.
      });
    return () => {
      alive = false;
    };
  }, [emailId, locale]);

  if (!brief) return null;
  return (
    <section className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-4">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
        {t("emailDetail.threadBrief.title")}
      </p>
      <p className="text-sm leading-relaxed text-ink">{brief.whyNow}</p>
      {brief.weOwe && (
        <p className="mt-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          {t("emailDetail.threadBrief.weOwe")}: {brief.weOwe}
        </p>
      )}
      {brief.asks.length > 0 && (
        <ul className="mt-2 space-y-1">
          {brief.asks.map((ask) => (
            <li key={ask} className="text-xs text-ink-mid">
              · {ask}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Relationship context for the sender (dossier) — why this person writes. */
function SenderContextCard({ emailId }: { emailId: string }) {
  const { t, locale } = useT();
  const [dossier, setDossier] = useState<{
    summary: string;
    openThreads: string[];
    lastPromise: string | null;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    setDossier(null);
    apiFetch<{ summary: string; openThreads: string[]; lastPromise: string | null }>(
      `/api/email/${emailId}/sender-dossier?lang=${locale}`,
    )
      .then((d) => {
        if (alive && d.summary) setDossier(d);
      })
      .catch(() => {
        // Best-effort context — no history / no provider just shows nothing.
      });
    return () => {
      alive = false;
    };
  }, [emailId, locale]);

  if (!dossier) return null;
  return (
    <section className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-4">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
        {t("emailDetail.senderContext.title")}
      </p>
      <p className="text-sm leading-relaxed text-ink">{dossier.summary}</p>
      {dossier.openThreads.length > 0 && (
        <p className="mt-1.5 text-xs text-ink-mid">
          {t("emailDetail.senderContext.inFlight")}: {dossier.openThreads.join(" · ")}
        </p>
      )}
      {dossier.lastPromise && (
        <p className="mt-1 text-xs text-ink-mid">
          {t("emailDetail.senderContext.promise")}: {dossier.lastPromise}
        </p>
      )}
    </section>
  );
}

function KlornAnalysis({
  email,
  onPriorityChange,
  onSummarize,
  summarizing,
}: {
  email: EmailDetail;
  onPriorityChange: (priority: EmailPriority) => void;
  onSummarize?: () => void;
  summarizing?: boolean;
}) {
  const { t } = useT();
  const hasAnything =
    email.summary || email.keyPoints.length > 0 || email.actionItems.length > 0 || email.category;

  if (!hasAnything) {
    return (
      <section className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-4">
        <div className="flex items-center">
          <p className="text-xs text-ink-dim">{t("emailDetail.analysis.notAnalyzed")}</p>
          <SummarizeButton onSummarize={onSummarize} summarizing={summarizing} />
        </div>
      </section>
    );
  }

  return (
    <section className="panel-elevated relative overflow-hidden rounded-2xl border border-line/70 bg-surface-panel p-4 md:p-5">
      <div className="absolute bottom-0 left-0 top-0 w-[3px] bg-gradient-to-b from-accent-muted to-accent" />
      <div className="pl-2">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-accent-deep">
            {t("emailDetail.analysis.title")}
          </span>
          <div className="flex items-center gap-1.5">
            <PriorityPill priority={email.priority} />
            {email.needsReply && <ReplyNeededPill />}
            {email.category && <CategoryPill category={email.category} />}
          </div>
          <LabelFeedbackControl
            emailId={email.id}
            currentPriority={email.priority}
            onPriorityChange={onPriorityChange}
          />
          <SummarizeButton onSummarize={onSummarize} summarizing={summarizing} />
        </div>

        {email.summary && <p className="text-sm leading-relaxed text-ink">{email.summary}</p>}

        {email.keyPoints.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-ink-dim">
              {t("emailDetail.analysis.keyPoints")}
            </p>
            <ul className="space-y-1">
              {email.keyPoints.map((k, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-ink-mid">
                  <span className="text-accent/75">•</span>
                  <span>{k}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {email.actionItems.length > 0 && (
          <ActionItemsPanel emailId={email.id} actionItems={email.actionItems} />
        )}

        {email.needsReply && <ReplyNeededFeedbackControl emailId={email.id} />}
      </div>
    </section>
  );
}

function ActionItemsPanel({ emailId, actionItems }: { emailId: string; actionItems: string[] }) {
  const { toast } = useToast();
  const { t } = useT();
  const [creating, setCreating] = useState<"all" | number | null>(null);
  const [created, setCreated] = useState<Set<number>>(new Set());

  async function createTask(index: number) {
    if (created.has(index) || creating !== null) return;
    setCreating(index);
    try {
      await apiFetch(`/api/email/${emailId}/create-tasks`, {
        method: "POST",
        body: JSON.stringify({ indices: [index] }),
      });
      setCreated((prev) => new Set([...prev, index]));
      toast(t("emailDetail.actionItems.taskCreated"), "success");
    } catch {
      toast(t("emailDetail.actionItems.taskCreateFailed"), "error");
    } finally {
      setCreating(null);
    }
  }

  async function createAll() {
    if (creating !== null) return;
    setCreating("all");
    try {
      const uncreatedIndices = actionItems.map((_, i) => i).filter((i) => !created.has(i));
      await apiFetch(`/api/email/${emailId}/create-tasks`, {
        method: "POST",
        body: JSON.stringify({ indices: uncreatedIndices }),
      });
      setCreated(new Set(actionItems.map((_, i) => i)));
      toast(
        t(
          uncreatedIndices.length > 1
            ? "emailDetail.actionItems.taskCreatedMany"
            : "emailDetail.actionItems.taskCreatedOne",
          { count: String(uncreatedIndices.length) },
        ),
        "success",
      );
    } catch {
      toast(t("emailDetail.actionItems.tasksCreateFailed"), "error");
    } finally {
      setCreating(null);
    }
  }

  const allCreated = created.size >= actionItems.length;

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[10px] font-medium uppercase tracking-wider text-ink-dim">
          {t("emailDetail.actionItems.title")}
        </p>
        {!allCreated && (
          <button
            type="button"
            onClick={createAll}
            disabled={creating !== null}
            className="ease-strong rounded-md border border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-medium text-teal-700 transition duration-150 hover:bg-teal-100 active:scale-[0.97] disabled:opacity-40 focus-ring"
          >
            {creating === "all"
              ? t("emailDetail.actionItems.creating")
              : t("emailDetail.actionItems.createAll")}
          </button>
        )}
      </div>
      <ul className="space-y-1">
        {actionItems.map((a, i) => (
          <li key={i} className="flex items-center gap-2 text-xs">
            <span className={created.has(i) ? "text-teal-600" : "text-accent-deep"}>
              {created.has(i) ? "✓" : "□"}
            </span>
            <span
              className={`flex-1 ${created.has(i) ? "text-ink-dim line-through" : "text-ink-muted"}`}
            >
              {a}
            </span>
            {!created.has(i) && (
              <button
                type="button"
                onClick={() => createTask(i)}
                disabled={creating !== null}
                className="ease-strong shrink-0 rounded-md border border-line bg-surface-panel/70 px-1.5 py-0.5 text-[10px] font-medium text-ink-dim transition duration-150 hover:bg-sky-50 hover:text-accent-deeper active:scale-[0.97] disabled:opacity-40 focus-ring"
              >
                {creating === i ? "…" : t("emailDetail.actionItems.addTask")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReplyNeededPill() {
  const { t } = useT();
  return (
    <span className="shrink-0 rounded-md bg-accent/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-accent-deeper ring-1 ring-inset ring-accent/20">
      {t("mail.filterReplyNeeded")}
    </span>
  );
}

/** `t` is passed in rather than called via useT() here — this is a plain
 * helper, not a component, so it cannot use hooks itself. */
function priorityLabel(t: (key: string) => string, priority: EmailPriority): string {
  const labels: Record<EmailPriority, string> = {
    URGENT: t("emailDetail.priority.urgent"),
    NORMAL: t("emailDetail.priority.normal"),
    LOW: t("emailDetail.priority.low"),
  };
  return labels[priority];
}

function LabelFeedbackControl({
  emailId,
  currentPriority,
  onPriorityChange,
}: {
  emailId: string;
  currentPriority: EmailPriority;
  onPriorityChange: (priority: EmailPriority) => void;
}) {
  const { t } = useT();
  const [feedback, setFeedback] = useState<LabelFeedback | null>(null);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState<EmailPriority | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ feedback: LabelFeedback | null }>(`/api/email/${emailId}/feedback`)
      .then((data) => {
        if (!cancelled) setFeedback(data.feedback);
      })
      .catch((err) => captureClientError(err, { scope: "email.feedback.load", emailId }));
    return () => {
      cancelled = true;
    };
  }, [emailId]);

  const submit = async (correctedPriority: EmailPriority) => {
    if (submitting) return;
    setSubmitting(correctedPriority);
    setError(null);
    try {
      const data = await apiFetch<{ feedback: LabelFeedback }>(`/api/email/${emailId}/feedback`, {
        method: "POST",
        body: JSON.stringify({ correctedPriority }),
      });
      setFeedback(data.feedback);
      onPriorityChange(correctedPriority);
      setOpen(false);
    } catch (err) {
      captureClientError(err, { scope: "email.feedback.submit", emailId, correctedPriority });
      setError(serverErrorMessage(err, t("emailDetail.error.reportLabel")));
    } finally {
      setSubmitting(null);
    }
  };

  if (feedback) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-accent-deeper">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        {t("emailDetail.feedback.reported", {
          original: priorityLabel(t, feedback.originalPriority),
          corrected: priorityLabel(t, feedback.correctedPriority),
        })}
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] text-ink-dim underline-offset-2 hover:text-ink-mid hover:underline focus-ring"
      >
        {t("emailDetail.feedback.wrongLabel")}
      </button>
    );
  }

  const options: EmailPriority[] = (["URGENT", "NORMAL", "LOW"] as const).filter(
    (p) => p !== currentPriority,
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-ink-dim">{t("emailDetail.feedback.actualPriority")}</span>
      {options.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => submit(p)}
          disabled={!!submitting}
          className="ease-strong rounded-md border border-line bg-surface-panel/70 px-1.5 py-0.5 text-[11px] font-medium text-ink-soft transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-50 focus-ring"
        >
          {submitting === p ? "..." : priorityLabel(t, p)}
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setError(null);
        }}
        disabled={!!submitting}
        className="text-[11px] text-ink-dim hover:text-ink-mid focus-ring"
      >
        {t("common.cancel")}
      </button>
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </div>
  );
}

function ReplyNeededFeedbackControl({ emailId }: { emailId: string }) {
  const { t } = useT();
  const [feedback, setFeedback] = useState<ReplyNeededFeedback | null>(null);
  const [submitting, setSubmitting] = useState<ReplyNeededChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ feedback: ReplyNeededFeedback | null }>(
      `/api/email/${emailId}/reply-needed/feedback`,
    )
      .then((data) => {
        if (!cancelled) setFeedback(data.feedback);
      })
      .catch((err) =>
        captureClientError(err, { scope: "email.reply-needed-feedback.load", emailId }),
      );
    return () => {
      cancelled = true;
    };
  }, [emailId]);

  const submit = async (choice: ReplyNeededChoice) => {
    if (submitting) return;
    setSubmitting(choice);
    setError(null);
    try {
      const data = await apiFetch<{
        feedback: { emailId: string; choice: ReplyNeededChoice; signal: string };
      }>(`/api/email/${emailId}/reply-needed/feedback`, {
        method: "POST",
        body: JSON.stringify({ choice }),
      });
      setFeedback({
        id: `${emailId}-${data.feedback.choice}`,
        choice: data.feedback.choice,
        signal: data.feedback.signal,
        evidence: null,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      captureClientError(err, { scope: "email.reply-needed-feedback.submit", emailId, choice });
      setError(serverErrorMessage(err, t("emailDetail.error.saveFeedback")));
    } finally {
      setSubmitting(null);
    }
  };

  const options: Array<{ choice: ReplyNeededChoice; label: string }> = [
    { choice: "today", label: t("emailDetail.replyNeeded.today") },
    { choice: "waiting_on_me", label: t("emailDetail.replyNeeded.onMe") },
    { choice: "waiting_on_them", label: t("emailDetail.replyNeeded.waitingOnThem") },
    { choice: "needed", label: t("emailDetail.replyNeeded.needed") },
    { choice: "not_needed", label: t("emailDetail.replyNeeded.notNeeded") },
    { choice: "later", label: t("emailDetail.replyNeeded.later") },
    { choice: "done", label: t("emailDetail.replyNeeded.done") },
  ];

  return (
    <div className="mt-4 border-t border-line-soft pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-ink-dim">
          {t("emailDetail.replyNeeded.judgmentLabel")}
        </span>
        {options.map((option) => {
          const selected = feedback?.choice === option.choice;
          return (
            <button
              key={option.choice}
              type="button"
              onClick={() => submit(option.choice)}
              aria-pressed={selected}
              disabled={!!submitting}
              className={`h-7 rounded-lg border px-2 text-[11px] transition disabled:opacity-50 focus-ring ${
                selected
                  ? "border-accent-muted bg-accent/10 text-accent-deeper"
                  : "border-line bg-surface-panel/70 text-ink-mid hover:bg-surface-panel hover:text-ink"
              }`}
            >
              {submitting === option.choice ? "..." : option.label}
            </button>
          );
        })}
        {error && <span className="text-[11px] text-red-600">{error}</span>}
      </div>
    </div>
  );
}

function PriorityPill({ priority }: { priority: EmailDetail["priority"] }) {
  const { t } = useT();
  if (priority === "NORMAL") return null;
  const styles = {
    URGENT: "bg-rose-500/10 text-rose-600 ring-rose-500/20",
    LOW: "bg-surface-hover text-ink-mid ring-transparent",
  };
  return (
    <span
      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ring-1 ring-inset ${styles[priority as "URGENT" | "LOW"]}`}
    >
      {priorityLabel(t, priority as "URGENT" | "LOW")}
    </span>
  );
}

function CategoryPill({ category }: { category: string }) {
  const { t } = useT();
  const label = categoryLabel(t, category);
  return (
    <span className="shrink-0 rounded-md bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-ink-mid">
      {label}
    </span>
  );
}

/** `t` is passed in rather than called via useT() here — these are plain
 * helpers, not components, so they cannot use hooks themselves. */
function categoryLabel(t: (key: string) => string, category: string): string {
  const labelMap: Record<string, string> = {
    business: t("emailDetail.category.business"),
    engineering: t("emailDetail.category.engineering"),
    automated: t("emailDetail.category.automated"),
    newsletter: t("emailDetail.category.newsletter"),
    meeting: t("emailDetail.category.meeting"),
    billing: t("emailDetail.category.billing"),
    conversation: t("emailDetail.category.conversation"),
    other: t("emailDetail.category.other"),
  };
  return labelMap[category] || category;
}

function candidateMissingLabel(t: (key: string) => string, key: string): string {
  const labelMap: Record<string, string> = {
    name: t("emailDetail.candidateCard.fact.name"),
    contact: t("emailDetail.candidateCard.fact.contact"),
    role: t("emailDetail.candidateCard.fact.role"),
    portfolio: t("emailDetail.candidateCard.missingField.portfolioLink"),
  };
  return labelMap[key] || key;
}

function candidatePipelineLabel(
  t: (key: string) => string,
  status: AttachmentCandidateProfile["pipelineStatus"],
): string {
  const labels: Record<AttachmentCandidateProfile["pipelineStatus"], string> = {
    ready_to_review: t("candidates.status.readyToReview"),
    needs_info: t("candidates.status.needsInfo"),
    needs_analysis: t("candidates.status.needsAnalysis"),
  };
  return labels[status];
}

// Monogram avatar helpers — local copy of the email list pattern so the
// detail header shows the same deterministic per-sender gradient.
const AVATAR_GRADIENTS = [
  "from-accent-light to-blue-500",
  "from-teal-400 to-emerald-500",
  "from-indigo-500 to-violet-600",
  "from-amber-400 to-orange-500",
  "from-rose-400 to-pink-500",
  "from-cyan-400 to-sky-600",
  "from-slate-600 to-slate-800",
];

function avatarGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

function senderInitials(name: string): string {
  const words = name
    .replace(/["'()[\]]/g, "")
    .split(/[\s·|,]+/)
    .filter(Boolean);
  if (words.length === 0) return "@";
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function formatFull(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
