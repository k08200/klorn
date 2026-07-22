"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { API_BASE, apiFetch, authHeaders } from "../../../lib/api";
import { queryKeys } from "../../../lib/query-keys";
import { captureClientError } from "../../../lib/sentry";
import { formatRelative } from "../../../lib/text";

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

type AttentionFilter = "all" | "duplicates" | "manual_review" | "incomplete";

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
  evidenceFiles: Array<{
    filename: string;
    category: string | null;
    summary: string | null;
    analysisStatus: string | null;
    needsManualReview: boolean;
    reviewReason: string | null;
  }>;
  notes: string | null;
  duplicateKey: string | null;
  duplicateCount: number;
  duplicateEmailIds: string[];
  duplicateReasons: string[];
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

interface AttachmentQuality {
  totalAttachments: number;
  analyzedCount: number;
  correctedCount: number;
  failedCount: number;
  manualReviewCount: number;
  qualityScore: number;
  correctionSummary?: {
    total: number;
    categoryCorrectionCount: number;
    fieldCorrectionCount: number;
    summaryCorrectionCount: number;
    categoryStability: number;
    fieldStability: number;
  };
  topIssues?: Array<{
    attachmentId: string;
    emailId: string;
    filename: string;
    status: string;
    reason: string;
  }>;
}

const STATUS_FILTERS: Array<{ status: CandidateStatus; label: string }> = [
  { status: "ALL", label: "All" },
  { status: "NEEDS_ANALYSIS", label: "Needs analysis" },
  { status: "NEEDS_INFO", label: "Needs info" },
  { status: "READY_TO_REVIEW", label: "Ready" },
  { status: "REVIEWING", label: "Reviewing" },
  { status: "CONTACTED", label: "Contacted" },
  { status: "SHORTLISTED", label: "Shortlisted" },
  { status: "REJECTED", label: "Rejected" },
  { status: "ARCHIVED", label: "Archived" },
];

const ATTENTION_FILTERS: Array<{ value: AttentionFilter; label: string }> = [
  { value: "all", label: "All materials" },
  { value: "manual_review", label: "Source check" },
  { value: "duplicates", label: "Possible duplicates" },
  { value: "incomplete", label: "Missing info" },
];

export default function CandidateIntakePage() {
  return (
    <AuthGuard>
      <CandidateIntakeView />
    </AuthGuard>
  );
}

function CandidateIntakeView() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<CandidateStatus>("ALL");
  const [attention, setAttention] = useState<AttentionFilter>("all");
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Used by the "Rescan" button to force a refetch with refresh=true.
  const [forceRefresh, setForceRefresh] = useState(false);

  const candidatesQuery = useQuery({
    queryKey: queryKeys.email.candidates({
      status: status === "ALL" ? undefined : status,
      attention: attention === "all" ? undefined : attention,
    }),
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "80" });
      if (status !== "ALL") params.set("status", status);
      if (attention !== "all") params.set("attention", attention);
      if (forceRefresh) params.set("refresh", "true");
      try {
        const data = await apiFetch<{ candidates: CandidateIntake[] }>(
          `/api/email/candidates?${params.toString()}`,
        );
        return data.candidates;
      } catch (err) {
        captureClientError(err, {
          scope: "email.candidates.load",
          status,
          attention,
        });
        throw err;
      } finally {
        if (forceRefresh) setForceRefresh(false);
      }
    },
  });

  const qualityQuery = useQuery({
    queryKey: ["email", "candidates", "quality"] as const,
    queryFn: async () => {
      try {
        return await apiFetch<AttachmentQuality>("/api/email/attachments/quality?limit=500");
      } catch (err) {
        captureClientError(err, { scope: "email.candidates.quality" });
        throw err;
      }
    },
  });

  const candidates = candidatesQuery.data ?? [];
  const quality = qualityQuery.data ?? null;
  const loading = candidatesQuery.isLoading;
  const refreshing = candidatesQuery.isFetching && !candidatesQuery.isLoading;
  // Keep selection in sync when the filter changes (the keyed query
  // already refetches on its own).
  if (candidatesQuery.error && !error) {
    setError("Could not load the candidate queue.");
  }
  const setCandidates = (updater: (prev: CandidateIntake[]) => CandidateIntake[]) => {
    queryClient.setQueryData<CandidateIntake[]>(
      queryKeys.email.candidates({
        status: status === "ALL" ? undefined : status,
        attention: attention === "all" ? undefined : attention,
      }),
      (prev) => updater(prev ?? []),
    );
  };

  const load = (nextStatus: CandidateStatus, nextAttention: AttentionFilter, refresh = false) => {
    if (refresh) setForceRefresh(true);
    setSelectedIds(new Set());
    // Filter changes auto-refetch via key change; explicit refresh
    // invalidates current.
    if (refresh || nextStatus !== status || nextAttention !== attention) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.email.candidates({
          status: nextStatus === "ALL" ? undefined : nextStatus,
          attention: nextAttention === "all" ? undefined : nextAttention,
        }),
      });
    }
  };

  const selectedCount = selectedIds.size;

  const toggleCandidate = (emailId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(emailId)) next.delete(emailId);
      else next.add(emailId);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds((current) => {
      const visible = candidates.map((candidate) => candidate.emailId);
      if (visible.length > 0 && visible.every((emailId) => current.has(emailId))) return new Set();
      return new Set(visible);
    });
  };

  const bulkUpdateStatus = async (nextStatus: Exclude<CandidateStatus, "ALL">) => {
    if (selectedCount === 0 || bulkUpdating) return;
    setBulkUpdating(true);
    setError(null);
    const emailIds = Array.from(selectedIds);
    try {
      const data = await apiFetch<{
        updated: Array<{ emailId: string; status: Exclude<CandidateStatus, "ALL"> }>;
      }>("/api/email/candidates/bulk-status", {
        method: "POST",
        body: JSON.stringify({ emailIds, status: nextStatus }),
      });
      const updates = new Map(data.updated.map((item) => [item.emailId, item.status]));
      setCandidates((current) =>
        current
          .map((candidate) => {
            const updatedStatus = updates.get(candidate.emailId);
            return updatedStatus ? { ...candidate, status: updatedStatus } : candidate;
          })
          .filter((candidate) => status === "ALL" || candidate.status === status),
      );
      setSelectedIds(new Set());
    } catch (err) {
      captureClientError(err, { scope: "email.candidates.bulk-status", status: nextStatus });
      setError("Could not update the selected candidate status.");
    } finally {
      setBulkUpdating(false);
    }
  };

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (status !== "ALL") params.set("status", status);
      if (attention !== "all") params.set("attention", attention);
      const res = await fetch(`${API_BASE}/api/email/candidates/export.csv?${params.toString()}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`CSV export failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `klorn-candidate-intake-${status.toLowerCase()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      captureClientError(err, { scope: "email.candidates.export", status, attention });
      setError("Could not create the candidate CSV.");
    } finally {
      setExporting(false);
    }
  };

  // Filter changes refetch automatically via the keyed useQuery —
  // no manual load() call needed on mount.

  const readyCount = candidates.filter((c) => c.status === "READY_TO_REVIEW").length;
  const needsCount = candidates.filter((c) =>
    ["NEEDS_ANALYSIS", "NEEDS_INFO"].includes(c.status),
  ).length;
  const duplicateCount = candidates.filter((c) => c.duplicateCount > 1).length;
  const manualReviewCount = candidates.filter((c) =>
    c.evidenceFiles.some((file) => file.needsManualReview),
  ).length;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 md:py-10">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-slate-900">
            Candidates
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Resumes, portfolios, and audition materials from email attachments, grouped by review
            state
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => load(status, attention, true)}
            disabled={refreshing}
            className="glow-primary ease-strong inline-flex h-9 items-center rounded-lg bg-gradient-to-b from-sky-400 to-sky-500 px-3.5 text-sm font-medium text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Rescan"}
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting}
            className="ease-strong inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white/70 px-3 text-xs font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97] disabled:opacity-50"
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
          <Link
            href="/email"
            className="ease-strong inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white/70 px-3 text-xs font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
          >
            Email list
          </Link>
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <QueueStat label="Needs info" value={needsCount} />
        <QueueStat label="Ready" value={readyCount} />
        <QueueStat label="Duplicates" value={duplicateCount} />
        <QueueStat label="Source checks" value={manualReviewCount} />
        {quality && (
          <>
            <QueueStat label="AI quality" value={`${Math.round(quality.qualityScore * 100)}%`} />
            <QueueStat label="Analyzed" value={quality.analyzedCount} />
            <QueueStat label="Corrected" value={quality.correctedCount} />
            <QueueStat label="Failed" value={quality.failedCount + quality.manualReviewCount} />
          </>
        )}
      </div>

      {quality?.correctionSummary && quality.correctionSummary.total > 0 && (
        <div className="mb-3 rounded-xl border border-sky-200/70 bg-gradient-to-r from-sky-50 to-white px-3 py-2 text-[11px] text-sky-800">
          Recent corrections {quality.correctionSummary.total} · categories{" "}
          {quality.correctionSummary.categoryCorrectionCount} · fields{" "}
          {quality.correctionSummary.fieldCorrectionCount} · summaries{" "}
          {quality.correctionSummary.summaryCorrectionCount} · stability{" "}
          {Math.round(quality.correctionSummary.categoryStability * 100)}%/
          {Math.round(quality.correctionSummary.fieldStability * 100)}%
        </div>
      )}
      {quality?.topIssues && quality.topIssues.length > 0 && (
        <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-rose-600">
            Quality issues
          </p>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {quality.topIssues.slice(0, 4).map((issue) => (
              <Link
                key={issue.attachmentId}
                href={`/email/${issue.emailId}`}
                className="ease-strong truncate rounded-lg border border-rose-200/70 bg-white px-2 py-1.5 text-[11px] text-rose-700 transition duration-150 hover:border-rose-300 hover:text-rose-800"
              >
                {issue.filename} · {issue.reason}
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 scrollbar-hide">
        <span className="mr-0.5 shrink-0 text-[11px] font-medium uppercase tracking-wider text-slate-400">
          Status
        </span>
        {STATUS_FILTERS.map((filter) => {
          const active = filter.status === status;
          return (
            <button
              key={filter.status}
              type="button"
              onClick={() => setStatus(filter.status)}
              className={`ease-strong inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition duration-150 active:scale-[0.97] ${
                active
                  ? "bg-accent/10 text-sky-700 ring-1 ring-inset ring-accent/30"
                  : "text-slate-500 hover:bg-white/80 hover:text-slate-900 hover:shadow-sm"
              }`}
            >
              {active && (
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-sky-500" />
              )}
              {filter.label}
            </button>
          );
        })}
      </div>

      <div className="-mx-4 mt-1 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 scrollbar-hide">
        <span className="mr-0.5 shrink-0 text-[11px] font-medium uppercase tracking-wider text-slate-400">
          Focus
        </span>
        {ATTENTION_FILTERS.map((filter) => {
          const active = filter.value === attention;
          return (
            <button
              key={filter.value}
              type="button"
              onClick={() => setAttention(filter.value)}
              className={`ease-strong inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition duration-150 active:scale-[0.97] ${
                active
                  ? "bg-accent/10 text-sky-700 ring-1 ring-inset ring-accent/30"
                  : "text-slate-500 hover:bg-white/80 hover:text-slate-900 hover:shadow-sm"
              }`}
            >
              {active && (
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-sky-500" />
              )}
              {filter.label}
            </button>
          );
        })}
      </div>

      {!loading && candidates.length > 0 && (
        <div className="panel-elevated mt-3 flex flex-col gap-2 rounded-xl border border-slate-200/70 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleAllVisible}
              className="ease-strong rounded-lg border border-slate-200 bg-white/70 px-3 py-1.5 text-xs font-medium text-slate-500 transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
            >
              {selectedCount > 0 ? `${selectedCount} selected` : "Select visible"}
            </button>
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="ease-strong rounded-lg px-3 py-1.5 text-xs text-slate-400 transition duration-150 hover:bg-slate-100 hover:text-slate-900 active:scale-[0.97]"
              >
                Clear
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <BulkStatusButton
              label="Reviewing"
              disabled={selectedCount === 0 || bulkUpdating}
              onClick={() => bulkUpdateStatus("REVIEWING")}
            />
            <BulkStatusButton
              label="Shortlist"
              disabled={selectedCount === 0 || bulkUpdating}
              onClick={() => bulkUpdateStatus("SHORTLISTED")}
            />
            <BulkStatusButton
              label="Contacted"
              disabled={selectedCount === 0 || bulkUpdating}
              onClick={() => bulkUpdateStatus("CONTACTED")}
            />
            <BulkStatusButton
              label="Archive"
              disabled={selectedCount === 0 || bulkUpdating}
              onClick={() => bulkUpdateStatus("ARCHIVED")}
            />
          </div>
        </div>
      )}

      {loading && <p className="px-1 py-3 text-sm text-slate-400">Loading...</p>}

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && candidates.length === 0 && (
        <div className="panel-elevated mt-4 rounded-2xl border border-slate-200/70 bg-white p-6 text-center">
          <p className="text-sm text-slate-500">No candidate materials yet.</p>
          <p className="mt-1 text-xs text-slate-400">
            After Gmail sync and attachment analysis, candidate signals appear here automatically.
          </p>
        </div>
      )}

      {!loading && candidates.length > 0 && (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {candidates.map((candidate) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              selected={selectedIds.has(candidate.emailId)}
              onToggle={() => toggleCandidate(candidate.emailId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Quiet stat chip — flat on the canvas so the candidate grid stays the hero.
function QueueStat({ label, value }: { label: string; value: number | string }) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-slate-200 bg-white/70 px-3 text-[11px] font-medium text-slate-500">
      {label}
      <span className="font-semibold tabular-nums text-slate-900">{value}</span>
    </span>
  );
}

function BulkStatusButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="ease-strong rounded-lg border border-slate-200 bg-white/70 px-3 py-1.5 text-xs font-medium text-slate-500 transition duration-150 hover:bg-sky-50 hover:text-sky-700 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function CandidateCard({
  candidate,
  selected,
  onToggle,
}: {
  candidate: CandidateIntake;
  selected: boolean;
  onToggle: () => void;
}) {
  const title = [candidate.name || "Unknown name", candidate.role].filter(Boolean).join(" · ");
  const displayName = candidate.name || senderName(candidate.email.from);
  return (
    <article
      className={`panel-elevated relative overflow-hidden rounded-2xl border bg-white p-4 transition duration-150 ease-out ${
        selected
          ? "border-sky-300 ring-2 ring-accent/20"
          : "border-slate-200/70 hover:border-sky-200"
      }`}
    >
      {selected && (
        <span aria-hidden="true" className="absolute left-0 top-0 h-full w-[3px] bg-sky-400" />
      )}
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="mt-1 h-4 w-4 rounded border-slate-300 bg-white text-accent"
          aria-label={`Select ${title}`}
        />
        <span
          aria-hidden="true"
          className={`avatar-ring mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[13px] font-semibold text-white ${avatarGradient(displayName)}`}
        >
          {senderInitials(displayName)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="shrink-0 rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-sky-700 ring-1 ring-inset ring-sky-500/20">
              {candidateStatusLabel(candidate.status)}
            </span>
            <span className="text-[10px] tabular-nums text-slate-400">
              {Math.round(candidate.confidence * 100)}%
            </span>
            {candidate.duplicateCount > 1 && (
              <span className="shrink-0 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-inset ring-amber-500/20">
                Duplicate {candidate.duplicateCount}
              </span>
            )}
          </div>
          <h2 className="mt-1.5 truncate text-sm font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{candidate.summary}</p>
        </div>
        <time className="shrink-0 text-[11px] tabular-nums text-slate-400">
          {formatRelative(candidate.email.receivedAt)}
        </time>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
        {candidate.contact && <span className="truncate">Contact {candidate.contact}</span>}
        <span>{candidate.evidenceFiles.length} files</span>
        {candidate.evidenceFiles.some((file) => file.needsManualReview) && (
          <span className="text-rose-600">
            Source check {candidate.evidenceFiles.filter((file) => file.needsManualReview).length}
          </span>
        )}
        {candidate.duplicateCount > 1 && (
          <span className="text-amber-600">
            Duplicate match {candidate.duplicateReasons.map(candidateDuplicateLabel).join(", ")}
          </span>
        )}
        {candidate.missingFields.length > 0 && (
          <span className="text-sky-600">
            Missing {candidate.missingFields.map(candidateMissingLabel).join(", ")}
          </span>
        )}
      </div>
      <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2">
        <p className="truncate text-xs text-slate-600">{candidate.email.subject || "Untitled"}</p>
        <p className="mt-1 truncate text-[11px] text-slate-400">
          {senderName(candidate.email.from)}
        </p>
      </div>
      {candidate.notes && (
        <p className="mt-2 line-clamp-2 text-[11px] leading-5 text-slate-400">
          Notes: {candidate.notes}
        </p>
      )}
      <Link
        href={`/email/candidates/${candidate.emailId}`}
        className="ease-strong mt-3 inline-flex h-8 items-center rounded-lg border border-slate-200 bg-white/70 px-3 text-xs font-medium text-slate-500 transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
      >
        Candidate details
      </Link>
      <Link
        href={`/email/${candidate.emailId}`}
        className="ease-strong ml-2 mt-3 inline-flex h-8 items-center rounded-lg border border-slate-200 bg-white/70 px-3 text-xs font-medium text-slate-400 transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
      >
        Email
      </Link>
    </article>
  );
}

// Monogram avatar helpers — local copy of the email page pattern (recognition
// over decoration; deterministic gradient per person).
const AVATAR_GRADIENTS = [
  "from-sky-400 to-blue-500",
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

function candidateStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    NEEDS_ANALYSIS: "Needs analysis",
    NEEDS_INFO: "Needs info",
    READY_TO_REVIEW: "Ready",
    REVIEWING: "Reviewing",
    CONTACTED: "Contacted",
    SHORTLISTED: "Shortlisted",
    REJECTED: "Rejected",
    ARCHIVED: "Archived",
  };
  return labels[status] || status;
}

function candidateMissingLabel(field: string): string {
  const labels: Record<string, string> = {
    name: "Name",
    contact: "Contact",
    role: "Role",
    portfolio: "Portfolio",
  };
  return labels[field] || field;
}

function candidateDuplicateLabel(reason: string): string {
  const labels: Record<string, string> = {
    same_email: "Email",
    same_phone: "Phone",
    same_name_and_role: "Name + role",
    same_name: "Name",
  };
  return labels[reason] || reason;
}

function senderName(raw: string): string {
  const match = raw.match(/^([^<]+?)\s*</);
  if (match?.[1]) return match[1].trim();
  return raw.replace(/[<>]/g, "").trim();
}
