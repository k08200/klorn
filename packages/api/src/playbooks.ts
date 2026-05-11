/**
 * Jigeum Playbooks v0.
 *
 * Built-in operating patterns for recurring domains. v0 is intentionally
 * read-only: it recommends playbooks from the user's Work Graph without
 * activating automations or creating durable playbook state.
 */

import { prisma } from "./db.js";
import {
  buildWorkGraphSummary,
  type WorkGraphContext,
  type WorkGraphSummary,
} from "./work-graph.js";

export type JigeumPlaybookId =
  | "investment_ops"
  | "customer_success"
  | "launch_room"
  | "hiring_pipeline";

export type JigeumPlaybookDomain = "investment" | "customer_success" | "launch" | "hiring";

export interface PlaybookStep {
  id: string;
  title: string;
  description: string;
}

interface PlaybookDefinition {
  id: JigeumPlaybookId;
  domain: JigeumPlaybookDomain;
  name: string;
  description: string;
  bestFor: string;
  cadence: string;
  targetSignals: string[];
  keywords: string[];
  activationChecklist: PlaybookStep[];
}

export interface JigeumPlaybook {
  id: JigeumPlaybookId;
  domain: JigeumPlaybookDomain;
  name: string;
  description: string;
  bestFor: string;
  cadence: string;
  targetSignals: string[];
  activationChecklist: PlaybookStep[];
  active?: boolean;
}

export interface PlaybookContextHit {
  id: string;
  kind: WorkGraphContext["kind"];
  title: string;
  href: string | null;
  risk: WorkGraphContext["risk"];
  lastActivityAt: string;
  reasons: string[];
  matchedKeywords: string[];
  signalScore: number;
}

export interface PlaybookRecommendation {
  playbook: JigeumPlaybook;
  score: number;
  confidence: number;
  reasons: string[];
  activeContexts: PlaybookContextHit[];
  suggestedFirstActions: PlaybookStep[];
}

export interface PlaybookRecommendationSummary {
  generatedAt: string;
  playbooks: JigeumPlaybook[];
  recommendations: PlaybookRecommendation[];
}

export interface PlaybookRecommendationOptions {
  limit?: number;
  contextLimit?: number;
  now?: number;
}

const PLAYBOOKS: PlaybookDefinition[] = [
  {
    id: "investment_ops",
    domain: "investment",
    name: "Investor Ops",
    description:
      "Keep fundraising, investor updates, board follow-ups, and diligence threads warm.",
    bestFor: "fundraising, board updates, investor relations, diligence",
    cadence: "Weekly signal review, monthly update pack, same-day investor follow-up",
    targetSignals: ["investor threads", "board follow-ups", "fundraising commitments"],
    keywords: [
      "investor",
      "investment",
      "fundraising",
      "fundraise",
      "vc",
      "venture",
      "board",
      "diligence",
      "series",
      "seed",
      "runway",
      "투자",
      "투자자",
      "주주",
      "이사회",
      "펀딩",
      "실사",
    ],
    activationChecklist: [
      {
        id: "investor-top-risks",
        title: "Review investor-facing risks",
        description:
          "Check unread, urgent, overdue, and approval-needed contexts before responding.",
      },
      {
        id: "investor-update-pack",
        title: "Prepare update pack",
        description: "Collect wins, metrics, asks, and open promises into one draftable packet.",
      },
      {
        id: "investor-follow-ups",
        title: "Close follow-ups",
        description: "Turn loose promises into tracked commitments with owners and due dates.",
      },
    ],
  },
  {
    id: "customer_success",
    domain: "customer_success",
    name: "Customer Success Recovery",
    description: "Protect renewals, escalations, and support-heavy customer threads.",
    bestFor: "high-touch customers, escalations, renewals, churn risk",
    cadence: "Daily escalation scan, renewal follow-up, weekly customer health review",
    targetSignals: ["customer escalations", "renewal threads", "unread support mail"],
    keywords: [
      "customer",
      "client",
      "support",
      "escalation",
      "renewal",
      "renew",
      "churn",
      "sla",
      "contract",
      "invoice",
      "bug",
      "outage",
      "고객",
      "문의",
      "지원",
      "장애",
      "계약",
      "갱신",
      "이탈",
    ],
    activationChecklist: [
      {
        id: "cs-escalation-scan",
        title: "Scan unresolved escalations",
        description: "Prioritize urgent, unread, and overdue customer contexts.",
      },
      {
        id: "cs-renewal-map",
        title: "Map renewal promises",
        description:
          "List commitments, blockers, and next-owner follow-ups for renewal-sensitive accounts.",
      },
      {
        id: "cs-response-drafts",
        title: "Draft recovery responses",
        description: "Prepare calm, specific replies that acknowledge status and next action.",
      },
    ],
  },
  {
    id: "launch_room",
    domain: "launch",
    name: "Launch Room",
    description: "Coordinate launch, release, beta, marketing, and announcement work.",
    bestFor: "product launches, beta releases, campaigns, public announcements",
    cadence: "Daily launch risk scan, launch-day command center, next-day cleanup",
    targetSignals: ["launch threads", "release approvals", "campaign follow-ups"],
    keywords: [
      "launch",
      "release",
      "beta",
      "announce",
      "announcement",
      "campaign",
      "waitlist",
      "product hunt",
      "press",
      "go-to-market",
      "gtm",
      "출시",
      "런칭",
      "릴리즈",
      "배포",
      "베타",
      "캠페인",
      "공지",
    ],
    activationChecklist: [
      {
        id: "launch-blockers",
        title: "Find launch blockers",
        description: "Surface approvals, overdue promises, and urgent unread launch threads.",
      },
      {
        id: "launch-message-pack",
        title: "Assemble message pack",
        description:
          "Collect announcement copy, audience segments, and promised delivery artifacts.",
      },
      {
        id: "launch-cleanup",
        title: "Schedule cleanup loop",
        description: "Track post-launch follow-ups, unanswered replies, and handoffs.",
      },
    ],
  },
  {
    id: "hiring_pipeline",
    domain: "hiring",
    name: "Hiring Pipeline",
    description: "Keep candidate, recruiter, interview, offer, and onboarding loops moving.",
    bestFor: "candidate pipelines, interview loops, offers, recruiter coordination",
    cadence: "Daily candidate scan, interview-day prep, end-of-week pipeline cleanup",
    targetSignals: ["candidate threads", "interview commitments", "offer follow-ups"],
    keywords: [
      "hiring",
      "candidate",
      "interview",
      "recruiter",
      "recruiting",
      "offer",
      "onboarding",
      "resume",
      "cv",
      "role",
      "job",
      "채용",
      "후보자",
      "면접",
      "리크루터",
      "오퍼",
      "온보딩",
      "이력서",
    ],
    activationChecklist: [
      {
        id: "hiring-next-candidates",
        title: "Prioritize candidate loops",
        description:
          "Find candidate threads with overdue, urgent, unread, or approval-needed signals.",
      },
      {
        id: "hiring-interview-pack",
        title: "Prepare interview pack",
        description: "Collect context, role notes, next questions, and outstanding commitments.",
      },
      {
        id: "hiring-offer-followup",
        title: "Track offers and handoffs",
        description: "Make offer-stage promises and next steps explicit before they go stale.",
      },
    ],
  },
];

export function listJigeumPlaybooks(activeIds: Set<string> = new Set()): JigeumPlaybook[] {
  return PLAYBOOKS.map((playbook) => publicPlaybook(playbook, activeIds));
}

export async function listActivePlaybookIds(userId: string): Promise<Set<string>> {
  const model = (
    prisma as unknown as {
      activatedPlaybook?: { findMany: (args: unknown) => Promise<unknown> };
    }
  ).activatedPlaybook;
  if (!model) return new Set();
  const rows = (await model.findMany({
    where: { userId, status: "ACTIVE" },
    select: { playbookId: true },
  })) as Array<{ playbookId: string }>;
  return new Set(rows.map((row) => row.playbookId));
}

export async function activatePlaybook(
  userId: string,
  playbookId: string,
): Promise<JigeumPlaybook> {
  const definition = PLAYBOOKS.find((playbook) => playbook.id === playbookId);
  if (!definition) throw new Error(`Unknown playbook: ${playbookId}`);
  const model = (
    prisma as unknown as {
      activatedPlaybook?: { upsert: (args: unknown) => Promise<unknown> };
    }
  ).activatedPlaybook;
  if (!model) throw new Error("ActivatedPlaybook model is not available");
  await model.upsert({
    where: { userId_playbookId: { userId, playbookId } },
    create: { userId, playbookId, status: "ACTIVE" },
    update: { status: "ACTIVE" },
  });
  return publicPlaybook(definition, new Set([playbookId]));
}

export async function deactivatePlaybook(userId: string, playbookId: string): Promise<void> {
  const model = (
    prisma as unknown as {
      activatedPlaybook?: { updateMany: (args: unknown) => Promise<unknown> };
    }
  ).activatedPlaybook;
  if (!model) return;
  await model.updateMany({
    where: { userId, playbookId },
    data: { status: "PAUSED" },
  });
}

export async function buildPlaybookRecommendations(
  userId: string,
  opts: PlaybookRecommendationOptions = {},
): Promise<PlaybookRecommendationSummary> {
  const graph = await buildWorkGraphSummary(userId, {
    limit: opts.contextLimit ?? 20,
    now: opts.now,
  });
  const activeIds = await listActivePlaybookIds(userId).catch(() => new Set<string>());
  return recommendPlaybooksFromGraph(graph, opts, activeIds);
}

export function recommendPlaybooksFromGraph(
  graph: WorkGraphSummary,
  opts: Pick<PlaybookRecommendationOptions, "limit"> = {},
  activeIds: Set<string> = new Set(),
): PlaybookRecommendationSummary {
  const limit = normalizeLimit(opts.limit);
  const recommendations = PLAYBOOKS.map((playbook) =>
    scorePlaybook(playbook, graph.contexts, activeIds),
  )
    .filter((recommendation) => recommendation.score > 0 || recommendation.playbook.active)
    .sort(compareRecommendations)
    .slice(0, limit);

  return {
    generatedAt: graph.generatedAt,
    playbooks: listJigeumPlaybooks(activeIds),
    recommendations,
  };
}

function scorePlaybook(
  definition: PlaybookDefinition,
  contexts: WorkGraphContext[],
  activeIds: Set<string>,
): PlaybookRecommendation {
  const hits = contexts
    .map((context) => scoreContext(definition, context))
    .filter((hit): hit is PlaybookContextHit => hit !== null)
    .sort(compareContextHits)
    .slice(0, 3);
  const score = Math.min(
    100,
    hits.reduce((sum, hit) => sum + hit.signalScore, 0) + (activeIds.has(definition.id) ? 12 : 0),
  );
  return {
    playbook: publicPlaybook(definition, activeIds),
    score,
    confidence: confidenceFor(score, hits.length),
    reasons: activeIds.has(definition.id)
      ? ["Activated by user", ...reasonsFor(hits)].slice(0, 4)
      : reasonsFor(hits),
    activeContexts: hits,
    suggestedFirstActions: definition.activationChecklist.slice(0, 2),
  };
}

function scoreContext(
  definition: PlaybookDefinition,
  context: WorkGraphContext,
): PlaybookContextHit | null {
  const haystack = contextText(context);
  const matchedKeywords = definition.keywords.filter((keyword) => haystack.includes(keyword));
  if (matchedKeywords.length === 0) return null;

  const signalScore =
    10 +
    Math.min(matchedKeywords.length, 4) * 3 +
    riskScore(context.risk) +
    Math.min(context.signals.pendingActions, 2) * 4 +
    Math.min(context.signals.overdueCommitments, 2) * 4 +
    Math.min(context.signals.commitments, 3) * 2 +
    Math.min(context.signals.urgentEmails, 2) * 3 +
    Math.min(context.signals.unreadEmails, 3);

  return {
    id: context.id,
    kind: context.kind,
    title: context.title,
    href: context.href,
    risk: context.risk,
    lastActivityAt: context.lastActivityAt,
    reasons: context.reasons.slice(0, 3),
    matchedKeywords: matchedKeywords.slice(0, 4),
    signalScore,
  };
}

function contextText(context: WorkGraphContext): string {
  const people = context.people
    .map((person) => `${person.name ?? ""} ${person.email ?? ""}`.trim())
    .join(" ");
  return [context.title, context.subtitle, context.kind, context.reasons.join(" "), people]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function publicPlaybook(definition: PlaybookDefinition, activeIds: Set<string>): JigeumPlaybook {
  return {
    id: definition.id,
    domain: definition.domain,
    name: definition.name,
    description: definition.description,
    bestFor: definition.bestFor,
    cadence: definition.cadence,
    targetSignals: definition.targetSignals,
    activationChecklist: definition.activationChecklist,
    active: activeIds.has(definition.id),
  };
}

function reasonsFor(hits: PlaybookContextHit[]): string[] {
  const reasons = new Set<string>();
  for (const hit of hits) {
    if (hit.risk === "high") reasons.add("High-risk matching context");
    if (hit.risk === "medium") reasons.add("Medium-risk matching context");
    for (const reason of hit.reasons) reasons.add(reason);
  }
  return Array.from(reasons).slice(0, 4);
}

function compareRecommendations(a: PlaybookRecommendation, b: PlaybookRecommendation): number {
  if (a.playbook.active !== b.playbook.active) return a.playbook.active ? -1 : 1;
  if (b.score !== a.score) return b.score - a.score;
  return b.confidence - a.confidence;
}

function compareContextHits(a: PlaybookContextHit, b: PlaybookContextHit): number {
  if (b.signalScore !== a.signalScore) return b.signalScore - a.signalScore;
  return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
}

function riskScore(risk: WorkGraphContext["risk"]): number {
  if (risk === "high") return 8;
  if (risk === "medium") return 4;
  return 0;
}

function confidenceFor(score: number, hitCount: number): number {
  if (score <= 0 || hitCount === 0) return 0;
  const raw = 0.35 + score / 120 + Math.min(hitCount, 3) * 0.05;
  return Math.round(Math.min(0.95, raw) * 100) / 100;
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) return 4;
  return Math.min(Math.floor(limit), 8);
}
