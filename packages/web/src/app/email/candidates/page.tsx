"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { ListSkeleton } from "../../../components/skeleton";
import ErrorAlert from "../../../components/ui/error-alert";
import { API_BASE, apiFetch, authHeaders } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { byokLocked } from "../../../lib/entitlement";
import { useT } from "../../../lib/i18n";
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

/** `t` is passed in rather than called via useT() here — these are plain
 * builders, not components, so they cannot use hooks themselves. */
function buildStatusFilters(t: (key: string) => string): Array<{
  status: CandidateStatus;
  label: string;
}> {
  return [
    { status: "ALL", label: t("candidates.status.all") },
    { status: "NEEDS_ANALYSIS", label: t("candidates.status.needsAnalysis") },
    { status: "NEEDS_INFO", label: t("candidates.status.needsInfo") },
    { status: "READY_TO_REVIEW", label: t("candidates.status.ready") },
    { status: "REVIEWING", label: t("candidates.status.reviewing") },
    { status: "CONTACTED", label: t("candidates.status.contacted") },
    { status: "SHORTLISTED", label: t("candidates.status.shortlisted") },
    { status: "REJECTED", label: t("candidates.status.rejected") },
    { status: "ARCHIVED", label: t("candidates.status.archived") },
  ];
}

function buildAttentionFilters(t: (key: string) => string): Array<{
  value: AttentionFilter;
  label: string;
}> {
  return [
    { value: "all", label: t("candidates.attention.all") },
    { value: "manual_review", label: t("candidates.attention.sourceCheck") },
    { value: "duplicates", label: t("candidates.attention.duplicates") },
    { value: "incomplete", label: t("candidates.attention.incomplete") },
  ];
}

export default function CandidateIntakePage() {
  return (
    <AuthGuard>
      <CandidateIntakeView />
    </AuthGuard>
  );
}

function CandidateIntakeView() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const STATUS_FILTERS = buildStatusFilters(t);
  const ATTENTION_FILTERS = buildAttentionFilters(t);
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
    setError(t("candidates.error.load"));
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
      setError(t("candidates.error.bulkUpdate"));
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
      setError(t("candidates.error.export"));
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
          <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink">
            {t("mail.filterCandidates")}
          </h1>
          <p className="mt-2 text-sm text-ink-mid">{t("candidates.subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => load(status, attention, true)}
            disabled={refreshing}
            className="glow-primary ease-strong inline-flex h-9 items-center rounded-lg bg-accent-solid px-3.5 text-sm font-medium text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
          >
            {refreshing ? t("candidates.refreshing") : t("candidates.rescan")}
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting}
            className="ease-strong inline-flex h-9 items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-xs font-medium text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-50 focus-ring"
          >
            {exporting ? t("candidates.exporting") : t("candidates.exportCsv")}
          </button>
          <Link
            href="/email"
            className="ease-strong inline-flex h-9 items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-xs font-medium text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] focus-ring"
          >
            {t("candidates.emailListLink")}
          </Link>
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <QueueStat label={t("candidates.status.needsInfo")} value={needsCount} />
        <QueueStat label={t("candidates.status.ready")} value={readyCount} />
        <QueueStat label={t("candidates.stat.duplicates")} value={duplicateCount} />
        <QueueStat label={t("candidates.stat.sourceChecks")} value={manualReviewCount} />
        {quality && (
          <>
            <QueueStat
              label={t("candidates.stat.aiQuality")}
              value={`${Math.round(quality.qualityScore * 100)}%`}
            />
            <QueueStat label={t("candidates.stat.analyzed")} value={quality.analyzedCount} />
            <QueueStat label={t("candidates.stat.corrected")} value={quality.correctedCount} />
            <QueueStat
              label={t("candidates.stat.failed")}
              value={quality.failedCount + quality.manualReviewCount}
            />
          </>
        )}
      </div>

      {quality?.correctionSummary && quality.correctionSummary.total > 0 && (
        <div className="mb-3 rounded-xl border border-state-info-line bg-state-info-bg px-3 py-2 text-caption text-state-info-ink">
          {t("candidates.correctionSummary", {
            total: String(quality.correctionSummary.total),
            categories: String(quality.correctionSummary.categoryCorrectionCount),
            fields: String(quality.correctionSummary.fieldCorrectionCount),
            summaries: String(quality.correctionSummary.summaryCorrectionCount),
            categoryStability: String(
              Math.round(quality.correctionSummary.categoryStability * 100),
            ),
            fieldStability: String(Math.round(quality.correctionSummary.fieldStability * 100)),
          })}
        </div>
      )}
      {quality?.topIssues && quality.topIssues.length > 0 && (
        <QualityIssuesStrip issues={quality.topIssues} />
      )}

      <div className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 scrollbar-hide">
        <span className="mr-0.5 shrink-0 text-caption font-medium uppercase tracking-wider text-ink-dim">
          {t("candidates.filterStatusLabel")}
        </span>
        {STATUS_FILTERS.map((filter) => {
          const active = filter.status === status;
          return (
            <button
              key={filter.status}
              type="button"
              onClick={() => setStatus(filter.status)}
              className={`ease-strong inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition duration-150 active:scale-[0.97] focus-ring ${
                active
                  ? "bg-accent/10 text-accent-deeper ring-1 ring-inset ring-accent/30"
                  : "text-ink-mid hover:bg-surface-panel/80 hover:text-ink hover:shadow-sm"
              }`}
            >
              {active && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />}
              {filter.label}
            </button>
          );
        })}
      </div>

      <div className="-mx-4 mt-1 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 scrollbar-hide">
        <span className="mr-0.5 shrink-0 text-caption font-medium uppercase tracking-wider text-ink-dim">
          {t("candidates.filterFocusLabel")}
        </span>
        {ATTENTION_FILTERS.map((filter) => {
          const active = filter.value === attention;
          return (
            <button
              key={filter.value}
              type="button"
              onClick={() => setAttention(filter.value)}
              className={`ease-strong inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition duration-150 active:scale-[0.97] focus-ring ${
                active
                  ? "bg-accent/10 text-accent-deeper ring-1 ring-inset ring-accent/30"
                  : "text-ink-mid hover:bg-surface-panel/80 hover:text-ink hover:shadow-sm"
              }`}
            >
              {active && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />}
              {filter.label}
            </button>
          );
        })}
      </div>

      {!loading && candidates.length > 0 && (
        <div className="panel-elevated mt-3 flex flex-col gap-2 rounded-xl border border-line/70 bg-surface-panel p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleAllVisible}
              className="ease-strong rounded-lg border border-line bg-surface-panel/70 px-3 py-1.5 text-xs font-medium text-ink-mid transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] focus-ring"
            >
              {selectedCount > 0
                ? t("candidates.bulk.selectedCount", { count: String(selectedCount) })
                : t("candidates.bulk.selectVisible")}
            </button>
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="ease-strong rounded-lg px-3 py-1.5 text-xs text-ink-dim transition duration-150 hover:bg-surface-hover hover:text-ink active:scale-[0.97] focus-ring"
              >
                {t("candidates.bulk.clear")}
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <BulkStatusButton
              label={t("candidates.status.reviewing")}
              disabled={selectedCount === 0 || bulkUpdating}
              onClick={() => bulkUpdateStatus("REVIEWING")}
            />
            <BulkStatusButton
              label={t("candidates.bulk.shortlist")}
              disabled={selectedCount === 0 || bulkUpdating}
              onClick={() => bulkUpdateStatus("SHORTLISTED")}
            />
            <BulkStatusButton
              label={t("candidates.status.contacted")}
              disabled={selectedCount === 0 || bulkUpdating}
              onClick={() => bulkUpdateStatus("CONTACTED")}
            />
            <BulkStatusButton
              label={t("candidates.bulk.archive")}
              disabled={selectedCount === 0 || bulkUpdating}
              onClick={() => bulkUpdateStatus("ARCHIVED")}
            />
          </div>
        </div>
      )}

      {loading && (
        <div className="mt-3">
          <ListSkeleton />
        </div>
      )}

      {error && <ErrorAlert className="mt-3">{error}</ErrorAlert>}

      {!loading && !error && candidates.length === 0 && (
        <div className="panel-elevated mt-4 rounded-2xl border border-line/70 bg-surface-panel p-6 text-center">
          <p className="text-sm text-ink-mid">{t("candidates.empty.title")}</p>
          <p className="mt-1 text-xs text-ink-dim">{t("candidates.empty.description")}</p>
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

// Collapsed one-line warning strip — the failure count is one calm sentence,
// and the noisy per-file list only appears on demand.
function QualityIssuesStrip({ issues }: { issues: NonNullable<AttachmentQuality["topIssues"]> }) {
  const { t } = useT();
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const count = issues.length;
  // "Add your own key" is a Pro remedy: a FREE user is told where it lives instead.
  const locked = byokLocked(user);
  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-state-warn-line bg-state-warn-bg">
      <div className="flex items-center gap-3 px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-xs text-amber-800">
          {t("candidates.qualityIssues.prefix")}
          <span className="font-semibold tabular-nums">{count}</span>{" "}
          {count === 1
            ? t(
                locked
                  ? "candidates.qualityIssues.oneFailedFree"
                  : "candidates.qualityIssues.oneFailed",
              )
            : t(
                locked
                  ? "candidates.qualityIssues.manyFailedFree"
                  : "candidates.qualityIssues.manyFailed",
              )}
        </p>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="ease-strong shrink-0 rounded-md px-2 py-1 text-caption font-medium text-state-warn-ink transition duration-150 hover:bg-amber-100 hover:text-amber-900 active:scale-[0.97] focus-ring"
        >
          {expanded ? t("candidates.qualityIssues.hide") : t("candidates.qualityIssues.details")}
        </button>
      </div>
      {expanded && (
        <ul className="divide-y divide-amber-200/50 border-t border-state-warn-line bg-surface-panel/60">
          {issues.slice(0, 4).map((issue) => (
            <li key={issue.attachmentId}>
              <Link
                href={`/email/${issue.emailId}`}
                className="ease-strong flex items-baseline gap-2 px-3 py-2 text-caption transition duration-150 hover:bg-state-warn-bg focus-ring"
              >
                <span className="truncate font-medium text-ink-soft">{issue.filename}</span>
                <span className="min-w-0 truncate text-ink-dim">{issue.reason}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Quiet stat chip — flat on the canvas so the candidate grid stays the hero.
// Zero-value chips fade back so the eye lands on the counts that matter.
function QueueStat({ label, value }: { label: string; value: number | string }) {
  const isZero = value === 0 || value === "0";
  return (
    <span
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface-panel/70 px-3 text-caption font-medium tabular-nums ${
        isZero ? "text-ink-dim opacity-60" : "text-ink-mid"
      }`}
    >
      {label}
      <span className={`font-semibold tabular-nums ${isZero ? "text-ink-dim" : "text-ink"}`}>
        {value}
      </span>
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
      className="ease-strong rounded-lg border border-line bg-surface-panel/70 px-3 py-1.5 text-xs font-medium text-ink-mid transition duration-150 hover:bg-state-info-bg hover:text-accent-deeper active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 focus-ring"
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
  const { t } = useT();
  const title = [candidate.name || t("candidates.card.unknownName"), candidate.role]
    .filter(Boolean)
    .join(" · ");
  const displayName = candidate.name || senderName(candidate.email.from);
  return (
    <article
      className={`panel-elevated relative overflow-hidden rounded-2xl border bg-surface-panel p-4 transition duration-150 ease-out ${
        selected
          ? "border-accent-muted ring-2 ring-accent/20"
          : "border-line/70 hover:border-state-info-line"
      }`}
    >
      {selected && (
        <span aria-hidden="true" className="absolute left-0 top-0 h-full w-[3px] bg-accent-light" />
      )}
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="mt-1 h-4 w-4 rounded border-line-strong bg-surface-panel text-accent-deep"
          aria-label={t("candidates.card.selectAria", { title })}
        />
        <span
          aria-hidden="true"
          className={`avatar-ring mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-label font-semibold text-white ${avatarGradient(displayName)}`}
        >
          {senderInitials(displayName)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="shrink-0 rounded-md bg-accent/10 px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide text-accent-deeper ring-1 ring-inset ring-accent/20">
              {candidateStatusLabel(t, candidate.status)}
            </span>
            <span className="text-caption tabular-nums text-ink-dim">
              {Math.round(candidate.confidence * 100)}%
            </span>
            {candidate.duplicateCount > 1 && (
              <span className="shrink-0 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide text-state-warn-ink ring-1 ring-inset ring-amber-500/20">
                {t("candidates.card.duplicateBadge", { count: String(candidate.duplicateCount) })}
              </span>
            )}
          </div>
          <h2 className="mt-1.5 truncate text-sm font-semibold text-ink">{title}</h2>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-ink-mid">{candidate.summary}</p>
        </div>
        <time className="shrink-0 text-caption tabular-nums text-ink-dim">
          {formatRelative(candidate.email.receivedAt)}
        </time>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-caption text-ink-dim">
        {candidate.contact && (
          <span className="truncate">
            {t("candidates.card.contactPrefix", { contact: candidate.contact })}
          </span>
        )}
        <span className="tabular-nums">
          {t("emailDetail.attachment.fileCount", { count: String(candidate.evidenceFiles.length) })}
        </span>
        {candidate.evidenceFiles.some((file) => file.needsManualReview) && (
          <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-caption font-medium tabular-nums text-state-warn-ink ring-1 ring-inset ring-amber-500/20">
            {t("candidates.card.sourceCheckCount", {
              count: String(
                candidate.evidenceFiles.filter((file) => file.needsManualReview).length,
              ),
            })}
          </span>
        )}
        {candidate.duplicateCount > 1 && (
          <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-caption font-medium text-ink-mid ring-1 ring-inset ring-line">
            {t("candidates.card.duplicateMatch", {
              reasons: candidate.duplicateReasons
                .map((reason) => candidateDuplicateLabel(t, reason))
                .join(", "),
            })}
          </span>
        )}
        {candidate.missingFields.length > 0 && (
          <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-caption font-medium tabular-nums text-ink-mid ring-1 ring-inset ring-line">
            {formatMissingBadge(t, candidate.missingFields)}
          </span>
        )}
      </div>
      <div className="mt-3 rounded-lg border border-line-soft bg-surface-raised/70 px-3 py-2">
        <p className="truncate text-xs text-ink-muted">
          {candidate.email.subject || t("common.untitled")}
        </p>
        <p className="mt-1 truncate text-caption text-ink-dim">
          {senderName(candidate.email.from)}
        </p>
      </div>
      {candidate.notes && (
        <p className="mt-2 line-clamp-2 text-caption leading-5 text-ink-dim">
          {t("candidates.card.notesPrefix", { notes: candidate.notes })}
        </p>
      )}
      <Link
        href={`/email/candidates/${candidate.emailId}`}
        className="ease-strong mt-3 inline-flex h-8 items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-xs font-medium text-ink-mid transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] focus-ring"
      >
        {t("candidates.card.detailsLink")}
      </Link>
      <Link
        href={`/email/${candidate.emailId}`}
        className="ease-strong ml-2 mt-3 inline-flex h-8 items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-xs font-medium text-ink-dim transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] focus-ring"
      >
        {t("nav.email")}
      </Link>
    </article>
  );
}

// Monogram avatar helpers — local copy of the email page pattern (recognition
// over decoration; deterministic gradient per person).
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

/** `t` is passed in rather than called via useT() here — these are plain
 * helpers, not components, so they cannot use hooks themselves. */
function candidateStatusLabel(t: (key: string) => string, status: string): string {
  const labels: Record<string, string> = {
    NEEDS_ANALYSIS: t("candidates.status.needsAnalysis"),
    NEEDS_INFO: t("candidates.status.needsInfo"),
    READY_TO_REVIEW: t("candidates.status.ready"),
    REVIEWING: t("candidates.status.reviewing"),
    CONTACTED: t("candidates.status.contacted"),
    SHORTLISTED: t("candidates.status.shortlisted"),
    REJECTED: t("candidates.status.rejected"),
    ARCHIVED: t("candidates.status.archived"),
  };
  return labels[status] || status;
}

// "Missing: Name +3" — lead with the first missing field, fold the rest into
// a count so the badge stays one quiet token instead of a red laundry list.
function formatMissingBadge(
  t: (key: string, vars?: Record<string, string>) => string,
  fields: string[],
): string {
  const first = candidateMissingLabel(t, fields[0]);
  const rest = fields.length - 1;
  return rest > 0
    ? t("candidates.card.missingWithRest", { first, rest: String(rest) })
    : t("candidates.card.missingOnly", { first });
}

function candidateMissingLabel(t: (key: string) => string, field: string): string {
  const labels: Record<string, string> = {
    name: t("emailDetail.candidateCard.fact.name"),
    contact: t("emailDetail.candidateCard.fact.contact"),
    role: t("emailDetail.candidateCard.fact.role"),
    portfolio: t("candidates.missingField.portfolio"),
  };
  return labels[field] || field;
}

function candidateDuplicateLabel(t: (key: string) => string, reason: string): string {
  const labels: Record<string, string> = {
    same_email: t("nav.email"),
    same_phone: t("candidates.duplicateReason.phone"),
    same_name_and_role: t("candidates.duplicateReason.nameAndRole"),
    same_name: t("emailDetail.candidateCard.fact.name"),
  };
  return labels[reason] || reason;
}

function senderName(raw: string): string {
  const match = raw.match(/^([^<]+?)\s*</);
  if (match?.[1]) return match[1].trim();
  return raw.replace(/[<>]/g, "").trim();
}
