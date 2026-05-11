"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { EveSignalField } from "../../../components/brand-visuals";
import { API_BASE, apiFetch, authHeaders } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

type EmailPriority = "URGENT" | "NORMAL" | "LOW";

interface EmailDetail {
  id: string;
  gmailId: string;
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

type ReplyNeededChoice = "needed" | "not_needed" | "later" | "done";

interface ReplyNeededFeedback {
  id: string;
  choice: ReplyNeededChoice;
  signal: string;
  evidence: string | null;
  createdAt: string;
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
  const id = params?.id;
  const [email, setEmail] = useState<EmailDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [draft, setDraft] = useState<ReplyDraft | null>(null);
  const [draftIntent, setDraftIntent] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [sendingDraft, setSendingDraft] = useState(false);
  const [savingGmailDraft, setSavingGmailDraft] = useState(false);
  const [gmailDraftUrl, setGmailDraftUrl] = useState<string | null>(null);
  const [selectedDraftAttachmentIds, setSelectedDraftAttachmentIds] = useState<string[]>([]);
  const [updatingCandidate, setUpdatingCandidate] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<EmailDetail | { error: string }>(`/api/email/${id}`);
      if ("error" in data) {
        setError(data.error);
      } else {
        setEmail(data);
        setSelectedDraftAttachmentIds([]);
      }
    } catch (err) {
      captureClientError(err, { scope: "email.detail", id });
      setError("메일을 불러오지 못했어요.");
    } finally {
      setLoading(false);
    }
  }, [id]);

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

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-5 md:py-10">
      <Link
        href="/email"
        className="mb-4 inline-flex items-center gap-1 rounded-full border border-stone-700/45 bg-stone-950/35 px-3 py-1.5 text-xs text-stone-400 transition hover:border-amber-500/35 hover:text-stone-100"
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
            <div className="h-1 bg-gradient-to-r from-sky-300 via-amber-300 to-stone-600" />
            <div className="p-5 md:p-6">
              <div className="grid gap-5 lg:grid-cols-[1fr_300px] lg:items-stretch">
                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
                    신호 상세
                  </p>
                  <h1 className="break-words text-xl font-semibold leading-snug tracking-tight text-stone-50 md:text-2xl">
                    {email.subject || "제목 없음"}
                  </h1>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-stone-400">
                    <span className="max-w-full truncate">{email.from}</span>
                    <span className="text-stone-600">·</span>
                    <time className="shrink-0 tabular-nums">{formatFull(email.date)}</time>
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

          <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr] lg:items-start">
            <EveAnalysis email={email} />

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
    <section className="mt-5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
          후보자 카드
        </h2>
        <span className="text-[11px] text-stone-500">
          신뢰도 {Math.round(profile.confidence * 100)}%
        </span>
      </div>
      <div className="mb-3 rounded-lg border border-emerald-500/15 bg-black/15 px-3 py-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-emerald-300/70">
          파이프라인
        </p>
        <p className="mt-1 text-xs font-medium text-emerald-100">
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
                ? "border-emerald-300/40 bg-emerald-300/15 text-emerald-100"
                : "border-stone-700/60 bg-black/15 text-stone-400 hover:border-emerald-400/30 hover:text-emerald-200"
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
              className="rounded border border-emerald-500/25 bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-200"
            >
              {skill}
            </span>
          ))}
        </div>
      )}
      {profile.links.length > 0 && (
        <div className="mt-3 space-y-1">
          {profile.links.map((link) => (
            <p key={link} className="break-all text-[11px] text-sky-300">
              {link}
            </p>
          ))}
        </div>
      )}
      {profile.missingFields.length > 0 && (
        <p className="mt-3 text-[11px] text-amber-300/80">
          추가 확인 필요: {profile.missingFields.map(candidateMissingLabel).join(", ")}
        </p>
      )}
      <label className="mt-3 block">
        <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-stone-600">
          Review note
        </span>
        <textarea
          defaultValue={intake?.notes ?? ""}
          rows={2}
          onBlur={(e) => onUpdate({ notes: e.target.value || null })}
          className="w-full rounded-lg border border-emerald-500/15 bg-black/15 px-3 py-2 text-xs leading-5 text-stone-300 outline-none transition focus:border-emerald-400/35"
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

function AttachmentAnalysis({
  emailId,
  attachments,
  onReanalyze,
  reanalyzing,
}: {
  emailId: string;
  attachments: EmailAttachment[];
  onReanalyze: () => void;
  reanalyzing: boolean;
}) {
  const [downloading, setDownloading] = useState<string | null>(null);

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

  return (
    <section className="mt-5 rounded-xl border border-sky-500/20 bg-sky-500/5 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-sky-300">
          첨부 분석
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-stone-500">{attachments.length}개 파일</span>
          <button
            type="button"
            onClick={onReanalyze}
            disabled={reanalyzing}
            className="rounded border border-sky-400/25 bg-sky-400/10 px-2 py-1 text-[11px] text-sky-200 transition hover:bg-sky-400/15 disabled:opacity-50"
          >
            {reanalyzing ? "분석 중..." : "다시 분석"}
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
                <span className="rounded border border-sky-400/30 bg-sky-400/10 px-1.5 py-0.5 text-[10px] text-sky-200">
                  {attachmentCategoryLabel(attachment.category)}
                </span>
              )}
              <span className="text-[11px] text-stone-600">
                {formatBytes(attachment.size)} · {attachmentStatusLabel(attachment.analysisStatus)}
              </span>
              <button
                type="button"
                onClick={() => downloadAttachment(attachment)}
                disabled={downloading === attachment.id}
                className="rounded border border-stone-700/70 bg-stone-950/45 px-2 py-0.5 text-[10px] text-stone-400 transition hover:border-sky-400/30 hover:text-sky-200 disabled:opacity-50"
              >
                {downloading === attachment.id ? "받는 중" : "원본 받기"}
              </button>
            </div>
            {attachment.summary && (
              <p className="mt-2 text-xs leading-relaxed text-stone-300">{attachment.summary}</p>
            )}
            {attachment.keyPoints.length > 0 && (
              <ul className="mt-2 space-y-1">
                {attachment.keyPoints.map((point, index) => (
                  <li
                    key={`${attachment.id}-${index}`}
                    className="flex gap-1.5 text-xs text-stone-400"
                  >
                    <span className="text-sky-300/80">•</span>
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
              <p className="mt-2 text-[11px] leading-relaxed text-amber-300/70">
                보조 분석으로 처리됨: {attachment.analysisError}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ReplyDraftBox({
  draft,
  intent,
  drafting,
  sending,
  savingGmailDraft,
  gmailDraftUrl,
  attachments,
  selectedAttachmentIds,
  onSelectedAttachmentIdsChange,
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
  selectedAttachmentIds: string[];
  onSelectedAttachmentIdsChange: (ids: string[]) => void;
  onIntentChange: (value: string) => void;
  onGenerate: () => void;
  onDraftChange: (draft: ReplyDraft) => void;
  onSaveGmailDraft: () => void;
  onSend: () => void;
}) {
  const toggleAttachment = (attachmentId: string) => {
    onSelectedAttachmentIdsChange(
      selectedAttachmentIds.includes(attachmentId)
        ? selectedAttachmentIds.filter((id) => id !== attachmentId)
        : [...selectedAttachmentIds, attachmentId],
    );
  };
  const selectedCount = selectedAttachmentIds.length;

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
          className="rounded-lg border border-amber-500/30 px-3 py-1.5 text-xs text-amber-200 transition hover:bg-amber-500/10 disabled:opacity-50"
        >
          {drafting ? "작성 중..." : draft ? "다시 작성" : "초안 만들기"}
        </button>
      </div>
      <input
        value={intent}
        onChange={(e) => onIntentChange(e.target.value)}
        placeholder="예: 프로필 확인했고 다음 오디션 일정 가능 여부를 물어봐"
        className="mb-3 w-full rounded-lg border border-stone-700/60 bg-black/20 px-3 py-2 text-xs text-stone-300 placeholder-stone-600 outline-none transition focus:border-amber-500/40"
      />
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
                className="w-full rounded border border-stone-700/60 bg-black/20 px-2 py-1.5 text-stone-300 outline-none focus:border-amber-500/40"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-stone-600">
                Subject
              </span>
              <input
                value={draft.subject}
                onChange={(e) => onDraftChange({ ...draft, subject: e.target.value })}
                className="w-full rounded border border-stone-700/60 bg-black/20 px-2 py-1.5 text-stone-300 outline-none focus:border-amber-500/40"
              />
            </label>
          </div>
          <textarea
            value={draft.body}
            onChange={(e) => onDraftChange({ ...draft, body: e.target.value })}
            rows={7}
            className="w-full rounded-lg border border-stone-700/60 bg-black/20 px-3 py-2 text-sm leading-6 text-stone-200 outline-none focus:border-amber-500/40"
          />
          {attachments.length > 0 && (
            <div className="rounded-lg border border-stone-800/70 bg-black/15 px-3 py-2">
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
                  className="text-[11px] text-sky-300 transition hover:text-sky-200"
                >
                  {selectedCount === attachments.length ? "전체 해제" : "전체 선택"}
                </button>
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {attachments.map((attachment) => (
                  <label
                    key={attachment.id}
                    className="flex min-w-0 cursor-pointer items-center gap-2 rounded border border-stone-800/70 bg-stone-950/35 px-2 py-1.5 transition hover:border-sky-400/25"
                  >
                    <input
                      type="checkbox"
                      checked={selectedAttachmentIds.includes(attachment.id)}
                      onChange={() => toggleAttachment(attachment.id)}
                      className="h-3.5 w-3.5 rounded border-stone-600 bg-stone-900 text-sky-300 focus:ring-sky-300 focus:ring-offset-stone-950"
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
                  className="rounded-lg border border-emerald-400/30 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-400/10"
                >
                  Gmail 초안 열기
                </a>
              )}
              <button
                type="button"
                onClick={onSaveGmailDraft}
                disabled={savingGmailDraft || !draft.to || !draft.subject || !draft.body}
                className="rounded-lg border border-sky-400/30 px-3 py-1.5 text-xs font-medium text-sky-200 transition hover:bg-sky-400/10 disabled:opacity-50"
              >
                {savingGmailDraft
                  ? "저장 중..."
                  : selectedCount > 0
                    ? `Gmail 초안 저장 + 첨부 ${selectedCount}`
                    : "Gmail 초안 저장"}
              </button>
              <button
                type="button"
                onClick={onSend}
                disabled={sending || !draft.to || !draft.subject || !draft.body}
                className="rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-medium text-stone-950 transition hover:bg-amber-200 disabled:opacity-50"
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

function EveAnalysis({ email }: { email: EmailDetail }) {
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
    <section className="relative overflow-hidden rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
      <div className="absolute bottom-0 left-0 top-0 w-1 bg-gradient-to-b from-sky-300 via-amber-300 to-teal-300" />
      <div className="pl-2">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">
            EVE 판단
          </span>
          <div className="flex items-center gap-1.5">
            <PriorityPill priority={email.priority} />
            {email.needsReply && <ReplyNeededPill />}
            {email.category && <CategoryPill category={email.category} />}
          </div>
          <LabelFeedbackControl emailId={email.id} currentPriority={email.priority} />
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
                  <span className="text-amber-300/75">•</span>
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
                  <span className="text-amber-300/80">□</span>
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
    <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-400/30 bg-amber-400/10 text-amber-300 font-medium">
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
}: {
  emailId: string;
  currentPriority: EmailPriority;
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
      <span className="text-[11px] text-emerald-300/80 inline-flex items-center gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
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
    { choice: "needed", label: "맞음" },
    { choice: "not_needed", label: "아님" },
    { choice: "later", label: "나중에" },
    { choice: "done", label: "처리함" },
  ];

  return (
    <div className="mt-4 border-t border-amber-500/10 pt-3">
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
                  ? "border-amber-300 bg-amber-400/10 text-amber-200"
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
