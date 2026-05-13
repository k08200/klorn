"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

type CandidateStatus =
  | "ALL"
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
  status: Exclude<CandidateStatus, "ALL">;
  name: string | null;
  role: string | null;
  contact: string | null;
  emailAddress: string | null;
  phone: string | null;
  summary: string;
  confidence: number;
  missingFields: string[];
  evidenceFiles: Array<{ filename: string; category: string | null; summary: string | null }>;
  notes: string | null;
  updatedAt: string;
  email: {
    id: string;
    from: string;
    subject: string;
    snippet: string | null;
    receivedAt: string;
    isRead: boolean;
  };
}

const STATUS_FILTERS: Array<{ status: CandidateStatus; label: string }> = [
  { status: "ALL", label: "전체" },
  { status: "NEEDS_ANALYSIS", label: "분석 필요" },
  { status: "NEEDS_INFO", label: "정보 확인" },
  { status: "READY_TO_REVIEW", label: "검토 대기" },
  { status: "REVIEWING", label: "검토 중" },
  { status: "CONTACTED", label: "연락 완료" },
  { status: "SHORTLISTED", label: "보류/후보" },
  { status: "REJECTED", label: "거절" },
  { status: "ARCHIVED", label: "보관" },
];

export default function CandidateIntakePage() {
  return (
    <AuthGuard>
      <CandidateIntakeView />
    </AuthGuard>
  );
}

function CandidateIntakeView() {
  const [status, setStatus] = useState<CandidateStatus>("ALL");
  const [candidates, setCandidates] = useState<CandidateIntake[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextStatus: CandidateStatus, refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "80" });
      if (nextStatus !== "ALL") params.set("status", nextStatus);
      if (refresh) params.set("refresh", "true");
      const data = await apiFetch<{ candidates: CandidateIntake[] }>(
        `/api/email/candidates?${params.toString()}`,
      );
      setCandidates(Array.isArray(data.candidates) ? data.candidates : []);
    } catch (err) {
      captureClientError(err, { scope: "email.candidates.load", status: nextStatus });
      setError("후보자 접수를 불러오지 못했어요.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(status);
  }, [load, status]);

  const readyCount = candidates.filter((c) => c.status === "READY_TO_REVIEW").length;
  const needsCount = candidates.filter((c) =>
    ["NEEDS_ANALYSIS", "NEEDS_INFO"].includes(c.status),
  ).length;
  const contactedCount = candidates.filter((c) => c.status === "CONTACTED").length;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 md:py-10">
      <header className="mb-5 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5 shadow-2xl shadow-black/10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80">
              후보자 접수
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-stone-50">후보자 접수함</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-500">
              메일 첨부에서 감지한 이력서, 프로필, 포트폴리오, 오디션 자료를 검토합니다.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              href="/email"
              className="rounded-lg border border-stone-700/60 px-3 py-1.5 text-xs text-stone-300 transition hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-100"
            >
              메일
            </Link>
            <button
              type="button"
              onClick={() => load(status, true)}
              disabled={refreshing}
              className="rounded-lg border border-emerald-400/30 px-3 py-1.5 text-xs text-emerald-200 transition hover:bg-emerald-400/10 disabled:opacity-50"
            >
              {refreshing ? "갱신 중..." : "후보자 재스캔"}
            </button>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-2">
          <QueueStat label="확인 필요" value={needsCount} />
          <QueueStat label="검토 대기" value={readyCount} />
          <QueueStat label="연락 완료" value={contactedCount} />
        </div>
      </header>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 scrollbar-hide">
        {STATUS_FILTERS.map((filter) => {
          const active = filter.status === status;
          return (
            <button
              key={filter.status}
              type="button"
              onClick={() => setStatus(filter.status)}
              className={`min-h-[32px] shrink-0 rounded-full px-3 py-1.5 text-xs transition ${
                active
                  ? "bg-emerald-300 text-stone-950"
                  : "border border-stone-700/55 bg-stone-950/45 text-stone-400 hover:bg-stone-900/70 hover:text-stone-200"
              }`}
            >
              {filter.label}
            </button>
          );
        })}
      </div>

      {loading && <p className="px-1 py-3 text-sm text-stone-500">로딩 중...</p>}

      {error && (
        <div className="mt-3 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && candidates.length === 0 && (
        <div className="mt-4 rounded-xl border border-stone-700/45 bg-stone-950/35 p-6 text-center">
          <p className="text-sm text-stone-300">아직 후보자 자료가 잡히지 않았어요.</p>
          <p className="mt-1 text-xs text-stone-600">
            Gmail 동기화와 첨부 분석이 끝나면 여기에 표시됩니다.
          </p>
        </div>
      )}

      {!loading && candidates.length > 0 && (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {candidates.map((candidate) => (
            <CandidateCard key={candidate.id} candidate={candidate} />
          ))}
        </div>
      )}
    </div>
  );
}

function QueueStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-stone-700/45 bg-black/15 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold text-stone-100">{value}</p>
    </div>
  );
}

function CandidateCard({ candidate }: { candidate: CandidateIntake }) {
  const email = candidate.email ?? {
    id: candidate.emailId,
    from: candidate.emailAddress ?? "",
    subject: "제목 없음",
    snippet: null,
    receivedAt: candidate.updatedAt ?? new Date().toISOString(),
    isRead: true,
  };
  const title = [candidate.name || "이름 미확인", candidate.role].filter(Boolean).join(" · ");
  return (
    <Link
      href={`/email/${candidate.emailId}`}
      className="block rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 transition hover:border-emerald-400/35 hover:bg-emerald-400/10"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-emerald-400/25 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-200">
              {candidateStatusLabel(candidate.status)}
            </span>
            <span className="text-[10px] tabular-nums text-emerald-300/75">
              {Math.round(candidate.confidence * 100)}%
            </span>
          </div>
          <h2 className="mt-2 truncate text-sm font-semibold text-stone-100">{title}</h2>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-stone-400">{candidate.summary}</p>
        </div>
        <time className="shrink-0 text-[11px] tabular-nums text-stone-500">
          {formatRelative(email.receivedAt)}
        </time>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-stone-500">
        {candidate.contact && <span className="truncate">연락처 {candidate.contact}</span>}
        <span>파일 {candidate.evidenceFiles?.length ?? 0}개</span>
        {(candidate.missingFields?.length ?? 0) > 0 && (
          <span className="text-amber-300/80">
            부족한 정보 {candidate.missingFields.map(candidateMissingLabel).join(", ")}
          </span>
        )}
      </div>
      <div className="mt-3 rounded-lg border border-stone-800/60 bg-black/15 px-3 py-2">
        <p className="truncate text-xs text-stone-300">{email.subject || "제목 없음"}</p>
        <p className="mt-1 truncate text-[11px] text-stone-600">{senderName(email.from)}</p>
      </div>
      {candidate.notes && (
        <p className="mt-2 line-clamp-2 text-[11px] leading-5 text-stone-500">
          메모: {candidate.notes}
        </p>
      )}
    </Link>
  );
}

function candidateStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    NEEDS_ANALYSIS: "분석 필요",
    NEEDS_INFO: "정보 확인",
    READY: "준비됨",
    READY_TO_REVIEW: "검토 대기",
    REVIEWING: "검토 중",
    CONTACTED: "연락 완료",
    SHORTLISTED: "보류/후보",
    REJECTED: "거절",
    ARCHIVED: "보관",
  };
  return labels[status] || status;
}

function candidateMissingLabel(field: string): string {
  const labels: Record<string, string> = {
    name: "이름",
    contact: "연락처",
    role: "역할",
    portfolio: "포트폴리오",
  };
  return labels[field] || field;
}

function senderName(raw: string): string {
  const match = raw.match(/^([^<]+?)\s*</);
  if (match?.[1]) return match[1].trim();
  return raw.replace(/[<>]/g, "").trim();
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "방금";
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "2-digit" }),
  });
}
