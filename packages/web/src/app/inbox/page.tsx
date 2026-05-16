"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import BetaLearningCard from "../../components/beta-learning-card";
import { EveSignalField } from "../../components/brand-visuals";
import BriefingCard from "../../components/briefing-card";
import CommandCenterSummary from "../../components/command-center-summary";
import OperatingLoopCard from "../../components/operating-loop-card";
import PlaybookRecommendations from "../../components/playbook-recommendations";
import { useToast } from "../../components/toast";
import WorkGraphSummaryCard from "../../components/work-graph-summary";
import { apiFetch } from "../../lib/api";
import { captureClientError } from "../../lib/sentry";
import { formatRelative } from "../../lib/text";

interface PendingActionItem {
  id: string;
  conversationId: string;
  conversationTitle: string | null;
  status: "PENDING" | "REJECTED" | "EXECUTED" | "FAILED";
  toolName: string;
  toolArgs: string;
  preview?: string | null;
  /** Server-resolved human label (task title, contact name, …) — null when n/a */
  targetLabel: string | null;
  reasoning: string | null;
  result: string | null;
  createdAt: string;
}

interface CommitmentItem {
  id: string;
  title: string;
  description: string | null;
  status: "OPEN" | "DONE" | "DISMISSED" | "SNOOZED";
  kind: "DELIVERABLE" | "FOLLOW_UP" | "DECISION" | "MEETING" | "REVIEW";
  owner: "USER" | "COUNTERPARTY" | "TEAM" | "UNKNOWN";
  dueAt: string | null;
  dueText: string | null;
  sourceType: string;
  confidence: number;
  createdAt: string;
  trustBadge?: "reliable" | "mostly_reliable" | "unreliable" | "unknown" | null;
}

interface PathStep {
  step: string;
  action: "task" | "event" | "email" | "check";
  dueIso: string;
  estimatedMinutes: number;
  taskId?: string | null;
  eventId?: string | null;
}

interface CommitmentPathData {
  id: string;
  commitmentId: string;
  steps: PathStep[];
  builtAt: string;
  model: string | null;
}

type StatusFilter = "pending" | "all";

export default function InboxPage() {
  return (
    <AuthGuard>
      <InboxView />
    </AuthGuard>
  );
}

function InboxView() {
  const [actions, setActions] = useState<PendingActionItem[]>([]);
  const [commitments, setCommitments] = useState<CommitmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("pending");
  const [actionLoading, setActionLoading] = useState<
    Record<string, "approve" | "reject" | "snooze" | null>
  >({});
  const [commitmentLoading, setCommitmentLoading] = useState<
    Record<string, "done" | "dismiss" | null>
  >({});
  const { toast } = useToast();

  const load = useCallback(async (statusFilter: StatusFilter) => {
    setLoading(true);
    setError(null);
    const qs = statusFilter === "all" ? "?status=all" : "";
    const [actionResult, commitmentResult] = await Promise.allSettled([
      apiFetch<{ actions: PendingActionItem[] }>(`/api/chat/pending-actions${qs}`),
      apiFetch<{ commitments: CommitmentItem[] }>("/api/commitments?status=OPEN&limit=8"),
    ]);

    if (actionResult.status === "fulfilled") {
      const actionData = actionResult.value;
      setActions(Array.isArray(actionData.actions) ? actionData.actions : []);
    } else {
      captureClientError(actionResult.reason, { scope: "inbox.load.actions" });
      setActions([]);
    }

    if (commitmentResult.status === "fulfilled") {
      const commitmentData = commitmentResult.value;
      setCommitments(Array.isArray(commitmentData.commitments) ? commitmentData.commitments : []);
    } else {
      captureClientError(commitmentResult.reason, { scope: "inbox.load.commitments" });
      setCommitments([]);
    }

    if (actionResult.status === "rejected" || commitmentResult.status === "rejected") {
      setError("Could not load the decision queue.");
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    load(filter);
  }, [filter, load]);

  // Refresh when a new pending action arrives (websocket fires "conversations-updated")
  useEffect(() => {
    const handler = () => load(filter);
    window.addEventListener("conversations-updated", handler);
    return () => window.removeEventListener("conversations-updated", handler);
  }, [filter, load]);

  const handleApprove = async (actionId: string) => {
    if (actionLoading[actionId]) return;
    setActionLoading((prev) => ({ ...prev, [actionId]: "approve" }));
    try {
      await apiFetch(`/api/chat/pending-actions/${actionId}/approve`, { method: "POST" });
      setActions((prev) =>
        filter === "pending"
          ? prev.filter((a) => a.id !== actionId)
          : prev.map((a) => (a.id === actionId ? { ...a, status: "EXECUTED" } : a)),
      );
      toast("Action approved.", "success");
    } catch (err) {
      captureClientError(err, { scope: "inbox.approve", actionId });
      toast("Could not approve this action. Please try again.", "error");
    } finally {
      setActionLoading((prev) => ({ ...prev, [actionId]: null }));
    }
  };

  const handleReject = async (actionId: string) => {
    if (actionLoading[actionId]) return;
    setActionLoading((prev) => ({ ...prev, [actionId]: "reject" }));
    try {
      await apiFetch(`/api/chat/pending-actions/${actionId}/reject`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setActions((prev) =>
        filter === "pending"
          ? prev.filter((a) => a.id !== actionId)
          : prev.map((a) => (a.id === actionId ? { ...a, status: "REJECTED" } : a)),
      );
      toast("Suggestion rejected.", "success");
    } catch (err) {
      captureClientError(err, { scope: "inbox.reject", actionId });
      toast("Could not reject this action. Please try again.", "error");
    } finally {
      setActionLoading((prev) => ({ ...prev, [actionId]: null }));
    }
  };

  const handleSnooze = async (actionId: string, hours = 1) => {
    if (actionLoading[actionId]) return;
    setActionLoading((prev) => ({ ...prev, [actionId]: "snooze" }));
    try {
      const snoozeUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
      await apiFetch(`/api/chat/pending-actions/${actionId}/snooze`, {
        method: "POST",
        body: JSON.stringify({ snoozeUntil }),
      });
      setActions((prev) =>
        filter === "pending"
          ? prev.filter((a) => a.id !== actionId)
          : prev.map((a) => (a.id === actionId ? { ...a, status: "REJECTED" } : a)),
      );
      toast(`Snoozed for ${hours}h — will resurface automatically.`, "success");
    } catch (err) {
      captureClientError(err, { scope: "inbox.snooze", actionId });
      toast("Could not snooze this action. Please try again.", "error");
    } finally {
      setActionLoading((prev) => ({ ...prev, [actionId]: null }));
    }
  };

  const handleCommitmentStatus = async (commitmentId: string, status: "DONE" | "DISMISSED") => {
    if (commitmentLoading[commitmentId]) return;
    const loadingState = status === "DONE" ? "done" : "dismiss";
    setCommitmentLoading((prev) => ({ ...prev, [commitmentId]: loadingState }));
    try {
      await apiFetch(`/api/commitments/${commitmentId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setCommitments((prev) => prev.filter((c) => c.id !== commitmentId));
      window.dispatchEvent(new Event("conversations-updated"));
    } catch (err) {
      captureClientError(err, { scope: "inbox.commitment_status", commitmentId, status });
      toast("Could not update the commitment. Please try again soon.", "error");
    } finally {
      setCommitmentLoading((prev) => ({ ...prev, [commitmentId]: null }));
    }
  };

  const pendingCount = actions.filter((a) => a.status === "PENDING").length;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:py-10">
      <header className="mb-6 overflow-hidden rounded-lg border border-amber-300/15 bg-stone-950/65 shadow-2xl shadow-black/20">
        <div className="h-1 bg-gradient-to-r from-amber-300 via-stone-500 to-teal-300" />
        <div className="p-5 md:p-6">
          <div className="grid gap-5 lg:grid-cols-[1fr_300px] lg:items-stretch">
            <div className="max-w-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300">
                Decision queue
              </p>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-50 md:text-3xl">
                Turn scattered signals into decisions you can approve.
              </h1>
              <p className="mt-3 text-sm leading-6 text-stone-400">
                See what Jigeum found, why it matters, and what action is ready before anything
                runs.
              </p>
            </div>
            <div className="relative min-h-40 overflow-hidden rounded-lg border border-stone-800 bg-black/20">
              <EveSignalField className="absolute inset-0 border-0" />
              <button
                type="button"
                onClick={() => load(filter)}
                disabled={loading}
                className="absolute right-3 top-3 h-9 rounded-md border border-stone-700 bg-stone-950/70 px-3 text-xs text-stone-300 backdrop-blur transition hover:bg-stone-800 disabled:opacity-50"
                aria-label="Refresh decision queue"
              >
                {loading ? "..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-3 overflow-hidden rounded-xl border border-white/10 bg-black/25">
            <QueueMetric label="Pending" value={pendingCount} />
            <QueueMetric label="Cards" value={actions.length} />
            <QueueMetric label="Open commitments" value={commitments.length} />
          </div>

          <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex w-fit items-center gap-1 rounded-lg border border-stone-800 bg-stone-950/80 p-1">
              <FilterTab
                active={filter === "pending"}
                label={`Pending${pendingCount ? ` (${pendingCount})` : ""}`}
                onClick={() => setFilter("pending")}
              />
              <FilterTab active={filter === "all"} label="All" onClick={() => setFilter("all")} />
            </div>
            <div className="flex items-center gap-4">
              <p className="text-xs text-stone-600">
                Review the signal, judgment, and action before approval.
              </p>
              <div className="flex items-center gap-3">
                <Link
                  href="/inbox/receipt"
                  className="shrink-0 text-xs text-teal-400 hover:text-teal-300 transition"
                >
                  Today's receipt →
                </Link>
                <Link
                  href="/agent"
                  className="shrink-0 text-xs text-stone-500 hover:text-stone-300 transition"
                >
                  Agent timeline →
                </Link>
              </div>
            </div>
          </div>
        </div>
      </header>

      <OperatingLoopCard />
      <BetaLearningCard />

      {loading && actions.length === 0 && (
        <p className="text-sm text-stone-500 py-8 text-center">Loading...</p>
      )}

      {error && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && actions.length === 0 && commitments.length === 0 && (
        <div className="rounded-lg border border-stone-800 bg-stone-900/40 p-8 text-center">
          <p className="text-sm text-stone-300 mb-1">
            {filter === "pending" ? "No pending items." : "No decision queue items yet."}
          </p>
          <p className="mx-auto max-w-md text-xs leading-5 text-stone-500">
            Connect work signals or start a decision thread so Jigeum has mail, meetings, and tasks
            to turn into cards.
          </p>
          <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
            <Link
              href="/settings"
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-amber-300 px-4 text-sm font-semibold text-stone-950 transition hover:bg-amber-200"
            >
              Connect Google
            </Link>
            <Link
              href="/chat"
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-stone-700 px-4 text-sm font-medium text-stone-300 transition hover:bg-stone-800"
            >
              Start a thread
            </Link>
            <Link
              href="/email"
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-stone-700 px-4 text-sm font-medium text-stone-300 transition hover:bg-stone-800"
            >
              Open mail
            </Link>
          </div>
        </div>
      )}

      {actions.length > 0 && (
        <section className="mb-6" aria-label="Decision queue">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-stone-100">Decision cards</h2>
            <span className="text-[11px] text-stone-500">{actions.length}</span>
          </div>
          <ul className="space-y-3">
            {actions.map((action) => (
              <li key={action.id}>
                <ActionCard
                  action={action}
                  loading={actionLoading[action.id] ?? null}
                  onApprove={() => handleApprove(action.id)}
                  onReject={() => handleReject(action.id)}
                  onSnooze={() => handleSnooze(action.id, 1)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {commitments.length > 0 && (
        <CommitmentSection
          commitments={commitments}
          loading={commitmentLoading}
          onDone={(id) => handleCommitmentStatus(id, "DONE")}
          onDismiss={(id) => handleCommitmentStatus(id, "DISMISSED")}
        />
      )}

      <BriefingCard />
      <CommandCenterSummary />
      <WorkGraphSummaryCard />
      <PlaybookRecommendations />
    </div>
  );
}

function CommitmentSection({
  commitments,
  loading,
  onDone,
  onDismiss,
}: {
  commitments: CommitmentItem[];
  loading: Record<string, "done" | "dismiss" | null>;
  onDone: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <section className="mb-6" aria-label="Commitment ledger">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-stone-100">Tracked commitments</h2>
        <span className="text-[11px] text-stone-500">{commitments.length}</span>
      </div>
      <ul className="space-y-2">
        {commitments.map((commitment) => (
          <li key={commitment.id}>
            <CommitmentCard
              commitment={commitment}
              loading={loading[commitment.id] ?? null}
              onDone={() => onDone(commitment.id)}
              onDismiss={() => onDismiss(commitment.id)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CommitmentCard({
  commitment,
  loading,
  onDone,
  onDismiss,
}: {
  commitment: CommitmentItem;
  loading: "done" | "dismiss" | null;
  onDone: () => void;
  onDismiss: () => void;
}) {
  const { toast } = useToast();
  const [pathExpanded, setPathExpanded] = useState(false);
  const [pathData, setPathData] = useState<CommitmentPathData | null>(null);
  const [pathLoading, setPathLoading] = useState(false);
  const [materializingStep, setMaterializingStep] = useState<number | "all" | null>(null);
  const [materializedSteps, setMaterializedSteps] = useState<Set<number>>(new Set());

  const loadPath = async () => {
    if (pathData || pathLoading) return;
    setPathLoading(true);
    try {
      const result = await apiFetch<{ success: boolean; path: CommitmentPathData }>(
        `/api/commitments/${commitment.id}/path`,
      );
      setPathData(result.path);
      const existing = new Set<number>();
      result.path.steps.forEach((step, i) => {
        if (step.taskId) existing.add(i);
      });
      setMaterializedSteps(existing);
    } catch {
      toast("Could not load fulfillment plan.", "error");
    } finally {
      setPathLoading(false);
    }
  };

  const togglePath = () => {
    if (!pathExpanded) loadPath();
    setPathExpanded((prev) => !prev);
  };

  const materializeStep = async (index: number) => {
    if (materializingStep !== null) return;
    setMaterializingStep(index);
    try {
      await apiFetch<{ success: boolean; taskId: string }>(
        `/api/commitments/${commitment.id}/path/steps/${index}/materialize`,
        { method: "POST" },
      );
      setMaterializedSteps((prev) => new Set([...prev, index]));
      toast("Task created.", "success");
    } catch {
      toast("Could not create task.", "error");
    } finally {
      setMaterializingStep(null);
    }
  };

  const materializeAll = async () => {
    if (materializingStep !== null || !pathData) return;
    setMaterializingStep("all");
    try {
      const result = await apiFetch<{ success: boolean; taskIds: string[] }>(
        `/api/commitments/${commitment.id}/path/materialize-all`,
        { method: "POST" },
      );
      const next = new Set(materializedSteps);
      for (let i = 0; i < pathData.steps.length; i++) next.add(i);
      setMaterializedSteps(next);
      toast(`${result.taskIds.length} task${result.taskIds.length === 1 ? "" : "s"} created.`, "success");
    } catch {
      toast("Could not create tasks.", "error");
    } finally {
      setMaterializingStep(null);
    }
  };

  const rebuildPath = async () => {
    if (pathLoading) return;
    setPathLoading(true);
    try {
      const result = await apiFetch<{ success: boolean; path: CommitmentPathData }>(
        `/api/commitments/${commitment.id}/path/rebuild`,
        { method: "POST" },
      );
      setPathData(result.path);
      setMaterializedSteps(new Set());
      toast("Plan rebuilt.", "success");
    } catch {
      toast("Could not rebuild plan.", "error");
    } finally {
      setPathLoading(false);
    }
  };

  return (
    <article className="rounded-lg border border-stone-800 bg-stone-900/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <CommitmentOwnerBadge owner={commitment.owner} />
            {commitment.owner === "COUNTERPARTY" &&
              commitment.trustBadge &&
              commitment.trustBadge !== "unknown" && <TrustBadge badge={commitment.trustBadge} />}
            <span className="text-[11px] text-stone-500">
              {commitmentKindLabel(commitment.kind)}
            </span>
            <span className="text-[11px] text-stone-600">{commitmentDueLabel(commitment)}</span>
          </div>
          <p className="mt-2 text-sm font-medium text-stone-100 break-words">{commitment.title}</p>
          {commitment.description && (
            <p className="mt-1 text-xs text-stone-400 line-clamp-2">{commitment.description}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <button
          type="button"
          onClick={onDone}
          disabled={!!loading}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition min-w-[72px]"
        >
          {loading === "done" ? (
            <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            "Done"
          )}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={!!loading}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-stone-700 text-stone-300 hover:bg-stone-800 disabled:opacity-50 disabled:cursor-not-allowed transition min-w-[72px]"
        >
          {loading === "dismiss" ? (
            <span className="w-3 h-3 border-2 border-stone-300/30 border-t-stone-200 rounded-full animate-spin" />
          ) : (
            "Dismiss"
          )}
        </button>
        <button
          type="button"
          onClick={togglePath}
          className="inline-flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-teal-700/50 text-teal-400 hover:bg-teal-400/10 transition"
        >
          {pathExpanded ? "Hide plan" : "View plan"}
        </button>
        <span className="ml-auto text-[11px] text-stone-600">
          Confidence {Math.round((commitment.confidence ?? 0.72) * 100)}%
        </span>
      </div>

      {pathExpanded && (
        <CommitmentPathPanel
          pathData={pathData}
          loading={pathLoading}
          materializingStep={materializingStep}
          materializedSteps={materializedSteps}
          onMaterializeStep={materializeStep}
          onMaterializeAll={materializeAll}
          onRebuild={rebuildPath}
        />
      )}
    </article>
  );
}

function FilterTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-md transition ${
        active ? "bg-stone-800 text-white" : "text-stone-400 hover:text-stone-200"
      }`}
    >
      {label}
    </button>
  );
}

function QueueMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-r border-white/10 px-4 py-3 last:border-r-0">
      <p className="text-2xl font-semibold text-stone-50">{value}</p>
      <p className="mt-1 text-[11px] text-stone-500">{label}</p>
    </div>
  );
}

function ActionCard({
  action,
  loading,
  onApprove,
  onReject,
  onSnooze,
}: {
  action: PendingActionItem;
  loading: "approve" | "reject" | "snooze" | null;
  onApprove: () => void;
  onReject: () => void;
  onSnooze: () => void;
}) {
  const toolName = action.toolName || "prepared_action";
  const toolArgs = action.toolArgs || "{}";
  const preview = buildPreview(toolName, toolArgs, action.targetLabel);
  const emailPreview = toolName === "send_email" ? buildEmailPreview(toolArgs) : null;
  const reasoning = splitReasoning(action.reasoning);
  const isPending = action.status === "PENDING";
  const risk = riskForTool(toolName);

  return (
    <article className="relative overflow-hidden rounded-lg border border-stone-800 bg-stone-950/70">
      <div className="absolute bottom-0 left-0 top-0 w-1 bg-gradient-to-b from-amber-300 via-teal-300 to-stone-100" />
      <div className="border-b border-stone-800 bg-stone-900/50 px-4 py-3 pl-5 md:px-5 md:pl-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-300">
              Decision card
            </span>
            <StatusBadge status={action.status} />
          </div>
          <span className="text-[11px] text-stone-600">{formatRelative(action.createdAt)}</span>
        </div>
      </div>

      <div className="p-4 pl-5 md:p-5 md:pl-6">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-medium text-amber-200 bg-amber-300/10 border border-amber-300/20 rounded px-1.5 py-0.5">
              {toolName === "prepared_action" ? "Prepared action" : toolName.replace(/_/g, " ")}
            </span>
            <RiskBadge risk={risk} />
            {action.conversationTitle && (
              <span className="min-w-0 truncate text-[11px] text-stone-600">
                Thread: {action.conversationTitle}
              </span>
            )}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <DecisionSection
              label="Signal"
              title="What Jigeum found"
              body={
                reasoning.situation ||
                action.conversationTitle ||
                "Jigeum reviewed the connected thread and work signals."
              }
            />
            <DecisionSection
              label="Judgment"
              title="Why it matters"
              body={reasoning.judgment || action.reasoning || "Review is needed before execution."}
            />
            <DecisionSection
              label="Action"
              title="Prepared move"
              body={
                reasoning.proposal ||
                preview ||
                action.preview ||
                (toolName === "prepared_action" ? "Prepared action" : toolName.replace(/_/g, " "))
              }
            />
          </div>

          {emailPreview && (
            <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-amber-300">
                  Approval required before sending
                </span>
                <span className="text-[11px] text-stone-500">send_email</span>
              </div>
              <p className="mt-2 text-xs text-stone-300 break-words">To: {emailPreview.to}</p>
              <p className="mt-1 text-xs text-stone-400 break-words">
                Subject: {emailPreview.subject}
              </p>
              {emailPreview.body && (
                <p className="mt-2 text-xs leading-relaxed text-stone-300 line-clamp-4 whitespace-pre-wrap">
                  {emailPreview.body}
                </p>
              )}
            </div>
          )}

          {isPending && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-stone-800 pt-4">
              <button
                type="button"
                onClick={onApprove}
                disabled={!!loading}
                className="inline-flex min-w-[88px] items-center justify-center gap-1.5 rounded-md bg-amber-400 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading === "approve" ? (
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone-950/30 border-t-stone-950" />
                ) : (
                  "Approve"
                )}
              </button>
              <button
                type="button"
                onClick={onReject}
                disabled={!!loading}
                className="inline-flex min-w-[88px] items-center justify-center gap-1.5 rounded-md border border-stone-600 px-4 py-2 text-sm font-medium text-stone-300 transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading === "reject" ? (
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone-300/30 border-t-stone-200" />
                ) : (
                  "Reject"
                )}
              </button>
              <button
                type="button"
                onClick={onSnooze}
                disabled={!!loading}
                title="Remind me in 1 hour"
                className="inline-flex items-center justify-center gap-1 px-3 py-2 text-xs text-stone-500 hover:text-stone-300 transition disabled:opacity-50"
              >
                {loading === "snooze" ? (
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone-500/30 border-t-stone-400" />
                ) : (
                  "Snooze 1h"
                )}
              </button>
              <Link
                href={`/chat/${action.conversationId}`}
                className="text-xs text-amber-300 hover:text-amber-200 ml-auto transition"
              >
                Open thread →
              </Link>
            </div>
          )}

          {!isPending && (
            <div className="flex items-center justify-between mt-4 border-t border-stone-800 pt-3">
              {action.result && (
                <p className="text-[11px] text-stone-500 truncate flex-1">{action.result}</p>
              )}
              <Link
                href={`/chat/${action.conversationId}`}
                className="text-xs text-stone-400 hover:text-stone-200 transition shrink-0 ml-2"
              >
                Open thread →
              </Link>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function DecisionSection({ label, title, body }: { label: string; title: string; body: string }) {
  return (
    <section className="rounded-lg border border-stone-800 bg-black/20 p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300">{label}</p>
      <h3 className="mt-2 text-xs font-semibold text-stone-200">{title}</h3>
      <p className="mt-2 text-xs leading-5 text-stone-400">{body}</p>
    </section>
  );
}

function RiskBadge({ risk }: { risk: "low" | "medium" | "high" }) {
  const map = {
    low: {
      label: "Low risk",
      className: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20",
    },
    medium: {
      label: "Needs approval",
      className: "text-amber-300 bg-amber-400/10 border-amber-400/20",
    },
    high: {
      label: "High risk",
      className: "text-red-300 bg-red-500/10 border-red-500/20",
    },
  }[risk];

  return (
    <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 ${map.className}`}>
      {map.label}
    </span>
  );
}

function riskForTool(toolName: string): "low" | "medium" | "high" {
  if (toolName.startsWith("delete_") || toolName === "archive_email") return "high";
  if (
    toolName === "send_email" ||
    toolName === "create_event" ||
    toolName === "create_contact" ||
    toolName === "update_contact"
  ) {
    return "medium";
  }
  return "low";
}

function splitReasoning(reasoning: string | null): {
  situation: string | null;
  judgment: string | null;
  proposal: string | null;
} {
  if (!reasoning) return { situation: null, judgment: null, proposal: null };

  const read = (label: "Situation" | "Judgment" | "Proposal"): string | null => {
    const labels = ["Situation", "Judgment", "Proposal"].filter((item) => item !== label).join("|");
    const match = reasoning.match(
      new RegExp(
        `(?:📋|💡|✅)?\\s*${label}\\s*[:：]\\s*([\\s\\S]*?)(?=(?:📋|💡|✅)?\\s*(?:${labels})\\s*[:：]|$)`,
      ),
    );
    return match?.[1]?.trim() || null;
  };

  const situation = read("Situation");
  const judgment = read("Judgment");
  const proposal = read("Proposal");
  if (situation || judgment || proposal) return { situation, judgment, proposal };

  return { situation: null, judgment: reasoning.trim(), proposal: null };
}

function CommitmentOwnerBadge({ owner }: { owner: CommitmentItem["owner"] }) {
  const entry = commitmentOwnerEntry(owner);
  return (
    <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 ${entry.className}`}>
      {entry.label}
    </span>
  );
}

function TrustBadge({ badge }: { badge: NonNullable<CommitmentItem["trustBadge"]> }) {
  const map: Record<string, { label: string; className: string }> = {
    reliable: {
      label: "Reliable",
      className: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20",
    },
    mostly_reliable: {
      label: "Usually reliable",
      className: "text-teal-300 bg-teal-400/10 border-teal-400/20",
    },
    unreliable: {
      label: "Often late",
      className: "text-red-300 bg-red-500/10 border-red-500/20",
    },
  };
  const entry = map[badge];
  if (!entry) return null;
  return (
    <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 ${entry.className}`}>
      {entry.label}
    </span>
  );
}

function commitmentOwnerEntry(owner: CommitmentItem["owner"]): {
  label: string;
  className: string;
} {
  switch (owner) {
    case "USER":
      return {
        label: "Mine",
        className: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20",
      };
    case "COUNTERPARTY":
      return {
        label: "Counterparty",
        className: "text-amber-200 bg-amber-300/10 border-amber-300/20",
      };
    case "TEAM":
      return {
        label: "Team",
        className: "text-amber-200 bg-amber-300/10 border-amber-300/20",
      };
    case "UNKNOWN":
      return {
        label: "Needs owner",
        className: "text-amber-300 bg-amber-400/10 border-amber-400/20",
      };
  }
}

function commitmentKindLabel(kind: CommitmentItem["kind"]): string {
  const labels: Record<CommitmentItem["kind"], string> = {
    DELIVERABLE: "Deliverable",
    FOLLOW_UP: "Follow-up",
    DECISION: "Decision",
    MEETING: "Meeting",
    REVIEW: "Review",
  };
  return labels[kind];
}

function commitmentDueLabel(commitment: CommitmentItem): string {
  if (commitment.dueText) return commitment.dueText;
  if (commitment.dueAt) {
    return new Date(commitment.dueAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }
  return "No due date";
}

function StatusBadge({ status }: { status: PendingActionItem["status"] }) {
  const map: Record<PendingActionItem["status"], { label: string; className: string }> = {
    PENDING: { label: "Pending", className: "text-amber-300 bg-amber-400/10 border-amber-400/20" },
    EXECUTED: {
      label: "Done",
      className: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20",
    },
    REJECTED: {
      label: "Rejected",
      className: "text-stone-400 bg-stone-500/10 border-stone-500/20",
    },
    FAILED: { label: "Failed", className: "text-red-300 bg-red-500/10 border-red-500/20" },
  };
  const entry = map[status];
  return (
    <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 ${entry.className}`}>
      {entry.label}
    </span>
  );
}

function buildPreview(
  toolName: string,
  rawArgs: string,
  targetLabel: string | null,
): string | null {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return null;
  }
  const pick = (key: string): string | undefined => {
    const v = args[key];
    return typeof v === "string" ? v : undefined;
  };
  if (toolName === "send_email") {
    return `To: ${pick("to") || "?"} · ${pick("subject") || "No subject"}`;
  }
  if (toolName === "create_event") {
    const start = pick("startTime");
    const when = start
      ? new Date(start).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    const loc = pick("location");
    return `${pick("title") || "Event"}${when ? ` · ${when}` : ""}${loc ? ` · ${loc}` : ""}`;
  }
  if (toolName === "create_task" || toolName === "create_note") {
    return pick("title") || "Untitled";
  }
  if (toolName === "create_contact") {
    const email = pick("email");
    return `${pick("name") || "?"}${email ? ` (${email})` : ""}`;
  }
  if (toolName === "delete_task" || toolName === "delete_note" || toolName === "delete_contact") {
    // Prefer server-resolved label (task title / contact name); fall back to
    // the correct id key so the user at least sees *something* they can match.
    const idKey =
      toolName === "delete_task"
        ? "task_id"
        : toolName === "delete_note"
          ? "note_id"
          : "contact_id";
    return `Delete: ${targetLabel || pick(idKey) || "?"}`;
  }
  if (toolName === "update_task" || toolName === "update_note" || toolName === "update_contact") {
    const idKey =
      toolName === "update_task"
        ? "task_id"
        : toolName === "update_note"
          ? "note_id"
          : "contact_id";
    return `Update: ${targetLabel || pick(idKey) || "?"}`;
  }
  return null;
}

function CommitmentPathPanel({
  pathData,
  loading,
  materializingStep,
  materializedSteps,
  onMaterializeStep,
  onMaterializeAll,
  onRebuild,
}: {
  pathData: CommitmentPathData | null;
  loading: boolean;
  materializingStep: number | "all" | null;
  materializedSteps: Set<number>;
  onMaterializeStep: (index: number) => void;
  onMaterializeAll: () => void;
  onRebuild: () => void;
}) {
  if (loading && !pathData) {
    return (
      <div className="mt-4 border-t border-stone-800 pt-4">
        <p className="text-xs text-stone-500 animate-pulse">Building fulfillment plan...</p>
      </div>
    );
  }

  if (!pathData) return null;

  const allMaterialized =
    pathData.steps.length > 0 && pathData.steps.every((_, i) => materializedSteps.has(i));

  const actionIcon = (action: PathStep["action"]) => {
    const icons: Record<PathStep["action"], string> = {
      task: "□",
      event: "◷",
      email: "✉",
      check: "✓",
    };
    return icons[action] ?? "□";
  };

  return (
    <div className="mt-4 border-t border-stone-800 pt-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-teal-300">Fulfillment plan</p>
        <div className="flex items-center gap-3">
          {!allMaterialized && (
            <button
              type="button"
              onClick={onMaterializeAll}
              disabled={materializingStep !== null}
              className="text-xs text-teal-400 hover:text-teal-300 transition disabled:opacity-50"
            >
              {materializingStep === "all" ? "Creating..." : "Create all tasks"}
            </button>
          )}
          <button
            type="button"
            onClick={onRebuild}
            disabled={loading}
            className="text-xs text-stone-500 hover:text-stone-400 transition disabled:opacity-50"
          >
            {loading ? "Rebuilding..." : "Rebuild"}
          </button>
        </div>
      </div>

      <ol className="space-y-2">
        {pathData.steps.map((step, i) => {
          const isMaterialized = materializedSteps.has(i);
          const dueLabel = new Date(step.dueIso).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          });
          return (
            <li
              key={`${step.dueIso}-${i}`}
              className={`flex items-start gap-3 rounded-lg p-3 text-xs border ${
                isMaterialized
                  ? "border-teal-500/20 bg-teal-400/5"
                  : "border-stone-800 bg-black/15"
              }`}
            >
              <span className="mt-0.5 w-4 shrink-0 text-center font-mono text-[10px] text-stone-500">
                {actionIcon(step.action)}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={`leading-5 ${
                    isMaterialized ? "line-through text-stone-500" : "text-stone-200"
                  }`}
                >
                  {step.step}
                </p>
                <p className="mt-0.5 text-[11px] text-stone-600">
                  {dueLabel} · ~{step.estimatedMinutes}m
                </p>
              </div>
              {isMaterialized ? (
                <span className="shrink-0 text-[11px] text-teal-400">task ✓</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onMaterializeStep(i)}
                  disabled={materializingStep !== null}
                  className="shrink-0 rounded border border-stone-700 px-2 py-0.5 text-[11px] text-stone-400 transition hover:border-stone-500 hover:text-stone-200 disabled:opacity-50"
                >
                  {materializingStep === i ? "..." : "+ task"}
                </button>
              )}
            </li>
          );
        })}
      </ol>

      <p className="mt-2 text-[10px] text-stone-600">
        {pathData.model ?? "AI"} · {new Date(pathData.builtAt).toLocaleDateString()}
      </p>
    </div>
  );
}

function buildEmailPreview(
  rawArgs: string,
): { to: string; subject: string; body: string | null } | null {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return null;
  }
  const pick = (key: string): string | null => {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  return {
    to: pick("to") || pick("recipient") || "?",
    subject: pick("subject") || "No subject",
    body: pick("body") || pick("message"),
  };
}
