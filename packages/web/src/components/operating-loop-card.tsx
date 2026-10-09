"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import type {
  OperatingPlan,
  OperatingPlanDecisionPulse,
  OperatingPlanMetric,
  OperatingPlanMove,
  OperatingPlanOutcome,
  OperatingPlanTone,
  OperatingPlanWatchContext,
} from "../lib/operating-plan";
import { ToolName } from "./tool-name";

const EMPTY_PLAN: OperatingPlan = {
  generatedAt: "",
  mode: "maintain_flow",
  headline: "",
  primaryAction: "",
  metrics: [],
  nextMoves: [],
  watchlist: [],
  playbookNudge: null,
  decisionPulse: { windowHours: 24, executed: 0, rejected: 0, failed: 0, latest: [] },
};

function normalizePlan(
  value: OperatingPlan | { plan?: Partial<OperatingPlan> | null },
): OperatingPlan {
  let raw: Partial<OperatingPlan> = EMPTY_PLAN;
  if (value && typeof value === "object" && "plan" in value) {
    raw = value.plan ?? EMPTY_PLAN;
  } else {
    raw = value as Partial<OperatingPlan>;
  }
  return {
    ...EMPTY_PLAN,
    ...raw,
    headline: raw.headline ?? "Keep the current flow moving.",
    primaryAction: raw.primaryAction ?? "Start with the first decision card.",
    metrics: Array.isArray(raw.metrics) ? raw.metrics : [],
    nextMoves: Array.isArray(raw.nextMoves)
      ? raw.nextMoves.map((move, index) => normalizeMove(move, index))
      : [],
    watchlist: Array.isArray(raw.watchlist) ? raw.watchlist : [],
    playbookNudge: raw.playbookNudge ?? null,
    decisionPulse: {
      ...EMPTY_PLAN.decisionPulse,
      ...(raw.decisionPulse ?? {}),
      latest: Array.isArray(raw.decisionPulse?.latest)
        ? raw.decisionPulse.latest.map((outcome, index) => normalizeOutcome(outcome, index))
        : [],
    },
  };
}

function normalizeMove(move: Partial<OperatingPlanMove>, index: number): OperatingPlanMove {
  const legacy = move as Partial<OperatingPlanMove> & {
    priority?: "low" | "medium" | "high";
    rationale?: string;
    surface?: OperatingPlanMove["source"];
  };
  return {
    id: move.id ?? `move_${index}`,
    label: move.label ?? "Next move",
    tone:
      move.tone ??
      (legacy.priority === "high" ? "critical" : legacy.priority === "medium" ? "warn" : "steady"),
    source: move.source ?? legacy.surface ?? "attention",
    title: move.title ?? "Prepared work",
    reason: move.reason ?? legacy.rationale ?? "There are work signals to review.",
    prompt: move.prompt ?? move.title ?? "Help me prepare the next step for this work.",
    href: move.href ?? null,
  };
}

function normalizeOutcome(
  outcome: Partial<OperatingPlanOutcome>,
  index: number,
): OperatingPlanOutcome {
  return {
    id: outcome.id ?? `outcome_${index}`,
    title: outcome.title ?? "Recent decision",
    status: outcome.status ?? "executed",
    toolName: outcome.toolName ?? "decision",
    result: outcome.result ?? null,
    href: outcome.href ?? "/inbox",
    decidedAt: outcome.decidedAt ?? new Date().toISOString(),
  };
}

export default function OperatingLoopCard() {
  const [plan, setPlan] = useState<OperatingPlan>(EMPTY_PLAN);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await apiFetch<OperatingPlan | { plan?: Partial<OperatingPlan> | null }>(
        "/api/inbox/operating-plan",
      ).catch(() => EMPTY_PLAN);
      setPlan(normalizePlan(next));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener("conversations-updated", handler);
    return () => window.removeEventListener("conversations-updated", handler);
  }, [refresh]);

  if (loading && plan.metrics.length === 0) return null;
  if (!plan.headline && plan.nextMoves.length === 0 && plan.watchlist.length === 0) return null;

  return (
    <section
      className="panel-elevated mb-6 overflow-hidden rounded-2xl border border-line/70 bg-surface-panel"
      aria-label="Klorn operating loop"
    >
      <div className="border-b border-line-soft bg-gradient-to-br from-white via-white to-sky-50 p-4 md:p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-deep">
              Operating loop
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-ink">
              {modeLabel(plan.mode)}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-mid">
              {displayText(plan.headline)}
            </p>
          </div>
          <div className="grid grid-cols-4 overflow-hidden rounded-xl border border-line/70 bg-surface-panel shadow-[0_1px_2px_rgba(15,23,42,0.04)] md:min-w-[320px]">
            {plan.metrics.map((metric) => (
              <LoopMetric key={metric.label} metric={metric} />
            ))}
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-line bg-surface-raised px-3 py-2.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-dim">
            First move
          </p>
          <p className="mt-1 text-sm font-medium text-accent-deeper">
            {displayText(plan.primaryAction)}
          </p>
        </div>
      </div>

      <div className="grid gap-3 p-3 md:grid-cols-[1.4fr_1fr] md:p-4">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Next moves</h3>
            <span className="text-[11px] text-ink-mid">{plan.nextMoves.length}</span>
          </div>
          <ul className="space-y-2">
            {plan.nextMoves.map((move) => (
              <li key={move.id}>
                <MoveRow move={move} />
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-3">
          {plan.decisionPulse.latest.length > 0 && <DecisionPulseCard pulse={plan.decisionPulse} />}
          {plan.playbookNudge && (
            <div className="rounded-xl border border-line bg-surface-raised p-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-accent-deep">
                Playbook
              </p>
              <p className="mt-2 text-sm font-medium text-ink">{plan.playbookNudge.name}</p>
              <p className="mt-1 text-xs leading-5 text-ink-dim">
                {plan.playbookNudge.active ? "Active" : "Recommended"} · Confidence{" "}
                {Math.round(plan.playbookNudge.confidence * 100)}%
                {plan.playbookNudge.nextStep ? ` · ${plan.playbookNudge.nextStep}` : ""}
              </p>
            </div>
          )}
          {plan.watchlist.length > 0 && (
            <div className="rounded-xl border border-line bg-surface-raised p-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-dim">
                Watchlist
              </p>
              <ul className="mt-2 space-y-2">
                {plan.watchlist.map((context) => (
                  <WatchRow key={context.id} context={context} />
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function DecisionPulseCard({ pulse }: { pulse: OperatingPlanDecisionPulse }) {
  return (
    <div className="rounded-xl border border-line bg-surface-raised p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-state-ok-ink">
            Recent decisions
          </p>
          <p className="mt-1 text-xs text-ink-dim">Last {pulse.windowHours}h results</p>
        </div>
        <div className="shrink-0 text-right text-[11px] leading-5 text-ink-dim">
          <p>
            Done <span className="font-semibold text-state-ok-ink">{pulse.executed}</span>
          </p>
          <p>
            Rejected <span className="font-semibold text-ink-soft">{pulse.rejected}</span> · Failed{" "}
            <span className="font-semibold text-rose-600">{pulse.failed}</span>
          </p>
        </div>
      </div>
      <ul className="mt-3 space-y-2">
        {pulse.latest.map((outcome) => (
          <DecisionOutcomeRow key={outcome.id} outcome={outcome} />
        ))}
      </ul>
    </div>
  );
}

function DecisionOutcomeRow({ outcome }: { outcome: OperatingPlanOutcome }) {
  return (
    <li>
      <Link
        href={outcome.href ?? "/inbox"}
        className="block rounded-lg border border-line bg-surface-raised px-2.5 py-2 transition hover:border-emerald-300/25 hover:bg-surface-hover"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-xs font-medium text-ink-soft">
            {displayText(outcome.title)}
          </p>
          <span className={`shrink-0 text-[10px] ${outcomeStatusClass(outcome.status)}`}>
            {outcomeStatusLabel(outcome.status)}
          </span>
        </div>
        <p className="mt-1 truncate text-[11px] text-ink-mid">
          {outcome.toolName && outcome.toolName !== "decision" ? (
            <ToolName toolName={outcome.toolName} />
          ) : (
            "Decision"
          )}
          {outcome.result ? ` · ${outcome.result}` : ""}
        </p>
      </Link>
    </li>
  );
}

function MoveRow({ move }: { move: OperatingPlanMove }) {
  const chatHref = `/chat?prefill=${encodeURIComponent(displayText(move.prompt))}`;
  const body = (
    <article className="rounded-xl border border-line bg-surface-raised p-3 transition hover:border-accent-light/25 hover:bg-surface-hover">
      <div className="flex flex-wrap items-center gap-2">
        <ToneBadge tone={move.tone} label={displayText(move.label)} />
        <span className="text-[11px] text-ink-mid">{sourceLabel(move.source)}</span>
      </div>
      {move.href ? (
        <Link href={move.href} className="mt-2 block break-words text-sm font-medium text-ink">
          {displayText(move.title)}
        </Link>
      ) : (
        <p className="mt-2 break-words text-sm font-medium text-ink">{displayText(move.title)}</p>
      )}
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-ink-dim">{displayText(move.reason)}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href={chatHref}
          className="ease-strong rounded-lg bg-accent/10 px-2.5 py-1.5 text-xs font-medium text-accent-deeper ring-1 ring-inset ring-accent/20 transition duration-150 hover:bg-accent/15 active:scale-[0.97]"
        >
          Prepare thread
        </Link>
        {move.href && (
          <Link
            href={move.href}
            className="ease-strong rounded-lg border border-line bg-surface-panel/70 px-2.5 py-1.5 text-xs font-medium text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97]"
          >
            View source
          </Link>
        )}
      </div>
    </article>
  );
  return body;
}

function WatchRow({ context }: { context: OperatingPlanWatchContext }) {
  const body = (
    <div className="rounded-lg border border-line bg-surface-raised px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-medium text-ink-soft">
          {displayText(context.title)}
        </p>
        <span className="shrink-0 text-[10px] text-ink-mid">{riskLabel(context.risk)}</span>
      </div>
      <p className="mt-1 line-clamp-1 text-[11px] text-ink-mid">{displayText(context.reason)}</p>
    </div>
  );
  return context.href ? (
    <li>
      <Link href={context.href} className="block">
        {body}
      </Link>
    </li>
  ) : (
    <li>{body}</li>
  );
}

function LoopMetric({ metric }: { metric: OperatingPlanMetric }) {
  return (
    <div className="border-r border-line-soft px-2 py-2 last:border-r-0">
      <p className={`text-lg font-semibold tabular-nums ${metricColor(metric.tone)}`}>
        {metric.value}
      </p>
      <p className="mt-0.5 truncate text-[10px] text-ink-mid">{displayText(metric.label)}</p>
    </div>
  );
}

function displayText(value: string | null | undefined): string {
  return (value ?? "").replace(/\bEVE\b/g, "Klorn").replace(/\bEve\b/g, "Klorn");
}

function ToneBadge({ tone, label }: { tone: OperatingPlanTone; label: string }) {
  return (
    <span
      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ${toneClass(tone)}`}
    >
      {label}
    </span>
  );
}

function modeLabel(mode: OperatingPlan["mode"]): string {
  switch (mode) {
    case "clear_decisions":
      return "Decision clearing mode";
    case "recover_risk":
      return "Risk recovery mode";
    case "prepare_day":
      return "Day prep mode";
    case "maintain_flow":
      return "Maintain flow mode";
  }
}

function sourceLabel(source: OperatingPlanMove["source"]): string {
  switch (source) {
    case "attention":
      return "Decision card";
    case "work_context":
      return "Work graph";
    case "playbook":
      return "Playbook";
  }
}

function riskLabel(risk: OperatingPlanWatchContext["risk"]): string {
  if (risk === "high") return "High";
  if (risk === "medium") return "Medium";
  return "Low";
}

function outcomeStatusLabel(status: OperatingPlanOutcome["status"]): string {
  if (status === "executed") return "Done";
  if (status === "rejected") return "Rejected";
  return "Failed";
}

function outcomeStatusClass(status: OperatingPlanOutcome["status"]): string {
  if (status === "executed") return "text-state-ok-ink";
  if (status === "rejected") return "text-ink-dim";
  return "text-rose-600";
}

function toneClass(tone: OperatingPlanTone): string {
  if (tone === "critical") return "bg-rose-500/10 text-rose-600 ring-1 ring-inset ring-rose-500/20";
  if (tone === "warn")
    return "bg-amber-500/10 text-state-warn-ink ring-1 ring-inset ring-amber-500/20";
  return "bg-surface-hover text-ink-mid";
}

function metricColor(tone: OperatingPlanTone): string {
  if (tone === "critical") return "text-rose-600";
  if (tone === "warn") return "text-state-warn-ink";
  return "text-ink";
}
