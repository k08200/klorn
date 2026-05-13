"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { EveSignalField } from "../../../components/brand-visuals";
import { API_BASE, apiFetch, authHeaders } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

type EmailPriority = "URGENT" | "NORMAL" | "LOW";

interface EmailDetail {
  id: string;
  gmailId: string;
  threadId?: string | null;
  from: string;
  to: string;
  cc: string | null;
  subject: string;
  body: string | null;
  snippet: string | null;
  date: string;
  priority: EmailPriority;
  category: string | null;
  summary: string | null;
  keyPoints: string[];
  actionItems: string[];
  sentiment: string | null;
  isRead?: boolean;
  isStarred?: boolean;
  needsReply?: boolean;
  attachmentCount?: number;
  attachments?: EmailAttachment[];
  candidateProfile?: AttachmentCandidateProfile | null;
  candidateIntake?: CandidateIntake | null;
}

interface EmailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number | null;
  summary: string | null;
  textPreview: string | null;
  keyPoints: string[];
  extractedFields: Record<string, string | number | boolean | null>;
  category: string | null;
  analysisStatus: string;
  analysisError: string | null;
}

interface AttachmentCandidateProfile {
  detected: boolean;
  pipelineStatus: "ready_to_review" | "needs_info" | "needs_analysis";
  nextAction: string;
  name: string | null;
  role: string | null;
  contact: string | null;
  email: string | null;
  phone: string | null;
  age: string | null;
  height: string | null;
  skills: string[];
  links: string[];
  summary: string;
  evidenceFiles: Array<{
    filename: string;
    category: string | null;
    summary: string | null;
    analysisStatus: string;
    needsManualReview: boolean;
    reviewReason: string | null;
  }>;
  manualReviewFiles: Array<{
    filename: string;
    status: string;
    reason: string;
  }>;
  missingFields: string[];
  confidence: number;
}

type CandidateIntakeStatus =
  | "NEEDS_ANALYSIS"
  | "NEEDS_INFO"
  | "READY_TO_REVIEW"
  | "REVIEWING"
  | "CONTACTED"
  | "SHORTLISTED"
  | "REJECTED"
  | "ARCHIVED";

interface CandidateIntake {
  id: string;
  emailId: string;
  status: CandidateIntakeStatus;
  notes: string | null;
  updatedAt: string;
}

interface ReplyDraft {
  to: string;
  subject: string;
  body: string;
  candidateProfile: AttachmentCandidateProfile | null;
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

type AttachmentConversionTarget =
  | "txt"
  | "md"
  | "json"
  | "yaml"
  | "csv"
  | "html"
  | "xml"
  | "svg"
  | "rtf"
  | "pdf"
  | "docx"
  | "xlsx"
  | "png"
  | "jpg"
  | "webp"
  | "dwg"
  | "dxf";

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
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = params?.id;
  const shouldMarkRead = searchParams?.get("markRead") === "true";
  const [email, setEmail] = useState<EmailDetail | null>(null);
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

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<EmailDetail | { error: string }>(
        `/api/email/${id}${shouldMarkRead ? "?markRead=true" : "?markRead=false"}`,
      );
      if ("error" in data) {
        setError(data.error);
      } else {
        setEmail(data);
        setSelectedDraftAttachmentIds([]);
        setIncludeBriefAttachment((data.attachments?.length ?? 0) > 0);
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
      setError("메일을 불러오지 못했어요.");
    } finally {
      setLoading(false);
    }
  }, [id, shouldMarkRead]);

  useEffect(() => {
    load();
  }, [load]);

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
      setError("첨부파일을 다시 분석하지 못했어요.");
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
      setError("후보자 상태를 저장하지 못했어요.");
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
      setError("OCR/비전 분석을 실행하지 못했어요. Gmail 연결과 AI 키를 확인해 주세요.");
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
      setError("첨부 분석 수정사항을 저장하지 못했어요.");
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
      setError("답장 초안을 만들지 못했어요.");
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
      setError("답장을 보내지 못했어요. 주소와 본문을 확인해 주세요.");
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
      setError("Gmail 초안으로 저장하지 못했어요. Gmail 연결과 권한을 확인해 주세요.");
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
      setError(nextRead ? "읽음 처리하지 못했어요." : "읽지 않음으로 되돌리지 못했어요.");
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
      setError(nextStarred ? "별표를 추가하지 못했어요." : "별표를 해제하지 못했어요.");
    } finally {
      setActionBusy(null);
    }
  };

  const archiveEmailNow = async () => {
    if (!id || actionBusy) return;
    setActionBusy("archive");
    setError(null);
    try {
      await apiFetch(`/api/email/${id}/archive`, { method: "POST" });
      router.push("/email");
    } catch (err) {
      captureClientError(err, { scope: "email.detail.archive", id });
      setError("메일을 보관하지 못했어요.");
      setActionBusy(null);
    }
  };

  const deleteEmailNow = async () => {
    if (!id || actionBusy) return;
    const confirmed = window.confirm("이 메일을 휴지통으로 이동할까요?");
    if (!confirmed) return;
    setActionBusy("delete");
    setError(null);
    try {
      await apiFetch(`/api/email/${id}`, { method: "DELETE" });
      router.push("/email");
    } catch (err) {
      captureClientError(err, { scope: "email.detail.delete", id });
      setError("메일을 삭제하지 못했어요.");
      setActionBusy(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-5 md:py-10">
      <Link
        href="/email"
        className="mb-4 inline-flex items-center gap-1 rounded-full border border-stone-700/45 bg-stone-950/35 px-3 py-1.5 text-xs text-stone-400 transition hover:border-orange-500/35 hover:text-stone-100"
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
        메일 목록
      </Link>

      {loading && <p className="text-sm text-stone-500">로딩 중...</p>}

      {error && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {email && (
        <article>
          <header className="mb-5 overflow-hidden rounded-lg border border-stone-700/45 bg-stone-950/55 shadow-2xl shadow-black/10">
            <div className="h-1 bg-gradient-to-r from-[#7DD3FC] via-[#FF6B4A] to-stone-600" />
            <div className="p-5 md:p-6">
              <EmailActionToolbar
                busyAction={actionBusy}
                email={email}
                onArchive={archiveEmailNow}
                onDelete={deleteEmailNow}
                onToggleRead={toggleRead}
                onToggleStar={toggleStar}
              />
              <div className="grid gap-5 lg:grid-cols-[1fr_300px] lg:items-stretch">
                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#FF6B4A]/80">
                    신호 상세
                  </p>
                  <h1 className="break-words text-xl font-semibold leading-snug tracking-tight text-stone-50 md:text-2xl">
                    {email.subject || "제목 없음"}
                  </h1>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-stone-400">
                    <span className="max-w-full truncate">{email.from}</span>
                    <span className="text-stone-600">·</span>
                    <time className="shrink-0 tabular-nums">{formatFull(email.date)}</time>
                    <span className="text-stone-600">·</span>
                    <span>{email.isRead ? "읽음" : "읽지 않음 유지"}</span>
                  </div>
                </div>
                <EveSignalField className="min-h-40 rounded-lg" />
              </div>
              <div className="mt-5 grid grid-cols-3 gap-2">
                <DetailStat label="우선순위" value={PRIORITY_LABELS[email.priority]} />
                <DetailStat label="답장" value={email.needsReply ? "필요" : "신호 없음"} />
                <DetailStat
                  label="분류"
                  value={email.category ? categoryLabel(email.category) : "-"}
                />
              </div>
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

          <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr] lg:items-start">
            <EveAnalysis
              email={email}
              onPriorityChange={(priority) =>
                setEmail((prev) => (prev ? { ...prev, priority } : prev))
              }
            />

            {email.body ? (
              <section className="rounded-lg border border-stone-700/45 bg-stone-950/35 p-4">
                <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-stone-500">
                  본문
                </h2>
                <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-stone-200">
                  {email.body}
                </pre>
              </section>
            ) : email.snippet ? (
              <section className="rounded-lg border border-stone-700/45 bg-stone-950/35 p-4">
                <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-stone-500">
                  미리보기
                </h2>
                <p className="text-sm text-stone-300">{email.snippet}</p>
              </section>
            ) : null}
          </div>
        </article>
      )}
    </div>
  );
}

function EmailActionToolbar({
  busyAction,
  email,
  onArchive,
  onDelete,
  onToggleRead,
  onToggleStar,
}: {
  busyAction: string | null;
  email: EmailDetail;
  onArchive: () => void;
  onDelete: () => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
}) {
  const disabled = busyAction !== null;
  const isDemo = email.id.startsWith("demo-");
  const actionDisabled = disabled || isDemo;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-800/70 bg-black/20 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-xs text-stone-500">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            email.isRead ? "bg-stone-600" : "bg-[#FF6B4A]"
          }`}
        />
        <span className="truncate">
          {isDemo ? "데모 메일" : email.isRead ? "읽은 메일" : "읽지 않은 메일"}
          {email.isStarred ? " · 별표됨" : ""}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <EmailActionButton
          busy={busyAction === "read"}
          disabled={actionDisabled}
          onClick={onToggleRead}
        >
          {email.isRead ? "안읽음" : "읽음"}
        </EmailActionButton>
        <EmailActionButton
          busy={busyAction === "star"}
          disabled={actionDisabled}
          onClick={onToggleStar}
        >
          {email.isStarred ? "별표 해제" : "별표"}
        </EmailActionButton>
        <EmailActionButton
          busy={busyAction === "archive"}
          disabled={actionDisabled}
          onClick={onArchive}
        >
          보관
        </EmailActionButton>
        <EmailActionButton
          busy={busyAction === "delete"}
          danger
          disabled={actionDisabled}
          onClick={onDelete}
        >
          삭제
        </EmailActionButton>
      </div>
    </div>
  );
}

function EmailActionButton({
  busy,
  children,
  danger = false,
  disabled,
  onClick,
}: {
  busy: boolean;
  children: string;
  danger?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-8 rounded-md border px-2.5 text-xs font-medium transition disabled:opacity-50 ${
        danger
          ? "border-red-500/25 bg-red-500/10 text-red-200 hover:bg-red-500/15"
          : "border-stone-700/70 bg-stone-950/50 text-stone-300 hover:border-stone-600 hover:bg-white/5"
      }`}
    >
      {busy ? "처리 중" : children}
    </button>
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
  const status = intake?.status ?? candidatePipelineToIntakeStatus(profile.pipelineStatus);
  return (
    <section className="mt-5 rounded-xl border border-orange-500/20 bg-orange-500/5 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#FF8A70]">
          후보자 카드
        </h2>
        <span className="text-[11px] text-stone-500">
          신뢰도 {Math.round(profile.confidence * 100)}%
        </span>
      </div>
      <div className="mb-3 rounded-lg border border-orange-500/15 bg-black/15 px-3 py-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-[#FF8A70]/70">
          파이프라인
        </p>
        <p className="mt-1 text-xs font-medium text-[#FFE2D7]">
          {candidatePipelineLabel(profile.pipelineStatus)}
        </p>
        <p className="mt-1 text-[11px] leading-5 text-stone-400">{profile.nextAction}</p>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {CANDIDATE_STATUS_OPTIONS.map((option) => (
          <button
            key={option.status}
            type="button"
            onClick={() => onUpdate({ status: option.status })}
            disabled={updating || status === option.status}
            className={`rounded border px-2 py-1 text-[11px] transition disabled:cursor-default ${
              status === option.status
                ? "border-[#FF8A70]/40 bg-[#FF8A70]/15 text-[#FFE2D7]"
                : "border-stone-700/60 bg-black/15 text-stone-400 hover:border-[#FF6B4A]/30 hover:text-[#FFB09C]"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="text-sm font-medium leading-relaxed text-stone-100">{profile.summary}</p>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
        <ProfileFact label="이름" value={profile.name} />
        <ProfileFact label="역할" value={profile.role} />
        <ProfileFact label="연락처" value={profile.contact} />
        <ProfileFact label="나이" value={profile.age} />
        <ProfileFact label="신장" value={profile.height} />
        <ProfileFact label="파일" value={`${profile.evidenceFiles.length}개`} />
      </div>
      {profile.skills.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {profile.skills.map((skill) => (
            <span
              key={skill}
              className="rounded border border-orange-500/25 bg-[#FF6B4A]/10 px-2 py-1 text-[11px] text-[#FFB09C]"
            >
              {skill}
            </span>
          ))}
        </div>
      )}
      {profile.links.length > 0 && (
        <div className="mt-3 space-y-1">
          {profile.links.map((link) => (
            <p key={link} className="break-all text-[11px] text-[#7DD3FC]">
              {link}
            </p>
          ))}
        </div>
      )}
      {profile.missingFields.length > 0 && (
        <p className="mt-3 text-[11px] text-[#FF6B4A]/80">
          추가 확인 필요: {profile.missingFields.map(candidateMissingLabel).join(", ")}
        </p>
      )}
      {profile.manualReviewFiles.length > 0 && (
        <div className="mt-3 rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 py-2">
          <p className="text-[11px] font-medium text-rose-200">원본 확인 필요</p>
          <ul className="mt-1 space-y-1">
            {profile.manualReviewFiles.map((file) => (
              <li key={`${file.filename}-${file.reason}`} className="text-[11px] text-rose-100/80">
                {file.filename}: {file.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <label className="mt-3 block">
        <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-stone-600">
          Review note
        </span>
        <textarea
          defaultValue={intake?.notes ?? ""}
          rows={2}
          onBlur={(e) => onUpdate({ notes: e.target.value || null })}
          className="w-full rounded-lg border border-orange-500/15 bg-black/15 px-3 py-2 text-xs leading-5 text-stone-300 outline-none transition focus:border-[#FF6B4A]/35"
          placeholder="검토 메모"
        />
      </label>
    </section>
  );
}

const CANDIDATE_STATUS_OPTIONS: Array<{ status: CandidateIntakeStatus; label: string }> = [
  { status: "NEEDS_ANALYSIS", label: "분석 필요" },
  { status: "NEEDS_INFO", label: "정보 확인" },
  { status: "READY_TO_REVIEW", label: "검토 대기" },
  { status: "REVIEWING", label: "검토 중" },
  { status: "CONTACTED", label: "연락 완료" },
  { status: "SHORTLISTED", label: "보류/후보" },
  { status: "REJECTED", label: "거절" },
  { status: "ARCHIVED", label: "보관" },
];

function candidatePipelineToIntakeStatus(
  status: AttachmentCandidateProfile["pipelineStatus"],
): CandidateIntakeStatus {
  if (status === "needs_analysis") return "NEEDS_ANALYSIS";
  if (status === "needs_info") return "NEEDS_INFO";
  return "READY_TO_REVIEW";
}

function ProfileFact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-lg border border-stone-800/60 bg-black/15 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-stone-600">{label}</p>
      <p className="mt-1 truncate text-xs text-stone-300">{value || "-"}</p>
    </div>
  );
}

function senderName(raw: string): string {
  const match = raw.match(/^([^<]+?)\s*</);
  if (match?.[1]) return match[1].trim();
  return raw.replace(/[<>]/g, "").trim();
}

function ThreadContextPanel({
  thread,
  currentEmailId,
}: {
  thread: ThreadDetail;
  currentEmailId: string;
}) {
  return (
    <section className="mb-5 rounded-xl border border-stone-700/45 bg-stone-950/35 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-stone-100">스레드 맥락</h2>
          <p className="mt-1 text-xs text-stone-500">
            이전 대화 {thread.messageCount}개를 함께 보고 답장 맥락을 확인합니다.
          </p>
        </div>
      </div>
      <ol className="space-y-2">
        {thread.messages.map((message) => {
          const current = message.id === currentEmailId;
          return (
            <li
              key={message.id}
              className={`rounded-lg border px-3 py-2 ${
                current ? "border-[#FF6B4A]/30 bg-[#FF6B4A]/10" : "border-stone-800/70 bg-black/15"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 truncate text-xs font-medium text-stone-200">
                  {senderName(message.from)}
                </p>
                <time className="shrink-0 text-[10px] tabular-nums text-stone-600">
                  {formatFull(message.date)}
                </time>
              </div>
              <p className="mt-1 truncate text-[11px] text-stone-500">
                {message.summary || message.snippet || message.subject || "요약 없음"}
              </p>
              {message.actionItems.length > 0 && (
                <p className="mt-1 text-[10px] text-[#FF8A70]">
                  할 일 {message.actionItems.length}개
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function AttachmentAnalysis({
  emailId,
  attachments,
  onReanalyze,
  onOcr,
  onSaveCorrection,
  reanalyzing,
  ocring,
  savingCorrectionId,
}: {
  emailId: string;
  attachments: EmailAttachment[];
  onReanalyze: () => void;
  onOcr: () => void;
  onSaveCorrection: (
    attachment: EmailAttachment,
    patch: {
      summary: string;
      category: string;
      extractedFields: Record<string, string | number | boolean | null>;
    },
  ) => void;
  reanalyzing: boolean;
  ocring: boolean;
  savingCorrectionId: string | null;
}) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [converting, setConverting] = useState<string | null>(null);
  const [conversionTargets, setConversionTargets] = useState<
    Record<string, AttachmentConversionTarget>
  >({});
  const [editingId, setEditingId] = useState<string | null>(null);

  const downloadBrief = async () => {
    if (downloading) return;
    setDownloading("brief");
    try {
      const res = await fetch(`${API_BASE}/api/email/${emailId}/attachments/brief`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`brief download failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "eve-attachment-brief.txt";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      captureClientError(err, { scope: "email.attachment.brief.download", emailId });
      alert("첨부 분석 요약 파일을 만들지 못했어요.");
    } finally {
      setDownloading(null);
    }
  };

  const downloadAttachment = async (attachment: EmailAttachment) => {
    if (downloading) return;
    setDownloading(attachment.id);
    try {
      const res = await fetch(
        `${API_BASE}/api/email/${emailId}/attachments/${attachment.id}/download`,
        { headers: authHeaders() },
      );
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = attachment.filename || "attachment";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      captureClientError(err, { scope: "email.attachment.download", attachmentId: attachment.id });
      alert("첨부 원본을 내려받지 못했어요. Gmail 연결 상태를 확인해 주세요.");
    } finally {
      setDownloading(null);
    }
  };

  const convertAttachment = async (attachment: EmailAttachment) => {
    const target = conversionTargets[attachment.id] ?? defaultConversionTarget(attachment);
    const conversionKey = `${attachment.id}:${target}`;
    if (converting) return;
    setConverting(conversionKey);
    try {
      const res = await fetch(
        `${API_BASE}/api/email/${emailId}/attachments/${attachment.id}/convert`,
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ targetFormat: target }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          code?: string;
        } | null;
        throw new Error(body?.error || `convert failed: ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        filenameFromContentDisposition(res.headers.get("Content-Disposition")) ||
        convertedFilename(attachment.filename, target);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      captureClientError(err, {
        scope: "email.attachment.convert",
        attachmentId: attachment.id,
        target,
      });
      alert(err instanceof Error ? err.message : "첨부파일 변환에 실패했어요.");
    } finally {
      setConverting(null);
    }
  };

  return (
    <section className="mt-5 rounded-xl border border-sky-500/20 bg-sky-500/5 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#7DD3FC]">
          첨부 분석
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-stone-500">{attachments.length}개 파일</span>
          <button
            type="button"
            onClick={downloadBrief}
            disabled={downloading === "brief"}
            className="rounded border border-[#FF6B4A]/25 bg-[#FF6B4A]/10 px-2 py-1 text-[11px] text-[#FFB09C] transition hover:bg-[#FF6B4A]/15 disabled:opacity-50"
          >
            {downloading === "brief" ? "생성 중..." : "요약 파일 받기"}
          </button>
          <button
            type="button"
            onClick={onReanalyze}
            disabled={reanalyzing}
            className="rounded border border-[#7DD3FC]/25 bg-[#7DD3FC]/10 px-2 py-1 text-[11px] text-sky-200 transition hover:bg-[#7DD3FC]/15 disabled:opacity-50"
          >
            {reanalyzing ? "분석 중..." : "다시 분석"}
          </button>
          <button
            type="button"
            onClick={onOcr}
            disabled={ocring}
            className="rounded border border-[#FF6B4A]/25 bg-[#FF6B4A]/10 px-2 py-1 text-[11px] text-[#FFB09C] transition hover:bg-[#FF6B4A]/15 disabled:opacity-50"
          >
            {ocring ? "OCR 중..." : "OCR/비전"}
          </button>
        </div>
      </div>
      <div className="space-y-3">
        {attachments.map((attachment) => (
          <div
            key={attachment.id}
            className="border-t border-sky-500/15 pt-3 first:border-t-0 first:pt-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="max-w-full truncate text-sm font-medium text-stone-100">
                {attachment.filename}
              </span>
              {attachment.category && (
                <span className="rounded border border-[#7DD3FC]/30 bg-[#7DD3FC]/10 px-1.5 py-0.5 text-[10px] text-sky-200">
                  {attachmentCategoryLabel(attachment.category)}
                </span>
              )}
              <span className="text-[11px] text-stone-600">
                {formatBytes(attachment.size)} · {attachmentStatusLabel(attachment.analysisStatus)}
              </span>
              {attachmentNeedsManualReview(attachment) && (
                <span className="rounded border border-rose-400/25 bg-rose-400/10 px-1.5 py-0.5 text-[10px] text-rose-200">
                  원본 확인
                </span>
              )}
              <button
                type="button"
                onClick={() => downloadAttachment(attachment)}
                disabled={downloading === attachment.id}
                className="rounded border border-stone-700/70 bg-stone-950/45 px-2 py-0.5 text-[10px] text-stone-400 transition hover:border-[#7DD3FC]/30 hover:text-sky-200 disabled:opacity-50"
              >
                {downloading === attachment.id ? "받는 중" : "원본 받기"}
              </button>
              <div className="flex items-center gap-1 rounded border border-stone-700/60 bg-stone-950/45 p-0.5">
                <select
                  value={conversionTargets[attachment.id] ?? defaultConversionTarget(attachment)}
                  onChange={(event) =>
                    setConversionTargets((prev) => ({
                      ...prev,
                      [attachment.id]: event.target.value as AttachmentConversionTarget,
                    }))
                  }
                  className="max-w-20 bg-transparent px-1 py-0.5 text-[10px] text-stone-400 outline-none"
                  aria-label={`${attachment.filename} 변환 형식`}
                >
                  {ATTACHMENT_CONVERSION_TARGETS.map((target) => (
                    <option key={target.value} value={target.value}>
                      {target.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => convertAttachment(attachment)}
                  disabled={
                    converting ===
                    `${attachment.id}:${conversionTargets[attachment.id] ?? defaultConversionTarget(attachment)}`
                  }
                  className="rounded bg-[#7DD3FC] px-2 py-0.5 text-[10px] font-medium text-stone-950 transition hover:bg-sky-200 disabled:opacity-50"
                >
                  {converting?.startsWith(`${attachment.id}:`) ? "변환 중" : "변환"}
                </button>
              </div>
            </div>
            {attachment.summary && (
              <p className="mt-2 text-xs leading-relaxed text-stone-300">{attachment.summary}</p>
            )}
            {attachmentNeedsManualReview(attachment) && (
              <p className="mt-2 text-[11px] leading-relaxed text-rose-200/80">
                {attachmentManualReviewReason(attachment)}
              </p>
            )}
            {attachment.keyPoints.length > 0 && (
              <ul className="mt-2 space-y-1">
                {attachment.keyPoints.map((point, index) => (
                  <li
                    key={`${attachment.id}-${index}`}
                    className="flex gap-1.5 text-xs text-stone-400"
                  >
                    <span className="text-[#7DD3FC]/80">•</span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            )}
            {Object.keys(attachment.extractedFields).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(attachment.extractedFields).map(([key, value]) =>
                  value === null || value === "" ? null : (
                    <span
                      key={key}
                      className="rounded border border-stone-700/60 bg-stone-950/45 px-2 py-1 text-[11px] text-stone-400"
                    >
                      {fieldLabel(key)}: {String(value)}
                    </span>
                  ),
                )}
              </div>
            )}
            {attachment.textPreview && (
              <details className="mt-2 rounded-lg border border-stone-800/70 bg-black/15 px-3 py-2">
                <summary className="cursor-pointer text-[11px] font-medium text-stone-500">
                  변환 텍스트 미리보기
                </summary>
                <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-stone-500">
                  {attachment.textPreview}
                </pre>
              </details>
            )}
            {attachment.analysisError && (
              <p className="mt-2 text-[11px] leading-relaxed text-[#FF6B4A]/70">
                보조 분석으로 처리됨: {attachment.analysisError}
              </p>
            )}
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setEditingId(editingId === attachment.id ? null : attachment.id)}
                className="rounded border border-stone-700/70 bg-stone-950/45 px-2 py-1 text-[10px] text-stone-400 transition hover:border-[#FF6B4A]/30 hover:text-[#FFB09C]"
              >
                {editingId === attachment.id ? "수정 닫기" : "분석 수정"}
              </button>
            </div>
            {editingId === attachment.id && (
              <AttachmentCorrectionForm
                attachment={attachment}
                saving={savingCorrectionId === attachment.id}
                onSave={(patch) => {
                  onSaveCorrection(attachment, patch);
                  setEditingId(null);
                }}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

const ATTACHMENT_CONVERSION_TARGETS: Array<{ value: AttachmentConversionTarget; label: string }> = [
  { value: "txt", label: "TXT" },
  { value: "md", label: "MD" },
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "csv", label: "CSV" },
  { value: "html", label: "HTML" },
  { value: "xml", label: "XML" },
  { value: "svg", label: "SVG" },
  { value: "rtf", label: "RTF" },
  { value: "pdf", label: "PDF" },
  { value: "docx", label: "DOCX" },
  { value: "xlsx", label: "XLSX" },
  { value: "png", label: "PNG" },
  { value: "jpg", label: "JPG" },
  { value: "webp", label: "WEBP" },
  { value: "dwg", label: "DWG" },
  { value: "dxf", label: "DXF" },
];

function defaultConversionTarget(attachment: EmailAttachment): AttachmentConversionTarget {
  const name = attachment.filename.toLowerCase();
  if (name.endsWith(".pdf") || attachment.mimeType.toLowerCase().includes("pdf")) return "dwg";
  if (attachment.mimeType.toLowerCase().startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(name)) {
    return name.endsWith(".jpg") || name.endsWith(".jpeg")
      ? "jpg"
      : name.endsWith(".webp")
        ? "webp"
        : "png";
  }
  if (attachment.textPreview) return "txt";
  return "json";
}

function convertedFilename(filename: string, target: AttachmentConversionTarget): string {
  const clean = filename.replace(/[\\/:*?"<>|]+/g, "_") || "attachment";
  const base = clean.includes(".") ? clean.slice(0, clean.lastIndexOf(".")) : clean;
  return `${base || "attachment"}.${target}`;
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1]);
  const match = value.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? null;
}

function AttachmentCorrectionForm({
  attachment,
  saving,
  onSave,
}: {
  attachment: EmailAttachment;
  saving: boolean;
  onSave: (patch: {
    summary: string;
    category: string;
    extractedFields: Record<string, string | number | boolean | null>;
  }) => void;
}) {
  const [summary, setSummary] = useState(attachment.summary ?? "");
  const [category, setCategory] = useState(attachment.category ?? "document");
  const [fields, setFields] = useState<Array<{ key: string; value: string }>>(() =>
    Object.entries(attachment.extractedFields ?? {}).map(([key, value]) => ({
      key,
      value: value === null ? "" : String(value),
    })),
  );
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const extractedFields: Record<string, string | number | boolean | null> = {};
    for (const field of fields) {
      const key = field.key.trim();
      if (!key) continue;
      extractedFields[key] = coerceFieldValue(field.value);
    }
    setError(null);
    onSave({ summary, category, extractedFields });
  };

  return (
    <div className="mt-3 rounded-lg border border-[#FF6B4A]/15 bg-[#FF6B4A]/5 p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_160px]">
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-stone-600">
            Summary
          </span>
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            className="w-full rounded border border-stone-700/60 bg-black/20 px-2 py-1.5 text-xs text-stone-300 outline-none focus:border-orange-500/40"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-stone-600">
            Category
          </span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded border border-stone-700/60 bg-black/20 px-2 py-1.5 text-xs text-stone-300 outline-none focus:border-orange-500/40"
          >
            {[
              "resume",
              "profile",
              "portfolio",
              "audition",
              "contract",
              "invoice",
              "proposal",
              "schedule",
              "image",
              "document",
              "other",
            ].map((value) => (
              <option key={value} value={value}>
                {attachmentCategoryLabel(value)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="block text-[10px] uppercase tracking-wider text-stone-600">
            추출 필드
          </span>
          <button
            type="button"
            onClick={() => setFields((prev) => [...prev, { key: "", value: "" }])}
            className="text-[11px] text-[#7DD3FC] transition hover:text-sky-200"
          >
            필드 추가
          </button>
        </div>
        <div className="space-y-1.5">
          {fields.length === 0 && (
            <p className="rounded border border-stone-800/70 bg-black/15 px-2 py-2 text-[11px] text-stone-500">
              아직 추출된 필드가 없어요. 필요한 값을 직접 추가할 수 있습니다.
            </p>
          )}
          {fields.map((field, index) => (
            <div
              key={`${index}-${field.key}`}
              className="grid gap-1.5 sm:grid-cols-[150px_1fr_auto]"
            >
              <input
                value={field.key}
                onChange={(event) =>
                  setFields((prev) =>
                    prev.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, key: event.target.value } : item,
                    ),
                  )
                }
                placeholder="필드명"
                className="rounded border border-stone-700/60 bg-black/20 px-2 py-1.5 text-xs text-stone-300 outline-none focus:border-orange-500/40"
              />
              <input
                value={field.value}
                onChange={(event) =>
                  setFields((prev) =>
                    prev.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, value: event.target.value } : item,
                    ),
                  )
                }
                placeholder="값"
                className="rounded border border-stone-700/60 bg-black/20 px-2 py-1.5 text-xs text-stone-300 outline-none focus:border-orange-500/40"
              />
              <button
                type="button"
                onClick={() =>
                  setFields((prev) => prev.filter((_, itemIndex) => itemIndex !== index))
                }
                className="rounded border border-stone-700/60 px-2 py-1.5 text-[11px] text-stone-500 transition hover:border-rose-400/30 hover:text-rose-200"
              >
                삭제
              </button>
            </div>
          ))}
        </div>
      </div>
      {error && <p className="mt-1 text-[11px] text-rose-300">{error}</p>}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded bg-[#FF6B4A] px-3 py-1.5 text-xs font-medium text-stone-950 transition hover:bg-[#FFB09C] disabled:opacity-50"
        >
          {saving ? "저장 중..." : "수정 저장"}
        </button>
      </div>
    </div>
  );
}

function coerceFieldValue(value: string): string | number | boolean | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const numeric = Number(trimmed.replace(/,/g, ""));
  if (Number.isFinite(numeric) && /^-?\d+(?:,\d{3})*(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return numeric;
  }
  return value;
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

const WORK_MODE_OPTIONS: Array<{ value: EmailWorkMode; label: string }> = [
  { value: "founder", label: "창업자" },
  { value: "sales", label: "세일즈" },
  { value: "recruiting", label: "채용/캐스팅" },
  { value: "legal", label: "법무" },
  { value: "finance", label: "재무" },
  { value: "pm", label: "PM" },
  { value: "support", label: "고객지원" },
  { value: "ops", label: "운영/행사" },
  { value: "real_estate", label: "부동산" },
  { value: "freelance", label: "프리랜서" },
];

const MODE_INTENTS: Record<EmailWorkMode, Array<{ label: string; intent: string }>> = {
  founder: [
    {
      label: "투자자 후속",
      intent: "투자자에게 핵심 업데이트를 짧게 공유하고 다음 미팅 가능 시간을 물어봐 주세요.",
    },
    {
      label: "VIP 빠른 회신",
      intent: "중요한 관계를 놓치지 않도록 감사 인사와 다음 행동을 분명히 담아 답장해 주세요.",
    },
  ],
  sales: [
    {
      label: "미팅 잡기",
      intent: "고객 맥락을 반영해 discovery 또는 후속 미팅 가능한 시간을 제안해 주세요.",
    },
    { label: "갱신/가격", intent: "갱신 일정, 가격 조건, 다음 승인 단계를 정중히 확인해 주세요." },
  ],
  recruiting: [],
  legal: [
    {
      label: "검토 접수",
      intent:
        "법무 검토가 필요하다는 점을 확인하고, 확정 의견은 검토 후 전달하겠다고 안전하게 답장해 주세요.",
    },
    {
      label: "계약 정보 요청",
      intent: "계약 검토에 필요한 당사자, 기한, 서명 상태, 변경 요청 사항을 요청해 주세요.",
    },
  ],
  finance: [
    {
      label: "송장 확인",
      intent: "송장 수령을 확인하고 지급 예정일, 누락된 세금/계좌/PO 정보가 있으면 요청해 주세요.",
    },
    {
      label: "결제 이슈",
      intent: "결제 실패나 미지급 상태를 확인하고 필요한 증빙과 다음 처리 일정을 안내해 주세요.",
    },
  ],
  pm: [
    {
      label: "이슈 접수",
      intent: "고객/이해관계자 이슈를 접수했고 영향도와 재현 정보, 원하는 마감일을 확인해 주세요.",
    },
    {
      label: "결정 요청",
      intent: "현재 결정해야 할 항목, 선택지, 필요한 입력을 간단히 정리해 답장해 주세요.",
    },
  ],
  support: [
    {
      label: "문의 접수",
      intent: "문의 접수를 알리고 문제 재현 정보, 계정 정보, 긴급도를 정중히 요청해 주세요.",
    },
    {
      label: "에스컬레이션",
      intent: "문제를 내부에 에스컬레이션했고 다음 업데이트 시점을 명확히 안내해 주세요.",
    },
  ],
  ops: [
    {
      label: "일정 확인",
      intent: "일정, 장소, 준비물, 담당자, 마감 시간을 확인하는 답장을 작성해 주세요.",
    },
    { label: "벤더 후속", intent: "견적/계약/납품 일정과 누락된 자료를 벤더에게 확인해 주세요." },
  ],
  real_estate: [
    {
      label: "방문 일정",
      intent: "매물 방문 가능 시간과 선호 조건을 확인하고 다음 약속을 제안해 주세요.",
    },
    {
      label: "계약 단계",
      intent: "계약/대출/검사/마감 일정에서 필요한 다음 자료를 정리해 요청해 주세요.",
    },
  ],
  freelance: [
    {
      label: "범위 확인",
      intent: "작업 범위, 산출물, 수정 횟수, 일정, 견적 확인이 필요하다고 답장해 주세요.",
    },
    {
      label: "피드백 수렴",
      intent: "피드백을 확인했고 반영 범위와 다음 전달 일정을 명확히 안내해 주세요.",
    },
  ],
};

function buildQuickReplyIntents(
  profile: AttachmentCandidateProfile | null,
  mode: EmailWorkMode,
): Array<{ label: string; intent: string }> {
  const intents: Array<{ label: string; intent: string }> = [...MODE_INTENTS[mode]];
  if (!profile) return intents.slice(0, 4);
  const missing = profile.missingFields.map(candidateMissingLabel);
  const manualFiles = profile.manualReviewFiles.map((file) => file.filename);

  if (missing.length > 0 || manualFiles.length > 0) {
    intents.push({
      label: "자료 보완 요청",
      intent: [
        "지원 자료 검토 중입니다.",
        manualFiles.length > 0
          ? `다음 파일은 내용을 정확히 읽기 어려워서 읽기 가능한 PDF/DOCX/HWPX 형식으로 다시 요청해 주세요: ${manualFiles.join(", ")}.`
          : "",
        missing.length > 0
          ? `추가로 확인이 필요한 정보도 정중히 요청해 주세요: ${missing.join(", ")}.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
  }

  if (profile.pipelineStatus === "ready_to_review") {
    intents.push({
      label: "접수 확인",
      intent:
        "지원 자료 접수와 검토 진행을 정중히 안내하고, 이후 일정이나 결과는 확인 후 다시 연락하겠다고 답장해 주세요.",
    });
  }

  intents.push({
    label: "오디션 일정 문의",
    intent:
      "프로필을 확인했고 가능한 오디션 일정, 연락 가능한 시간, 추가 포트폴리오 링크가 있다면 공유해 달라고 정중히 물어봐 주세요.",
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
  const quickIntents = buildQuickReplyIntents(candidateProfile, mode);

  return (
    <section className="mt-5 rounded-xl border border-stone-700/45 bg-stone-950/35 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-stone-300">
            답장 초안
          </h2>
          <p className="mt-1 text-xs text-stone-500">
            Eve가 초안을 만들고, 전송은 직접 승인합니다.
          </p>
        </div>
        <button
          type="button"
          onClick={onGenerate}
          disabled={drafting}
          className="rounded-lg border border-orange-500/30 px-3 py-1.5 text-xs text-[#FFB09C] transition hover:bg-orange-500/10 disabled:opacity-50"
        >
          {drafting ? "작성 중..." : draft ? "다시 작성" : "초안 만들기"}
        </button>
      </div>
      <input
        value={intent}
        onChange={(e) => onIntentChange(e.target.value)}
        placeholder="예: 프로필 확인했고 다음 오디션 일정 가능 여부를 물어봐"
        className="mb-3 w-full rounded-lg border border-stone-700/60 bg-black/20 px-3 py-2 text-xs text-stone-300 placeholder-stone-600 outline-none transition focus:border-orange-500/40"
      />
      <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
        {WORK_MODE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setMode(option.value)}
            className={`h-8 shrink-0 rounded-full border px-3 text-[11px] transition ${
              mode === option.value
                ? "border-[#FF6B4A]/45 bg-[#FF6B4A]/15 text-[#FFB09C]"
                : "border-stone-700/60 bg-black/15 text-stone-400 hover:border-stone-600"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {quickIntents.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {quickIntents.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => onIntentChange(item.intent)}
              className="rounded-full border border-stone-700/60 bg-black/15 px-3 py-1.5 text-[11px] text-stone-300 transition hover:border-[#7DD3FC]/35 hover:bg-[#7DD3FC]/10 hover:text-sky-100"
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
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-stone-600">
                To
              </span>
              <input
                value={draft.to}
                onChange={(e) => onDraftChange({ ...draft, to: e.target.value })}
                className="w-full rounded border border-stone-700/60 bg-black/20 px-2 py-1.5 text-stone-300 outline-none focus:border-orange-500/40"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-stone-600">
                Subject
              </span>
              <input
                value={draft.subject}
                onChange={(e) => onDraftChange({ ...draft, subject: e.target.value })}
                className="w-full rounded border border-stone-700/60 bg-black/20 px-2 py-1.5 text-stone-300 outline-none focus:border-orange-500/40"
              />
            </label>
          </div>
          <textarea
            value={draft.body}
            onChange={(e) => onDraftChange({ ...draft, body: e.target.value })}
            rows={7}
            className="w-full rounded-lg border border-stone-700/60 bg-black/20 px-3 py-2 text-sm leading-6 text-stone-200 outline-none focus:border-orange-500/40"
          />
          {attachments.length > 0 && (
            <div className="space-y-2 rounded-lg border border-stone-800/70 bg-black/15 px-3 py-2">
              <label className="flex cursor-pointer items-start gap-2 rounded border border-[#FF6B4A]/15 bg-[#FF6B4A]/5 px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={includeBriefAttachment}
                  onChange={(e) => onIncludeBriefAttachmentChange(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-stone-600 bg-stone-900 text-[#FF8A70] focus:ring-[#FF8A70] focus:ring-offset-stone-950"
                />
                <span>
                  <span className="block text-[11px] font-medium text-[#FFB09C]">
                    첨부 분석 요약 파일 함께 첨부
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-4 text-stone-500">
                    후보자 카드, 핵심 포인트, 추출 필드를 txt 브리프로 변환합니다.
                  </span>
                </span>
              </label>
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-[10px] font-medium uppercase tracking-wider text-stone-600">
                  원본 첨부 함께 저장
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
                  className="text-[11px] text-[#7DD3FC] transition hover:text-sky-200"
                >
                  {selectedCount === attachments.length ? "전체 해제" : "전체 선택"}
                </button>
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {attachments.map((attachment) => (
                  <label
                    key={attachment.id}
                    className="flex min-w-0 cursor-pointer items-center gap-2 rounded border border-stone-800/70 bg-stone-950/35 px-2 py-1.5 transition hover:border-[#7DD3FC]/25"
                  >
                    <input
                      type="checkbox"
                      checked={selectedAttachmentIds.includes(attachment.id)}
                      onChange={() => toggleAttachment(attachment.id)}
                      className="h-3.5 w-3.5 rounded border-stone-600 bg-stone-900 text-[#7DD3FC] focus:ring-[#7DD3FC] focus:ring-offset-stone-950"
                    />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-stone-400">
                      {attachment.filename}
                    </span>
                    <span className="shrink-0 text-[10px] text-stone-600">
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
                  className="rounded-lg border border-[#FF6B4A]/30 px-3 py-1.5 text-xs font-medium text-[#FFB09C] transition hover:bg-[#FF6B4A]/10"
                >
                  Gmail 초안 열기
                </a>
              )}
              <button
                type="button"
                onClick={onSaveGmailDraft}
                disabled={savingGmailDraft || !draft.to || !draft.subject || !draft.body}
                className="rounded-lg border border-[#7DD3FC]/30 px-3 py-1.5 text-xs font-medium text-sky-200 transition hover:bg-[#7DD3FC]/10 disabled:opacity-50"
              >
                {savingGmailDraft
                  ? "저장 중..."
                  : draftAttachmentCount > 0
                    ? `Gmail 초안 저장 + 첨부 ${draftAttachmentCount}`
                    : "Gmail 초안 저장"}
              </button>
              <button
                type="button"
                onClick={onSend}
                disabled={sending || !draft.to || !draft.subject || !draft.body}
                className="rounded-lg bg-[#FF6B4A] px-3 py-1.5 text-xs font-medium text-stone-950 transition hover:bg-[#FFB09C] disabled:opacity-50"
              >
                {sending ? "전송 중..." : "이 내용으로 보내기"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-stone-700/45 bg-black/20 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">
        {label}
      </p>
      <p className="mt-1 truncate text-sm font-semibold text-stone-100">{value}</p>
    </div>
  );
}

function EveAnalysis({
  email,
  onPriorityChange,
}: {
  email: EmailDetail;
  onPriorityChange: (priority: EmailPriority) => void;
}) {
  const hasAnything =
    email.summary || email.keyPoints.length > 0 || email.actionItems.length > 0 || email.category;

  if (!hasAnything) {
    return (
      <section className="rounded-lg border border-stone-700/45 bg-stone-950/35 p-4">
        <p className="text-xs text-stone-500">
          Eve가 아직 분석하지 않은 메일이에요. 동기화 후 잠시 뒤에 다시 확인해 주세요.
        </p>
      </section>
    );
  }

  return (
    <section className="relative overflow-hidden rounded-lg border border-orange-500/20 bg-orange-500/5 p-4">
      <div className="absolute bottom-0 left-0 top-0 w-1 bg-gradient-to-b from-[#7DD3FC] via-[#FF6B4A] to-[#7DD3FC]" />
      <div className="pl-2">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#FF6B4A]">
            EVE 판단
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
        </div>

        {email.summary && <p className="text-sm leading-relaxed text-stone-200">{email.summary}</p>}

        {email.keyPoints.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-stone-500">
              핵심 포인트
            </p>
            <ul className="space-y-1">
              {email.keyPoints.map((k, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-stone-300">
                  <span className="text-[#FF6B4A]/75">•</span>
                  <span>{k}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {email.actionItems.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-stone-500">
              할 일
            </p>
            <ul className="space-y-1">
              {email.actionItems.map((a, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-stone-300">
                  <span className="text-[#FF6B4A]/80">□</span>
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {email.needsReply && <ReplyNeededFeedbackControl emailId={email.id} />}
      </div>
    </section>
  );
}

function ReplyNeededPill() {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#FF6B4A]/30 bg-[#FF6B4A]/10 text-[#FF6B4A] font-medium">
      답장 필요
    </span>
  );
}

const PRIORITY_LABELS: Record<EmailPriority, string> = {
  URGENT: "긴급",
  NORMAL: "보통",
  LOW: "낮음",
};

function LabelFeedbackControl({
  emailId,
  currentPriority,
  onPriorityChange,
}: {
  emailId: string;
  currentPriority: EmailPriority;
  onPriorityChange: (priority: EmailPriority) => void;
}) {
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
      setError("보고하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setSubmitting(null);
    }
  };

  if (feedback) {
    return (
      <span className="text-[11px] text-[#FF8A70]/80 inline-flex items-center gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-[#FF6B4A]" />
        보고됨: {PRIORITY_LABELS[feedback.originalPriority]} →{" "}
        {PRIORITY_LABELS[feedback.correctedPriority]}
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] text-stone-500 underline-offset-2 hover:text-stone-300 hover:underline"
      >
        분류 틀림
      </button>
    );
  }

  const options: EmailPriority[] = (["URGENT", "NORMAL", "LOW"] as const).filter(
    (p) => p !== currentPriority,
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-stone-500">실제 우선순위:</span>
      {options.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => submit(p)}
          disabled={!!submitting}
          className="rounded border border-stone-700 px-1.5 py-0.5 text-[11px] text-stone-200 transition hover:bg-stone-800 disabled:opacity-50"
        >
          {submitting === p ? "..." : PRIORITY_LABELS[p]}
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setError(null);
        }}
        disabled={!!submitting}
        className="text-[11px] text-stone-500 hover:text-stone-300"
      >
        취소
      </button>
      {error && <span className="text-[11px] text-red-300">{error}</span>}
    </div>
  );
}

function ReplyNeededFeedbackControl({ emailId }: { emailId: string }) {
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
      setError("저장하지 못했어요.");
    } finally {
      setSubmitting(null);
    }
  };

  const options: Array<{ choice: ReplyNeededChoice; label: string }> = [
    { choice: "today", label: "오늘 답장" },
    { choice: "waiting_on_me", label: "내가 처리" },
    { choice: "waiting_on_them", label: "상대 대기" },
    { choice: "needed", label: "답장 필요" },
    { choice: "not_needed", label: "필요 없음" },
    { choice: "later", label: "나중에" },
    { choice: "done", label: "완료" },
  ];

  return (
    <div className="mt-4 border-t border-orange-500/10 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-stone-500">답장 필요 판단:</span>
        {options.map((option) => {
          const selected = feedback?.choice === option.choice;
          return (
            <button
              key={option.choice}
              type="button"
              onClick={() => submit(option.choice)}
              aria-pressed={selected}
              disabled={!!submitting}
              className={`h-7 rounded-lg border px-2 text-[11px] transition disabled:opacity-50 ${
                selected
                  ? "border-[#FF6B4A] bg-[#FF6B4A]/10 text-[#FFB09C]"
                  : "border-stone-700 text-stone-400 hover:bg-stone-800"
              }`}
            >
              {submitting === option.choice ? "..." : option.label}
            </button>
          );
        })}
        {error && <span className="text-[11px] text-red-300">{error}</span>}
      </div>
    </div>
  );
}

function PriorityPill({ priority }: { priority: EmailDetail["priority"] }) {
  if (priority === "NORMAL") return null;
  const styles = {
    URGENT: "bg-red-500/15 text-red-300 border-red-500/30",
    LOW: "bg-stone-900 text-stone-500 border-stone-800",
  };
  const labels = { URGENT: "긴급", LOW: "낮음" };
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border ${styles[priority as "URGENT" | "LOW"]} font-medium`}
    >
      {labels[priority as "URGENT" | "LOW"]}
    </span>
  );
}

function CategoryPill({ category }: { category: string }) {
  const label = categoryLabel(category);
  return (
    <span className="rounded border border-stone-700 bg-stone-900/60 px-1.5 py-0.5 text-[10px] text-stone-400">
      {label}
    </span>
  );
}

function categoryLabel(category: string): string {
  const labelMap: Record<string, string> = {
    business: "비즈니스",
    engineering: "엔지니어링",
    automated: "자동화",
    newsletter: "뉴스레터",
    meeting: "미팅",
    billing: "청구",
    conversation: "대화",
    other: "기타",
  };
  return labelMap[category] || category;
}

function attachmentCategoryLabel(category: string): string {
  const labelMap: Record<string, string> = {
    resume: "이력서",
    profile: "프로필",
    portfolio: "포트폴리오",
    audition: "오디션",
    contract: "계약서",
    invoice: "청구",
    proposal: "제안서",
    schedule: "일정",
    image: "이미지",
    document: "문서",
    other: "기타",
  };
  return labelMap[category] || category;
}

function attachmentStatusLabel(status: string): string {
  const labelMap: Record<string, string> = {
    ANALYZED: "분석 완료",
    FALLBACK: "보조 분석",
    PENDING: "분석 대기",
    UNSUPPORTED: "본문 추출 제한",
  };
  return labelMap[status] || status.toLowerCase();
}

function attachmentNeedsManualReview(attachment: EmailAttachment): boolean {
  return !!attachmentManualReviewReason(attachment);
}

function attachmentManualReviewReason(attachment: EmailAttachment): string | null {
  if (attachment.analysisStatus === "UNSUPPORTED")
    return "본문 추출이 제한되어 원본 확인이 필요합니다.";
  if (attachment.analysisStatus === "PENDING") return "아직 분석 대기 상태입니다.";
  if (attachment.analysisStatus === "FALLBACK")
    return "AI 분석 실패 후 보조 분석으로 처리되어 원본 확인을 권장합니다.";
  const preview = attachment.textPreview ?? "";
  if (/OCR 분석 대기/.test(preview)) return "이미지 파일이라 OCR 또는 원본 확인이 필요합니다.";
  if (/텍스트 레이어 없음|추출 실패/.test(preview))
    return "자동 텍스트 추출이 불완전해 원본 확인이 필요합니다.";
  return null;
}

function candidateMissingLabel(key: string): string {
  const labelMap: Record<string, string> = {
    name: "이름",
    contact: "연락처",
    role: "역할",
    portfolio: "포트폴리오 링크",
  };
  return labelMap[key] || key;
}

function candidatePipelineLabel(status: AttachmentCandidateProfile["pipelineStatus"]): string {
  const labels: Record<AttachmentCandidateProfile["pipelineStatus"], string> = {
    ready_to_review: "검토 가능",
    needs_info: "정보 보강 필요",
    needs_analysis: "분석 확인 필요",
  };
  return labels[status];
}

function fieldLabel(key: string): string {
  const labelMap: Record<string, string> = {
    name: "이름",
    role: "역할",
    contact: "연락처",
    email: "이메일",
    phone: "전화",
    age: "나이",
    height: "신장",
    skills: "특기",
    links: "링크",
    deadline: "마감",
    amount: "금액",
    availability: "가능 일정",
  };
  return labelMap[key] || key;
}

function formatBytes(size: number | null): string {
  if (!size || size <= 0) return "크기 미상";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatFull(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
