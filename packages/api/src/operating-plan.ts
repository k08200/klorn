import { db } from "./db.js";
import type { AttentionItem, InboxSummary } from "./inbox-summary.js";
import { buildInboxSummary } from "./inbox-summary.js";
import {
  listActivePlaybookIds,
  type PlaybookRecommendation,
  recommendPlaybooksFromGraph,
} from "./playbooks.js";
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
        label: "결정",
        value: pendingDecisionCount,
        tone: pendingDecisionCount ? "critical" : "steady",
      },
      {
        label: "위험 맥락",
        value: highRiskContexts.length,
        tone: highRiskContexts.length ? "warn" : "steady",
      },
      { label: "지난 항목", value: overdueCount, tone: overdueCount ? "critical" : "steady" },
      { label: "오늘 신호", value: todayCount, tone: todayCount ? "warn" : "steady" },
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
      return "먼저 승인 대기 결정을 비우면 오늘 루프가 풀립니다.";
    case "recover_risk":
      return "위험해진 업무 맥락을 먼저 회수해야 합니다.";
    case "prepare_day":
      return "오늘 일정과 마감 기준으로 실행 순서를 잡았습니다.";
    case "maintain_flow":
      return "큰 화재는 없고, 열린 약속을 조용히 정리할 차례입니다.";
  }
}

function primaryActionFor(mode: OperatingPlanMode, moves: OperatingPlanMove[]): string {
  if (moves[0]) return moves[0].title;
  if (mode === "maintain_flow") return "새 신호가 들어오면 Jigeum이 다시 운영 계획을 갱신합니다.";
  return "상단 결정 카드부터 확인하세요.";
}

function moveFromAttention(item: AttentionItem): OperatingPlanMove {
  const title = attentionTitle(item);
  const reason =
    item.decision.suggestedAction ||
    item.decision.costOfIgnoring ||
    item.decision.evidence[0]?.value ||
    "Jigeum이 지금 처리할 우선 신호로 판단했습니다.";
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
    reason: context.reasons[0] || "여러 신호가 같은 업무 맥락으로 묶였습니다.",
    href: context.href,
    prompt: promptForMove({
      title: context.title,
      reason: context.reasons[0] || "여러 신호가 같은 업무 맥락으로 묶였습니다.",
      label: context.risk === "high" ? "위험 맥락" : "관찰 맥락",
      href: context.href,
      source: "Work Graph",
    }),
    label: context.risk === "high" ? "위험 맥락" : "관찰 맥락",
    tone: context.risk === "high" ? "warn" : "steady",
    source: "work_context",
  };
}

function moveFromPlaybook(recommendation: PlaybookRecommendation | null): OperatingPlanMove | null {
  if (!recommendation || recommendation.score <= 0) return null;
  const step = recommendation.suggestedFirstActions[0];
  return {
    id: `playbook:${recommendation.playbook.id}`,
    title: step?.title || `${recommendation.playbook.name} 실행 점검`,
    reason: recommendation.reasons[0] || recommendation.playbook.bestFor,
    href: null,
    prompt: promptForMove({
      title: step?.title || `${recommendation.playbook.name} 실행 점검`,
      reason: recommendation.reasons[0] || recommendation.playbook.bestFor,
      label: recommendation.playbook.active ? "활성 Playbook" : "추천 Playbook",
      href: null,
      source: recommendation.playbook.name,
    }),
    label: recommendation.playbook.active ? "활성 Playbook" : "추천 Playbook",
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
  const location = input.href ? `\n관련 위치: ${input.href}` : "";
  return [
    `Operating Loop에서 "${input.title}"를 다음 움직임으로 골랐어.`,
    `분류: ${input.label}`,
    `출처: ${input.source}`,
    `근거: ${input.reason}${location}`,
    "이걸 실행 전 승인 가능한 결정 카드로 정리하고, 필요한 초안/체크리스트/리스크를 만들어줘.",
  ].join("\n");
}

function watchFromContext(context: WorkGraphContext): OperatingPlanWatchContext {
  return {
    id: context.id,
    title: context.title,
    href: context.href,
    risk: context.risk,
    reason: context.reasons[0] || "최근 활동과 열린 신호가 있습니다.",
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
      return "승인 필요";
    case "overdue_task":
      return "지난 일";
    case "today_event":
      return "오늘 일정";
    case "agent_proposal":
      return "결정 제안";
    case "commitment":
      return item.attentionType === "COMMITMENT_OVERDUE" ? "지난 약속" : "약속";
  }
}

function attentionTone(item: AttentionItem): OperatingPlanTone {
  if (item.kind === "pending_action" || item.kind === "overdue_task") return "critical";
  if (item.kind === "commitment" && item.attentionType === "COMMITMENT_OVERDUE") return "critical";
  if (item.kind === "today_event") return "warn";
  return "steady";
}
