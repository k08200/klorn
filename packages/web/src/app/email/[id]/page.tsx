"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { apiFetch } from "../../../lib/api";
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
          <header className="mb-5 overflow-hidden rounded-2xl border border-stone-700/45 bg-stone-950/55 shadow-2xl shadow-black/10">
            <div className="h-1 bg-gradient-to-r from-sky-300 via-amber-300 to-stone-600" />
            <div className="p-5 md:p-6">
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
              <section className="rounded-xl border border-stone-700/45 bg-stone-950/35 p-4">
                <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-stone-500">
                  본문
                </h2>
                <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-stone-200">
                  {email.body}
                </pre>
              </section>
            ) : email.snippet ? (
              <section className="rounded-xl border border-stone-700/45 bg-stone-950/35 p-4">
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

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-stone-700/45 bg-black/20 px-3 py-2">
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
      <section className="rounded-xl border border-stone-700/45 bg-stone-950/35 p-4">
        <p className="text-xs text-stone-500">
          EVE가 아직 분석하지 않은 메일이에요. 동기화 후 잠시 뒤에 다시 확인해 주세요.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
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

function formatFull(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
