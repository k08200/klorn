"use client";

import { useState } from "react";
import { apiFetch } from "../lib/api";
import { useToast } from "./toast";

export interface CommitmentItem {
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
  trustLabel?: string | null;
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

export type CommitmentLoadingState = "done" | "dismiss" | "snooze" | null;

interface CommitmentCardProps {
  commitment: CommitmentItem;
  loading: CommitmentLoadingState;
  onDone: () => void;
  onDismiss: () => void;
  onSnooze: () => void;
}

export function CommitmentCard({
  commitment,
  loading,
  onDone,
  onDismiss,
  onSnooze,
}: CommitmentCardProps) {
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
      toast(
        `${result.taskIds.length} task${result.taskIds.length === 1 ? "" : "s"} created.`,
        "success",
      );
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
    <article className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CommitmentOwnerBadge owner={commitment.owner} />
            {commitment.owner === "COUNTERPARTY" &&
              commitment.trustBadge &&
              commitment.trustBadge !== "unknown" && (
                <TrustBadge badge={commitment.trustBadge} label={commitment.trustLabel ?? null} />
              )}
            <span className="text-[11px] text-slate-400">
              {commitmentKindLabel(commitment.kind)}
            </span>
            <span className="text-[11px] text-slate-500">{commitmentDueLabel(commitment)}</span>
          </div>
          <p className="mt-2 text-sm font-medium text-slate-900 break-words">{commitment.title}</p>
          {commitment.description && (
            <p className="mt-1 text-xs text-slate-500 line-clamp-2">{commitment.description}</p>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onDone}
          disabled={!!loading}
          className="glow-primary ease-strong inline-flex min-w-[72px] items-center justify-center gap-1.5 rounded-lg bg-gradient-to-b from-sky-400 to-sky-500 px-3 py-1.5 text-xs font-medium text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading === "done" ? (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            "Done"
          )}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={!!loading}
          className="ease-strong inline-flex min-w-[72px] items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white/70 px-3 py-1.5 text-xs font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading === "dismiss" ? (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300/40 border-t-slate-600" />
          ) : (
            "Dismiss"
          )}
        </button>
        <button
          type="button"
          onClick={togglePath}
          className="ease-strong inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white/70 px-3 py-1.5 text-xs font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
        >
          {pathExpanded ? "Hide plan" : "View plan"}
        </button>
        <button
          type="button"
          onClick={onSnooze}
          disabled={!!loading}
          title="Hide for 24h — will resurface automatically"
          className="ease-strong inline-flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs text-slate-400 transition duration-150 hover:bg-sky-50 hover:text-sky-700 active:scale-[0.97] disabled:opacity-50"
        >
          {loading === "snooze" ? (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-400/30 border-t-slate-500" />
          ) : (
            "Snooze 24h"
          )}
        </button>
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

function CommitmentOwnerBadge({ owner }: { owner: CommitmentItem["owner"] }) {
  const entry = commitmentOwnerEntry(owner);
  return (
    <span
      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ${entry.className}`}
    >
      {entry.label}
    </span>
  );
}

function TrustBadge({
  badge,
  label,
}: {
  badge: NonNullable<CommitmentItem["trustBadge"]>;
  label: string | null;
}) {
  const map: Record<string, { shortLabel: string; className: string }> = {
    reliable: {
      shortLabel: "Reliable",
      className: "bg-emerald-500/10 text-emerald-600 ring-1 ring-inset ring-emerald-500/20",
    },
    mostly_reliable: {
      shortLabel: "Usually reliable",
      className: "bg-amber-500/10 text-amber-600 ring-1 ring-inset ring-amber-500/20",
    },
    unreliable: {
      shortLabel: "Often late",
      className: "bg-rose-500/10 text-rose-600 ring-1 ring-inset ring-rose-500/20",
    },
  };
  const entry = map[badge];
  if (!entry) return null;
  return (
    <span
      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ${entry.className}`}
      title={label ?? undefined}
    >
      {entry.shortLabel}
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
        className: "bg-emerald-500/10 text-emerald-600 ring-1 ring-inset ring-emerald-500/20",
      };
    case "COUNTERPARTY":
      return {
        label: "Counterparty",
        className: "bg-sky-500/10 text-sky-600 ring-1 ring-inset ring-sky-500/20",
      };
    case "TEAM":
      return {
        label: "Team",
        className: "bg-sky-500/10 text-sky-600 ring-1 ring-inset ring-sky-500/20",
      };
    case "UNKNOWN":
      return {
        label: "Needs owner",
        className: "bg-slate-100 text-slate-500",
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
      <div className="mt-4 border-t border-slate-200 pt-4">
        <p className="text-xs text-slate-400 animate-pulse">Building fulfillment plan...</p>
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
    <div className="mt-4 border-t border-slate-200 pt-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-semibold text-sky-600">Fulfillment plan</p>
        <div className="flex items-center gap-3">
          {!allMaterialized && (
            <button
              type="button"
              onClick={onMaterializeAll}
              disabled={materializingStep !== null}
              className="text-xs font-medium text-sky-600 transition duration-150 hover:text-sky-700 disabled:opacity-50"
            >
              {materializingStep === "all" ? "Creating..." : "Create all tasks"}
            </button>
          )}
          <button
            type="button"
            onClick={onRebuild}
            disabled={loading}
            className="text-xs text-slate-400 transition duration-150 hover:text-slate-600 disabled:opacity-50"
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
              className={`flex items-start gap-3 rounded-lg border p-3 text-xs ${
                isMaterialized ? "border-sky-500/20 bg-sky-500/5" : "border-slate-200 bg-slate-50"
              }`}
            >
              <span className="mt-0.5 w-4 shrink-0 text-center font-mono text-[10px] text-slate-400">
                {actionIcon(step.action)}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={`leading-5 ${
                    isMaterialized ? "line-through text-slate-400" : "text-slate-900"
                  }`}
                >
                  {step.step}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {dueLabel} · ~{step.estimatedMinutes}m
                </p>
              </div>
              {isMaterialized ? (
                <span className="shrink-0 text-[11px] font-medium text-sky-600">task ✓</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onMaterializeStep(i)}
                  disabled={materializingStep !== null}
                  className="ease-strong shrink-0 rounded-md border border-slate-200 bg-white/70 px-2 py-0.5 text-[11px] font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97] disabled:opacity-50"
                >
                  {materializingStep === i ? "..." : "+ task"}
                </button>
              )}
            </li>
          );
        })}
      </ol>

      <p className="mt-2 text-[10px] text-slate-500">
        {pathData.model ?? "AI"} · {new Date(pathData.builtAt).toLocaleDateString("en-US")}
      </p>
    </div>
  );
}
