import { db } from "../db.js";
import {
  listActivePlaybookIds,
  type PlaybookRecommendation,
  recommendPlaybooksFromGraph,
} from "../playbooks.js";
import type { AttentionItem, InboxSummary } from "./inbox-summary.js";
import { buildInboxSummary } from "./inbox-summary.js";
import {
  buildWorkGraphSummary,
  type WorkGraphContext,
  type WorkGraphSummary,
} from "./work-graph.js";

export type OperatingPlanMode =
  | "clear_decisions"
  | "recover_risk"
  | "prepare_day"
  | "maintain_flow";

export type OperatingPlanTone = "critical" | "warn" | "steady";

export interface OperatingPlanMetric {
  label: string;
  value: number;
  tone: OperatingPlanTone;
}

export interface OperatingPlanMove {
  id: string;
  title: string;
  reason: string;
  href: string | null;
  prompt: string;
  label: string;
  tone: OperatingPlanTone;
  source: "attention" | "work_context" | "playbook";
}

export interface OperatingPlanWatchContext {
  id: string;
  title: string;
  href: string | null;
  risk: WorkGraphContext["risk"];
  reason: string;
}

export interface OperatingPlanPlaybookNudge {
  id: string;
  name: string;
  active: boolean;
  confidence: number;
  nextStep: string | null;
}

export type OperatingPlanOutcomeStatus = "executed" | "rejected" | "failed";

export interface OperatingPlanOutcome {
  id: string;
  title: string;
  status: OperatingPlanOutcomeStatus;
  toolName: string;
  href: string;
  decidedAt: string;
  result: string | null;
}

export interface OperatingPlanDecisionPulse {
  windowHours: number;
  executed: number;
  rejected: number;
  failed: number;
  latest: OperatingPlanOutcome[];
}

export interface OperatingPlan {
  generatedAt: string;
  mode: OperatingPlanMode;
  headline: string;
  primaryAction: string;
  metrics: OperatingPlanMetric[];
  nextMoves: OperatingPlanMove[];
  watchlist: OperatingPlanWatchContext[];
  playbookNudge: OperatingPlanPlaybookNudge | null;
  decisionPulse: OperatingPlanDecisionPulse;
}

export async function buildOperatingPlan(userId: string, now = Date.now()): Promise<OperatingPlan> {
  const [inbox, graph, activeIds, decisionPulse] = await Promise.all([
    buildInboxSummary(userId, now),
    buildWorkGraphSummary(userId, { limit: 8, now }),
    listActivePlaybookIds(userId).catch(() => new Set<string>()),
    buildDecisionPulse(userId, now).catch(() => emptyDecisionPulse()),
  ]);
  const playbooks = recommendPlaybooksFromGraph(graph, { limit: 2 }, activeIds);
  return buildOperatingPlanFromSignals({
    inbox,
    graph,
    recommendations: playbooks.recommendations,
    decisionPulse,
    now,
  });
}

export function buildOperatingPlanFromSignals(input: {
  inbox: InboxSummary;
  graph: WorkGraphSummary;
  recommendations?: PlaybookRecommendation[];
  decisionPulse?: OperatingPlanDecisionPulse;
  now?: number;
}): OperatingPlan {
  const now = input.now ?? Date.now();
  const highRiskContexts = input.graph.contexts.filter((context) => context.risk === "high");
  const mediumRiskContexts = input.graph.contexts.filter((context) => context.risk === "medium");
  const pendingDecisionCount = input.inbox.top3.filter(
    (item) => item.kind === "pending_action",
  ).length;
  const overdueCount =
    input.inbox.top3.filter(
      (item) =>
        item.kind === "overdue_task" ||
        (item.kind === "commitment" && item.attentionType === "COMMITMENT_OVERDUE"),
    ).length + input.inbox.today.overdueTasks.length;
  const todayCount = input.inbox.today.events.length + input.inbox.today.todayTasks.length;
  const mode = modeFor({
    pendingDecisionCount,
    highRiskCount: highRiskContexts.length,
    overdueCount,
    todayCount,
  });

  const attentionMoves = input.inbox.top3.map(moveFromAttention);
  const contextMoves = [...highRiskContexts, ...mediumRiskContexts]
    .map(moveFromContext)
    .filter(
      (move) => !attentionMoves.some((existing) => existing.href && existing.href === move.href),
    );
  const playbookMove = moveFromPlaybook(input.recommendations?.[0] ?? null);
  const nextMoves = [
    ...attentionMoves,
    ...contextMoves,
    ...(playbookMove ? [playbookMove] : []),
  ].slice(0, 4);

  return {
    generatedAt: new Date(now).toISOString(),
    mode,
    headline: headlineFor(mode),
    primaryAction: primaryActionFor(mode, nextMoves),
    metrics: [
      {
        label: "Decisions",
        value: pendingDecisionCount,
        tone: pendingDecisionCount ? "critical" : "steady",
      },
      {
        label: "Risk",
        value: highRiskContexts.length,
        tone: highRiskContexts.length ? "warn" : "steady",
      },
      { label: "Overdue", value: overdueCount, tone: overdueCount ? "critical" : "steady" },
      { label: "Today", value: todayCount, tone: todayCount ? "warn" : "steady" },
    ],
    nextMoves,
    watchlist: [...highRiskContexts, ...mediumRiskContexts].slice(0, 3).map(watchFromContext),
    playbookNudge: nudgeFromPlaybook(input.recommendations?.[0] ?? null),
    decisionPulse: input.decisionPulse ?? emptyDecisionPulse(),
  };
}

const DECISION_PULSE_WINDOW_HOURS = 24;

type PendingActionOutcomeRow = {
  id: string;
  conversationId: string;
  status: "EXECUTED" | "REJECTED" | "FAILED";
  toolName: string;
  reasoning: string | null;
  result: string | null;
  updatedAt: Date;
  conversation?: { title: string | null } | null;
};

async function buildDecisionPulse(
  userId: string,
  now: number,
): Promise<OperatingPlanDecisionPulse> {
  const since = new Date(now - DECISION_PULSE_WINDOW_HOURS * 60 * 60 * 1000);
  const rows = (await db.pendingAction.findMany({
    where: {
      userId,
      status: { in: ["EXECUTED", "REJECTED", "FAILED"] },
      updatedAt: { gte: since },
    },
    orderBy: { updatedAt: "desc" },
    take: 12,
    include: {
      conversation: { select: { title: true } },
    },
  })) as PendingActionOutcomeRow[];

  return {
    windowHours: DECISION_PULSE_WINDOW_HOURS,
    executed: rows.filter((row) => row.status === "EXECUTED").length,
    rejected: rows.filter((row) => row.status === "REJECTED").length,
    failed: rows.filter((row) => row.status === "FAILED").length,
    latest: rows.slice(0, 5).map(outcomeFromPendingAction),
  };
}

function emptyDecisionPulse(): OperatingPlanDecisionPulse {
  return {
    windowHours: DECISION_PULSE_WINDOW_HOURS,
    executed: 0,
    rejected: 0,
    failed: 0,
    latest: [],
  };
}

function outcomeFromPendingAction(row: PendingActionOutcomeRow): OperatingPlanOutcome {
  return {
    id: row.id,
    title: outcomeTitle(row),
    status: outcomeStatus(row.status),
    toolName: row.toolName,
    href: `/chat/${row.conversationId}`,
    decidedAt: row.updatedAt.toISOString(),
    result: previewText(row.result),
  };
}

function outcomeStatus(status: PendingActionOutcomeRow["status"]): OperatingPlanOutcomeStatus {
  if (status === "EXECUTED") return "executed";
  if (status === "REJECTED") return "rejected";
  return "failed";
}

function outcomeTitle(row: PendingActionOutcomeRow): string {
  const reasoning = previewText(row.reasoning);
  if (reasoning) return reasoning.replace(/^[📋💡✅]\s*/u, "");
  return row.conversation?.title || row.toolName.replace(/_/g, " ");
}

function previewText(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function modeFor(input: {
  pendingDecisionCount: number;
  highRiskCount: number;
  overdueCount: number;
  todayCount: number;
}): OperatingPlanMode {
  if (input.pendingDecisionCount > 0) return "clear_decisions";
  if (input.highRiskCount > 0 || input.overdueCount > 0) return "recover_risk";
  if (input.todayCount > 0) return "prepare_day";
  return "maintain_flow";
}

function headlineFor(mode: OperatingPlanMode): string {
  switch (mode) {
    case "clear_decisions":
      return "Clear the decisions waiting for approval first.";
    case "recover_risk":
      return "Recover the work contexts that are drifting into risk.";
    case "prepare_day":
      return "The day is ordered around meetings and due work.";
    case "maintain_flow":
      return "No major fires. Clean up the open commitments quietly.";
  }
}

function primaryActionFor(mode: OperatingPlanMode, moves: OperatingPlanMove[]): string {
  if (moves[0]) return moves[0].title;
  if (mode === "maintain_flow") return "Klorn will refresh the plan when new signals arrive.";
  return "Start with the first decision card.";
}

function moveFromAttention(item: AttentionItem): OperatingPlanMove {
  const title = attentionTitle(item);
  const reason =
    item.decision.suggestedAction ||
    item.decision.costOfIgnoring ||
    item.decision.evidence[0]?.value ||
    "Klorn ranked this as the signal to handle now.";
  return {
    id: `attention:${item.kind}:${item.id}`,
    title,
    reason,
    href: attentionHref(item),
    prompt: promptForMove({
      title,
      reason,
      label: attentionLabel(item),
      href: attentionHref(item),
      source: "Decision Card",
    }),
    label: attentionLabel(item),
    tone: attentionTone(item),
    source: "attention",
  };
}

function moveFromContext(context: WorkGraphContext): OperatingPlanMove {
  return {
    id: `context:${context.id}`,
    title: context.title,
    reason: context.reasons[0] || "Multiple signals are tied to the same work context.",
    href: context.href,
    prompt: promptForMove({
      title: context.title,
      reason: context.reasons[0] || "Multiple signals are tied to the same work context.",
      label: context.risk === "high" ? "Risk context" : "Watch context",
      href: context.href,
      source: "Work Graph",
    }),
    label: context.risk === "high" ? "Risk context" : "Watch context",
    tone: context.risk === "high" ? "warn" : "steady",
    source: "work_context",
  };
}

function moveFromPlaybook(recommendation: PlaybookRecommendation | null): OperatingPlanMove | null {
  if (!recommendation || recommendation.score <= 0) return null;
  const step = recommendation.suggestedFirstActions[0];
  return {
    id: `playbook:${recommendation.playbook.id}`,
    title: step?.title || `Review ${recommendation.playbook.name}`,
    reason: recommendation.reasons[0] || recommendation.playbook.bestFor,
    href: null,
    prompt: promptForMove({
      title: step?.title || `Review ${recommendation.playbook.name}`,
      reason: recommendation.reasons[0] || recommendation.playbook.bestFor,
      label: recommendation.playbook.active ? "Active playbook" : "Recommended playbook",
      href: null,
      source: recommendation.playbook.name,
    }),
    label: recommendation.playbook.active ? "Active playbook" : "Recommended playbook",
    tone: recommendation.playbook.active ? "warn" : "steady",
    source: "playbook",
  };
}

function promptForMove(input: {
  title: string;
  reason: string;
  label: string;
  href: string | null;
  source: string;
}): string {
  const location = input.href ? `\nSource link: ${input.href}` : "";
  return [
    `The Operating Loop picked "${input.title}" as the next move.`,
    `Category: ${input.label}`,
    `Source: ${input.source}`,
    `Reason: ${input.reason}${location}`,
    "Turn this into an approval-ready decision card with any needed draft, checklist, and risk notes.",
  ].join("\n");
}

function watchFromContext(context: WorkGraphContext): OperatingPlanWatchContext {
  return {
    id: context.id,
    title: context.title,
    href: context.href,
    risk: context.risk,
    reason: context.reasons[0] || "Recent activity and open signals are present.",
  };
}

function nudgeFromPlaybook(
  recommendation: PlaybookRecommendation | null,
): OperatingPlanPlaybookNudge | null {
  if (!recommendation || recommendation.score <= 0) return null;
  return {
    id: recommendation.playbook.id,
    name: recommendation.playbook.name,
    active: Boolean(recommendation.playbook.active),
    confidence: recommendation.confidence,
    nextStep: recommendation.suggestedFirstActions[0]?.title ?? null,
  };
}

function attentionTitle(item: AttentionItem): string {
  switch (item.kind) {
    case "pending_action":
      return item.label;
    case "overdue_task":
      return item.title;
    case "today_event":
      return item.title;
    case "agent_proposal":
      return item.title.replace(/^\[EVE\]\s*/, "");
    case "commitment":
      return item.title;
  }
}

function attentionHref(item: AttentionItem): string | null {
  switch (item.kind) {
    case "pending_action":
      return `/chat/${item.conversationId}`;
    case "today_event":
      return "/calendar";
    case "agent_proposal":
      return item.link;
    case "overdue_task":
    case "commitment":
      return null;
  }
}

function attentionLabel(item: AttentionItem): string {
  switch (item.kind) {
    case "pending_action":
      return "Needs approval";
    case "overdue_task":
      return "Overdue work";
    case "today_event":
      return "Today";
    case "agent_proposal":
      return "Decision proposal";
    case "commitment":
      return item.attentionType === "COMMITMENT_OVERDUE" ? "Overdue commitment" : "Commitment";
  }
}

function attentionTone(item: AttentionItem): OperatingPlanTone {
  if (item.kind === "pending_action" || item.kind === "overdue_task") return "critical";
  if (item.kind === "commitment" && item.attentionType === "COMMITMENT_OVERDUE") return "critical";
  if (item.kind === "today_event") return "warn";
  return "steady";
}
