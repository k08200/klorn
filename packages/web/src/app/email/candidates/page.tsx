"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { API_BASE, apiFetch, authHeaders } from "../../../lib/api";
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
  const [status, setStatus] = useState<CandidateStatus>("ALL");
  const [attention, setAttention] = useState<AttentionFilter>("all");
  const [candidates, setCandidates] = useState<CandidateIntake[]>([]);
  const [quality, setQuality] = useState<AttachmentQuality | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextStatus: CandidateStatus, nextAttention: AttentionFilter, refresh = false) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: "80" });
        if (nextStatus !== "ALL") params.set("status", nextStatus);
        if (nextAttention !== "all") params.set("attention", nextAttention);
        if (refresh) params.set("refresh", "true");
        const data = await apiFetch<{ candidates: CandidateIntake[] }>(
          `/api/email/candidates?${params.toString()}`,
        );
        setCandidates(data.candidates);
        apiFetch<AttachmentQuality>("/api/email/attachments/quality?limit=500")
          .then(setQuality)
          .catch((err) => captureClientError(err, { scope: "email.candidates.quality" }));
        setSelectedIds(new Set());
      } catch (err) {
        captureClientError(err, {
          scope: "email.candidates.load",
          status: nextStatus,
          attention: nextAttention,
        });
        setError("Could not load the candidate queue.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [],
  );

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
      a.download = `jigeum-candidate-intake-${status.toLowerCase()}.csv`;
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

  useEffect(() => {
    load(status, attention);
  }, [attention, load, status]);

  const readyCount = candidates.filter((c) => c.status === "READY_TO_REVIEW").length;
  const needsCount = candidates.filter((c) =>
    ["NEEDS_ANALYSIS", "NEEDS_INFO"].includes(c.status),
  ).length;
  const contactedCount = candidates.filter((c) => c.status === "CONTACTED").length;
  const duplicateCount = candidates.filter((c) => c.duplicateCount > 1).length;
  const manualReviewCount = candidates.filter((c) =>
    c.evidenceFiles.some((file) => file.needsManualReview),
  ).length;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 md:py-10">
      <header className="mb-5 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5 shadow-2xl shadow-black/10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#FF8A70]/80">
              Candidate Intake
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-stone-50">
              Candidate intake queue
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-500">
              Resumes, profiles, portfolios, and audition materials found in email attachments are
              grouped by review state.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              href="/email"
              className="rounded-lg border border-stone-700/60 px-3 py-1.5 text-xs text-stone-300 transition hover:border-orange-500/40 hover:bg-orange-500/10 hover:text-[#FFE2D7]"
            >
              Email list
            </Link>
            <button
              type="button"
              onClick={() => load(status, attention, true)}
              disabled={refreshing}
              className="rounded-lg border border-[#FF6B4A]/30 px-3 py-1.5 text-xs text-[#FFB09C] transition hover:bg-[#FF6B4A]/10 disabled:opacity-50"
            >
              {refreshing ? "Refreshing..." : "Rescan candidates"}
            </button>
            <button
              type="button"
              onClick={exportCsv}
              disabled={exporting}
              className="rounded-lg border border-[#7DD3FC]/30 px-3 py-1.5 text-xs text-sky-200 transition hover:bg-[#7DD3FC]/10 disabled:opacity-50"
            >
              {exporting ? "Exporting..." : "Export CSV"}
            </button>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <QueueStat label="Needs info" value={needsCount} />
          <QueueStat label="Ready" value={readyCount} />
          <QueueStat label="Duplicates" value={duplicateCount} />
          <QueueStat label="Source checks" value={manualReviewCount} />
        </div>
        {quality && (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <QueueStat label="AI quality" value={`${Math.round(quality.qualityScore * 100)}%`} />
            <QueueStat label="Analyzed" value={quality.analyzedCount} />
            <QueueStat label="Corrected" value={quality.correctedCount} />
            <QueueStat label="Failed" value={quality.failedCount + quality.manualReviewCount} />
          </div>
        )}
        {quality?.correctionSummary && quality.correctionSummary.total > 0 && (
          <div className="mt-3 rounded-xl border border-[#FF6B4A]/15 bg-[#FF6B4A]/5 px-3 py-2 text-[11px] text-[#FFE2D7]/80">
            Recent corrections {quality.correctionSummary.total} · categories{" "}
            {quality.correctionSummary.categoryCorrectionCount} · fields{" "}
            {quality.correctionSummary.fieldCorrectionCount} · summaries{" "}
            {quality.correctionSummary.summaryCorrectionCount} · stability{" "}
            {Math.round(quality.correctionSummary.categoryStability * 100)}%/
            {Math.round(quality.correctionSummary.fieldStability * 100)}%
          </div>
        )}
        {quality?.topIssues && quality.topIssues.length > 0 && (
          <div className="mt-3 rounded-xl border border-rose-400/15 bg-rose-400/5 px-3 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-rose-200/80">
              Quality issues
            </p>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {quality.topIssues.slice(0, 4).map((issue) => (
                <Link
                  key={issue.attachmentId}
                  href={`/email/${issue.emailId}`}
                  className="truncate rounded border border-rose-400/10 bg-black/10 px-2 py-1.5 text-[11px] text-rose-100/75 transition hover:border-rose-300/30 hover:text-rose-100"
                >
                  {issue.filename} · {issue.reason}
                </Link>
              ))}
            </div>
          </div>
        )}
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
                  ? "bg-[#FF8A70] text-stone-950"
                  : "border border-stone-700/55 bg-stone-950/45 text-stone-400 hover:bg-stone-900/70 hover:text-stone-200"
              }`}
            >
              {filter.label}
            </button>
          );
        })}
      </div>

      <div className="-mx-4 mt-2 flex gap-2 overflow-x-auto px-4 pb-2 scrollbar-hide">
        {ATTENTION_FILTERS.map((filter) => {
          const active = filter.value === attention;
          return (
            <button
              key={filter.value}
              type="button"
              onClick={() => setAttention(filter.value)}
              className={`min-h-[32px] shrink-0 rounded-full px-3 py-1.5 text-xs transition ${
                active
                  ? "bg-[#7DD3FC] text-stone-950"
                  : "border border-stone-700/55 bg-stone-950/45 text-stone-400 hover:bg-stone-900/70 hover:text-stone-200"
              }`}
            >
              {filter.label}
            </button>
          );
        })}
      </div>

      {!loading && candidates.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 rounded-xl border border-stone-700/45 bg-stone-950/35 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleAllVisible}
              className="rounded-lg border border-stone-700/60 px-3 py-1.5 text-xs text-stone-300 transition hover:border-[#FF6B4A]/35 hover:bg-[#FF6B4A]/10 hover:text-[#FFE2D7]"
            >
              {selectedCount > 0 ? `${selectedCount} selected` : "Select visible"}
            </button>
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="rounded-lg px-3 py-1.5 text-xs text-stone-500 transition hover:bg-stone-800/70 hover:text-stone-200"
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

      {loading && <p className="px-1 py-3 text-sm text-stone-500">Loading...</p>}

      {error && (
        <div className="mt-3 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && candidates.length === 0 && (
        <div className="mt-4 rounded-xl border border-stone-700/45 bg-stone-950/35 p-6 text-center">
          <p className="text-sm text-stone-300">No candidate materials yet.</p>
          <p className="mt-1 text-xs text-stone-600">
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

function QueueStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-stone-700/45 bg-black/15 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold text-stone-100">{value}</p>
    </div>
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
      className="rounded-lg border border-stone-700/60 px-3 py-1.5 text-xs text-stone-300 transition hover:border-[#FF6B4A]/35 hover:bg-[#FF6B4A]/10 hover:text-[#FFE2D7] disabled:cursor-not-allowed disabled:opacity-40"
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
  return (
    <article
      className={`rounded-xl border p-4 transition ${
        selected
          ? "border-[#FF8A70]/60 bg-[#FF6B4A]/10"
          : "border-orange-500/20 bg-orange-500/5 hover:border-[#FF6B4A]/35 hover:bg-[#FF6B4A]/10"
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="mt-1 h-4 w-4 rounded border-stone-600 bg-stone-950 text-[#FF8A70]"
          aria-label={`Select ${title}`}
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-[#FF6B4A]/25 bg-[#FF6B4A]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#FFB09C]">
              {candidateStatusLabel(candidate.status)}
            </span>
            <span className="text-[10px] tabular-nums text-[#FF8A70]/75">
              {Math.round(candidate.confidence * 100)}%
            </span>
            {candidate.duplicateCount > 1 && (
              <span className="rounded border border-[#FF6B4A]/25 bg-[#FF6B4A]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#FFB09C]">
                Possible duplicate {candidate.duplicateCount}
              </span>
            )}
          </div>
          <h2 className="mt-2 truncate text-sm font-semibold text-stone-100">{title}</h2>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-stone-400">{candidate.summary}</p>
        </div>
        <time className="shrink-0 text-[11px] tabular-nums text-stone-500">
          {formatRelative(candidate.email.receivedAt)}
        </time>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-stone-500">
        {candidate.contact && <span className="truncate">Contact {candidate.contact}</span>}
        <span>{candidate.evidenceFiles.length} files</span>
        {candidate.evidenceFiles.some((file) => file.needsManualReview) && (
          <span className="text-rose-300/80">
            Source check {candidate.evidenceFiles.filter((file) => file.needsManualReview).length}
          </span>
        )}
        {candidate.duplicateCount > 1 && (
          <span className="text-[#FF6B4A]/80">
            Duplicate match {candidate.duplicateReasons.map(candidateDuplicateLabel).join(", ")}
          </span>
        )}
        {candidate.missingFields.length > 0 && (
          <span className="text-[#FF6B4A]/80">
            Missing {candidate.missingFields.map(candidateMissingLabel).join(", ")}
          </span>
        )}
      </div>
      <div className="mt-3 rounded-lg border border-stone-800/60 bg-black/15 px-3 py-2">
        <p className="truncate text-xs text-stone-300">{candidate.email.subject || "Untitled"}</p>
        <p className="mt-1 truncate text-[11px] text-stone-600">
          {senderName(candidate.email.from)}
        </p>
      </div>
      {candidate.notes && (
        <p className="mt-2 line-clamp-2 text-[11px] leading-5 text-stone-500">
          Notes: {candidate.notes}
        </p>
      )}
      <Link
        href={`/email/candidates/${candidate.emailId}`}
        className="mt-3 inline-flex rounded-lg border border-stone-700/55 px-3 py-1.5 text-xs text-stone-300 transition hover:border-[#FF6B4A]/35 hover:bg-[#FF6B4A]/10 hover:text-[#FFE2D7]"
      >
        Candidate details
      </Link>
      <Link
        href={`/email/${candidate.emailId}`}
        className="ml-2 mt-3 inline-flex rounded-lg border border-stone-700/55 px-3 py-1.5 text-xs text-stone-500 transition hover:border-[#FF6B4A]/35 hover:bg-[#FF6B4A]/10 hover:text-[#FFE2D7]"
      >
        Email
      </Link>
    </article>
  );
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

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "2-digit" }),
  });
}
