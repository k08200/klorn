/**
 * Autonomous Agent — Eve's proactive reasoning brain
 *
 * Unlike background.ts (simple cron checks) and automation-scheduler.ts (rule-based),
 * this agent uses LLM reasoning to analyze user state and take intelligent actions.
 *
 * Flow (every N minutes per user, configurable):
 * 1. Gather full user context (tasks, calendar, emails, notes, reminders, contacts)
 * 2. Send context + available tools to LLM
 * 3. LLM reasons about what needs attention and what actions to take
 * 4. Execute actions or send smart notifications with reasoning
 * 5. Log all decisions to AgentLog for transparency
 *
 * Modes:
 * - SHADOW: Prepares proposals quietly in Inbox/Command Center
 * - SUGGEST: Sends approval proposals and alerts
 * - AUTO: Executes low-risk actions automatically, gates everything else
 */

/**
 * Typed accessor for Prisma models that exist in the schema but may not
 * yet appear in the generated client typings (AgentLog, PendingAction,
 * TokenUsage, Conversation, Message, etc.).
 *
 * Uses `never[]` for args so callers don't need explicit casts, and
 * `Promise<{ [k: string]: unknown }>` so returned objects support property access.
 */
import type OpenAI from "openai";
import { resolveActionTarget } from "./action-target.js";
import { AGENT_SYSTEM_PROMPT, NOTIFY_TOOL, PROPOSE_ACTION_TOOL } from "./agent/prompt.js";
import { recordDedupKey, wasRecentlyDeduped } from "./agent-dedup.js";
import {
  areSimilarProposalIssues,
  getNotifKey,
  getToolRisk,
  isHousekeepingProposalToolName,
  proposalIssueTokens,
  TOOL_RISK_LEVELS,
} from "./agent-logic.js";
import { type AgentMode, getAgentModePolicy, normalizeAgentMode } from "./agent-mode.js";
import {
  bulkResolveAttentionForPendingActions,
  upsertAttentionForPendingAction,
} from "./attention-mirror.js";
import { db, prisma } from "./db.js";
import { recipientFromToolArgs, recordFeedback } from "./feedback.js";
import { isNoReplyAddress, markAsRead } from "./gmail.js";
import { loadMemoriesForPrompt } from "./memory.js";
import { estimateModelCostUsd } from "./model-fallback.js";
import { humanizeAutoExec } from "./notification-format.js";
import type { NotifCategory } from "./notification-prefs.js";
import { AGENT_MODEL, createCompletion, openai, resolveUserAgentModel } from "./openai.js";
import { getFeedbackPolicyContextForPrompt } from "./policy-extraction.js";
import { sendPushNotification } from "./push.js";
import { captureError } from "./sentry.js";
import { planHasFeature } from "./stripe.js";
import { ALL_TOOLS, executeToolCall, isToolAllowedForPlan } from "./tool-executor.js";
import { wrapUntrusted } from "./untrusted.js";
import { pushNotification } from "./websocket.js";

const CHECK_INTERVAL_MS = 60 * 1000; // Check every 1 minute (respects per-user intervals)
const MAX_TOOL_CALLS = 10;
const MAX_CONTEXT_ITEMS = 10;
const CONCURRENCY_LIMIT = 5; // Max users to run concurrently

/**
 * Risk-based tool classification for AUTO mode execution gating.
 *
 * LOW  → auto-execute immediately, notify user after
 * MEDIUM → intercept and create approval proposal (propose_action style)
 * HIGH → intercept and create approval proposal with explicit warning
 */
// Risk classification and notification key logic live in agent-logic.ts
// so they can be imported without pulling in the full agent runtime.
export {
  areSimilarProposalIssues,
  getNotifKey,
  getToolRisk,
  type RiskLevel,
  TOOL_RISK_LEVELS,
} from "./agent-logic.js";

let intervalId: ReturnType<typeof setInterval> | null = null;

// Track last run per user to respect per-user interval
const lastRunTime = new Map<string, number>();

// DB-based dedup: check if a similar notification was sent recently
// Survives server restarts (unlike previous in-memory Map approach)
const NOTIFY_DEDUP_HOURS = 2; // Don't repeat same notification within 2 hours
const PROPOSAL_DEDUP_HOURS = 24; // Don't re-propose the same underlying issue within a day
const CONTEXT_SUPPRESSION_HOURS = 24; // Hide recently-proposed topics before the LLM sees context
const AGENT_NOTIFICATION_PREFIX = "[Jigeum]";
const EVE_AGENT_NOTIFICATION_PREFIX = "[Eve]";
const LEGACY_AGENT_NOTIFICATION_PREFIX = "[EV" + "E]";
const EXECUTABLE_TOOL_NAMES = new Set(
  ALL_TOOLS.map((tool) => (tool as { function?: { name?: string } }).function?.name).filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  ),
);

async function hasRecentNotification(userId: string, titleKey: string): Promise<boolean> {
  const since = new Date(Date.now() - NOTIFY_DEDUP_HOURS * 60 * 60 * 1000);
  const existing = await prisma.notification.findFirst({
    where: {
      userId,
      OR: [
        { title: { startsWith: AGENT_NOTIFICATION_PREFIX } },
        { title: { startsWith: EVE_AGENT_NOTIFICATION_PREFIX } },
        { title: { startsWith: LEGACY_AGENT_NOTIFICATION_PREFIX } },
      ],
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
  });
  // Check recent Jigeum notifications for similar title.
  if (!existing) return false;
  const recentNotifs = await prisma.notification.findMany({
    where: {
      userId,
      OR: [
        { title: { startsWith: AGENT_NOTIFICATION_PREFIX } },
        { title: { startsWith: EVE_AGENT_NOTIFICATION_PREFIX } },
        { title: { startsWith: LEGACY_AGENT_NOTIFICATION_PREFIX } },
      ],
      createdAt: { gte: since },
    },
    select: { title: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return recentNotifs.some((n) => getNotifKey(n.title) === titleKey);
}

async function findRecentSimilarProposal(
  userId: string,
  proposed: { message: string; toolName: string; toolArgs: unknown },
): Promise<{ id: string; toolName: string; status: string; createdAt: Date } | null> {
  const since = new Date(Date.now() - PROPOSAL_DEDUP_HOURS * 60 * 60 * 1000);
  const recentRows = (await db.pendingAction.findMany({
    where: {
      userId,
      status: { in: ["PENDING", "REJECTED", "EXECUTED"] },
      createdAt: { gte: since },
    },
    select: {
      id: true,
      toolName: true,
      toolArgs: true,
      reasoning: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 80,
  })) as Array<{
    id: string;
    toolName: string;
    toolArgs: string;
    reasoning: string | null;
    status: string;
    createdAt: Date;
  }>;

  for (const row of recentRows) {
    if (
      areSimilarProposalIssues(proposed, {
        message: row.reasoning ?? "",
        toolName: row.toolName,
        toolArgs: safeJson(row.toolArgs),
      })
    ) {
      return row;
    }
  }

  return null;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return raw;
  }
}

interface RecentProposalSuppression {
  id: string;
  toolName: string;
  status: string;
  createdAt: Date;
  message: string;
  toolArgs: unknown;
  tokens: Set<string>;
}

async function getRecentProposalSuppressions(userId: string): Promise<RecentProposalSuppression[]> {
  const since = new Date(Date.now() - CONTEXT_SUPPRESSION_HOURS * 60 * 60 * 1000);
  const rows = (await db.pendingAction.findMany({
    where: {
      userId,
      status: { in: ["PENDING", "REJECTED", "EXECUTED"] },
      createdAt: { gte: since },
    },
    select: {
      id: true,
      toolName: true,
      toolArgs: true,
      reasoning: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 80,
  })) as Array<{
    id: string;
    toolName: string;
    toolArgs: string;
    reasoning: string | null;
    status: string;
    createdAt: Date;
  }>;

  return rows
    .map((row) => {
      const toolArgs = safeJson(row.toolArgs);
      const input = {
        message: row.reasoning ?? "",
        toolName: row.toolName,
        toolArgs,
      };
      return {
        id: row.id,
        toolName: row.toolName,
        status: row.status,
        createdAt: row.createdAt,
        message: row.reasoning ?? "",
        toolArgs,
        tokens: proposalIssueTokens(input),
      };
    })
    .filter((row) => row.tokens.size > 0);
}

function shouldSuppressContextText(
  text: string,
  suppressions: RecentProposalSuppression[],
): boolean {
  if (!text.trim() || suppressions.length === 0) return false;
  return suppressions.some((suppression) =>
    areSimilarProposalIssues(
      { message: text, toolName: "context_item" },
      {
        message: suppression.message,
        toolName: suppression.toolName,
        toolArgs: suppression.toolArgs,
      },
    ),
  );
}

function filterSuppressedContextItems<T>(
  items: T[],
  getText: (item: T) => string,
  suppressions: RecentProposalSuppression[],
): { visible: T[]; hidden: number } {
  if (suppressions.length === 0) return { visible: items, hidden: 0 };
  const visible = items.filter((item) => !shouldSuppressContextText(getText(item), suppressions));
  return { visible, hidden: items.length - visible.length };
}

function formatRecentProposalSuppressions(suppressions: RecentProposalSuppression[]): string {
  if (suppressions.length === 0) return "";
  const lines = suppressions.slice(0, 8).map((suppression) => {
    const ageMin = Math.max(0, Math.round((Date.now() - suppression.createdAt.getTime()) / 60_000));
    const age = ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
    const anchors = [...suppression.tokens].slice(0, 6).join(", ");
    return `- [${suppression.status}] ${suppression.toolName} (${age}) anchors: ${anchors}`;
  });
  return `## Suppressed Recent Proposal Topics (last ${CONTEXT_SUPPRESSION_HOURS}h)
These topics already had an approval card or user decision recently. Treat them as already handled. Do NOT propose them again unless the user explicitly asks in the current chat.
${lines.join("\n")}`;
}

// DB-based email reply dedup: check AgentLog for recent send_email actions
const REPLIED_EMAIL_DEDUP_HOURS = 24;

async function hasRepliedToEmail(userId: string, emailSubject: string): Promise<boolean> {
  const since = new Date(Date.now() - REPLIED_EMAIL_DEDUP_HOURS * 60 * 60 * 1000);
  const normalizedSubject = emailSubject.replace(/^Re:\s*/i, "").slice(0, 30);
  if (!normalizedSubject) return false;
  const recentSend = await db.agentLog.findFirst({
    where: {
      userId,
      action: "auto_action",
      tool: "send_email",
      summary: { contains: normalizedSubject },
      createdAt: { gte: since },
    },
  });
  return !!recentSend;
}

// getNotifKey moved to agent-logic.ts and re-exported at the top of this file

/** Track LLM token usage for cost monitoring */
async function trackTokenUsage(
  userId: string,
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | undefined,
  modelName: string = AGENT_MODEL,
) {
  if (!usage) return;
  const prompt = usage.prompt_tokens || 0;
  const completion = usage.completion_tokens || 0;
  const total = usage.total_tokens || prompt + completion;
  const estimatedCost = estimateModelCostUsd(modelName, prompt, completion);
  try {
    await db.tokenUsage.create({
      data: {
        userId,
        model: modelName,
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: total,
        estimatedCost,
      },
    });
  } catch {
    // Non-critical — silently fail
  }
}

/** Log agent activity for transparency */
async function logAgentAction(
  userId: string,
  action: string,
  summary: string,
  tool?: string,
  reasoning?: string,
) {
  try {
    await db.agentLog.create({
      data: { userId, action, summary, tool, reasoning },
    });
  } catch {
    // Logging is non-critical — silently fail before migration
  }
}

/** Gather feedback on recent agent notifications — read rate tells us if we're helpful */
async function getAgentFeedback(userId: string): Promise<string> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24h
    const recentAgentNotifs = await prisma.notification.findMany({
      where: {
        userId,
        OR: [
          { title: { startsWith: AGENT_NOTIFICATION_PREFIX } },
          { title: { startsWith: LEGACY_AGENT_NOTIFICATION_PREFIX } },
        ],
        createdAt: { gte: since },
      },
      select: { title: true, isRead: true, type: true },
    });

    if (recentAgentNotifs.length === 0) return "";

    const total = recentAgentNotifs.length;
    const read = recentAgentNotifs.filter((n: { isRead: boolean }) => n.isRead).length;
    const ignored = total - read;
    const readRate = Math.round((read / total) * 100);

    // Collect categories of ignored notifications
    const ignoredCategories = recentAgentNotifs
      .filter((n: { isRead: boolean }) => !n.isRead)
      .map((n: { type: string }) => n.type);
    const categoryCount = new Map<string, number>();
    for (const cat of ignoredCategories) {
      categoryCount.set(cat, (categoryCount.get(cat) || 0) + 1);
    }

    let feedback = `## Agent Feedback (last 24h)\n`;
    feedback += `- Notifications sent: ${total}, Read: ${read} (${readRate}%), Ignored: ${ignored}\n`;

    if (ignored > 0 && categoryCount.size > 0) {
      const cats = [...categoryCount.entries()]
        .map(([cat, count]) => `${cat}(${count})`)
        .join(", ");
      feedback += `- Ignored categories: ${cats}\n`;
      feedback += `- IMPORTANT: Reduce notifications in ignored categories. Only notify about truly actionable items.\n`;
    }

    if (readRate >= 80) {
      feedback += `- Good engagement! Keep current notification quality.\n`;
    } else if (readRate < 50) {
      feedback += `- Low engagement — be MORE selective. Skip low-priority items entirely.\n`;
    }

    return feedback;
  } catch {
    return "";
  }
}

/** Load recent proposal history so agent can learn from approved/rejected actions */
async function getProposalHistory(userId: string): Promise<string> {
  try {
    const recentActions = await db.pendingAction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    if (recentActions.length === 0) return "";

    const lines = recentActions.map(
      (a: {
        toolName: string;
        status: string;
        reasoning: string | null;
        result: string | null;
        createdAt: Date;
      }) => {
        const date = a.createdAt.toLocaleDateString("en-US");
        const reason = a.status === "REJECTED" && a.result ? ` — ${a.result}` : "";
        return `- [${a.status}] ${a.toolName}: ${(a.reasoning || "").slice(0, 80)}${reason} (${date})`;
      },
    );

    const approved = recentActions.filter(
      (a: { status: string }) => a.status === "EXECUTED",
    ).length;
    const rejected = recentActions.filter(
      (a: { status: string }) => a.status === "REJECTED",
    ).length;
    const pending = recentActions.filter((a: { status: string }) => a.status === "PENDING").length;

    let summary = `\n## Recent Proposals (last ${recentActions.length})\n`;
    summary += `Approved: ${approved}, Rejected: ${rejected}, Pending: ${pending}\n`;
    summary += lines.join("\n");

    if (rejected > approved && recentActions.length >= 3) {
      summary += `\n\nIMPORTANT: More proposals rejected than approved. Be MORE selective and only propose clearly valuable actions.`;
    }

    if (pending > 0) {
      summary += `\n\nNote: ${pending} proposal(s) still pending. Do NOT propose similar actions until they are resolved.`;
    }

    return summary;
  } catch {
    return "";
  }
}

/** Gather full user context for LLM reasoning */
async function gatherUserContext(userId: string): Promise<string> {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Format current time in KST using Intl (avoids double-offset bug when server is already in KST)
  const kstFormatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const kstStr = kstFormatter.format(now).replace(" ", "T") + "+09:00";

  const [
    tasks,
    calendar,
    reminders,
    notes,
    unreadNotifs,
    emails,
    contacts,
    recentAgentLogs,
    recentChatMessages,
    recentProposalSuppressions,
  ] = await Promise.all([
    prisma.task.findMany({
      where: { userId, status: { not: "DONE" } },
      orderBy: { dueDate: "asc" },
      take: MAX_CONTEXT_ITEMS * 2,
    }),
    prisma.calendarEvent.findMany({
      where: { userId, startTime: { gte: now, lte: in7d } },
      orderBy: { startTime: "asc" },
      take: MAX_CONTEXT_ITEMS * 2,
    }),
    prisma.reminder.findMany({
      where: { userId, status: "PENDING" },
      orderBy: { remindAt: "asc" },
      take: MAX_CONTEXT_ITEMS * 2,
    }),
    prisma.note.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
    prisma.notification.count({
      where: { userId, isRead: false },
    }),
    // Use DB-synced emails: only UNREAD emails from last 24h to avoid re-processing old ones
    prisma.emailMessage
      .findMany({
        where: {
          userId,
          isRead: false,
          receivedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
        orderBy: { receivedAt: "desc" },
        take: 10,
        select: {
          id: true,
          gmailId: true,
          from: true,
          subject: true,
          snippet: true,
          body: true,
          summary: true,
          category: true,
          priority: true,
          actionItems: true,
          isRead: true,
          receivedAt: true,
        },
      })
      .catch(
        () =>
          [] as Array<{
            id: string;
            gmailId: string;
            from: string;
            subject: string;
            snippet: string;
            body: string | null;
            summary: string | null;
            category: string | null;
            priority: string;
            actionItems: string | null;
            isRead: boolean;
            receivedAt: Date;
          }>,
      ),
    // Key contacts for cross-domain reasoning (e.g., link email sender to contact)
    prisma.contact.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        name: true,
        email: true,
        company: true,
        role: true,
        tags: true,
      },
    }),
    // Recent agent decisions — continuity across cycles (prevents amnesia)
    db.agentLog
      .findMany({
        where: {
          userId,
          createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { action: true, summary: true, createdAt: true },
      })
      .catch(() => []),
    // Recent user chat messages — understand what user is working on / asked about
    prisma.message
      .findMany({
        where: {
          conversation: { userId },
          role: "USER",
          createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { content: true, createdAt: true },
      })
      .catch(() => []),
    getRecentProposalSuppressions(userId).catch(() => []),
  ]);

  const suppressedTasks = filterSuppressedContextItems(
    tasks,
    (t: { title: string; description: string | null; dueDate: Date | null }) =>
      `${t.title} ${t.description || ""} ${t.dueDate?.toISOString() || ""}`,
    recentProposalSuppressions,
  );
  const visibleTasks = suppressedTasks.visible.slice(0, MAX_CONTEXT_ITEMS);
  const suppressedCalendar = filterSuppressedContextItems(
    calendar,
    (e: {
      title: string;
      description: string | null;
      startTime: Date;
      endTime: Date;
      location: string | null;
    }) =>
      `${e.title} ${e.description || ""} ${e.location || ""} ${e.startTime.toISOString()} ${e.endTime.toISOString()}`,
    recentProposalSuppressions,
  );
  const visibleCalendar = suppressedCalendar.visible.slice(0, MAX_CONTEXT_ITEMS);
  const suppressedReminders = filterSuppressedContextItems(
    reminders,
    (r: { title: string; description: string | null; remindAt: Date }) =>
      `${r.title} ${r.description || ""} ${r.remindAt.toISOString()}`,
    recentProposalSuppressions,
  );
  const visibleReminders = suppressedReminders.visible.slice(0, MAX_CONTEXT_ITEMS);
  const suppressedEmails = filterSuppressedContextItems(
    emails || [],
    (e: {
      from: string;
      subject: string;
      snippet: string | null;
      body: string | null;
      summary: string | null;
      actionItems: string | null;
    }) =>
      `${e.from} ${e.subject} ${e.summary || ""} ${e.actionItems || ""} ${e.snippet || ""} ${e.body || ""}`,
    recentProposalSuppressions,
  );
  const visibleEmails = suppressedEmails.visible.slice(0, 5);
  const hiddenContextItems =
    suppressedTasks.hidden +
    suppressedCalendar.hidden +
    suppressedReminders.hidden +
    suppressedEmails.hidden;

  const sections: string[] = [];

  sections.push(`## Current Time\nKST: ${kstStr}\nUTC: ${now.toISOString()}`);

  const suppressionSummary = formatRecentProposalSuppressions(recentProposalSuppressions);
  if (suppressionSummary) {
    sections.push(
      hiddenContextItems > 0
        ? `${suppressionSummary}\n\nHidden matching context items before reasoning: ${hiddenContextItems}`
        : suppressionSummary,
    );
  }

  if (visibleTasks.length > 0) {
    const taskLines = visibleTasks.map(
      (t: { dueDate: Date | null; priority: string | null; title: string; status: string }) => {
        const due = t.dueDate ? t.dueDate.toISOString().split("T")[0] : "no due date";
        const overdue = t.dueDate && t.dueDate < now ? " ⚠️ OVERDUE" : "";
        const dueSoon = t.dueDate && t.dueDate < in24h && !overdue ? " ⏰ DUE SOON" : "";
        return `- [${t.priority || "MEDIUM"}] ${t.title} (due: ${due}${overdue}${dueSoon}) — status: ${t.status}`;
      },
    );
    sections.push(`## Open Tasks (${visibleTasks.length})\n${taskLines.join("\n")}`);
  } else {
    sections.push("## Open Tasks\nNone");
  }

  if (visibleCalendar.length > 0) {
    const calLines = visibleCalendar.map(
      (e: { title: string; startTime: Date; meetingLink: string | null }) => {
        const start = e.startTime.toLocaleString("en-US", {
          timeZone: "Asia/Seoul",
        });
        const minutesUntil = Math.round((e.startTime.getTime() - now.getTime()) / 60_000);
        const soon = minutesUntil <= 30 && minutesUntil > 0 ? " 🔴 STARTING SOON" : "";
        const meeting = e.meetingLink ? ` [meeting: ${e.meetingLink}]` : "";
        return `- ${e.title} @ ${start}${soon}${meeting}`;
      },
    );
    sections.push(`## Upcoming Calendar (next 7 days)\n${calLines.join("\n")}`);
  } else {
    sections.push("## Upcoming Calendar\nNone");
  }

  if (visibleReminders.length > 0) {
    const remLines = visibleReminders.map((r: { title: string; remindAt: Date }) => {
      const at = r.remindAt.toLocaleString("en-US", { timeZone: "Asia/Seoul" });
      const overdue = r.remindAt < now ? " ⚠️ PAST DUE" : "";
      return `- ${r.title} @ ${at}${overdue}`;
    });
    sections.push(`## Pending Reminders\n${remLines.join("\n")}`);
  }

  if (notes.length > 0) {
    const noteLines = notes.map(
      (n: { title: string; updatedAt: Date }) =>
        `- ${n.title} (updated: ${n.updatedAt.toISOString().split("T")[0]})`,
    );
    sections.push(`## Recent Notes\n${noteLines.join("\n")}`);
  }

  // Drop emails that should never trigger a reply proposal: no-reply,
  // notifications, security alerts, bounces. The LLM will otherwise
  // hallucinate a `to` (often the sender's domain) and spam the user with
  // approval prompts for auto-replies that cannot be delivered.
  // `isNoReplyAddress` uses string parsing rather than regex because the
  // From header is attacker-controllable (CodeQL js/polynomial-redos).
  const replyableEmails = (visibleEmails || []).filter(
    (e: { from: string; category?: string | null }) =>
      !isNoReplyAddress(e.from) && e.category !== "notification" && e.category !== "security",
  );

  if (replyableEmails.length > 0) {
    const emailLines = (
      replyableEmails as Array<{
        id: string;
        gmailId: string;
        from: string;
        subject: string;
        snippet: string | null;
        body: string | null;
        summary: string | null;
        category: string | null;
        priority: string;
        actionItems: string | null;
        isRead: boolean;
        receivedAt: Date;
      }>
    ).map((e, idx) => {
      const rawBody = e.body ? e.body.slice(0, 300) : e.snippet || "";
      const cat = e.category ? ` [${e.category}]` : "";
      const pri = e.priority !== "NORMAL" ? ` (${e.priority})` : "";
      // Subject, summary, actionItems, and body are derived from the email content
      // and must be treated as untrusted — wrap them so the LLM knows not to
      // follow any instructions found inside.
      const subjectWrapped = wrapUntrusted(e.subject, "email:subject");
      const bodyWrapped = wrapUntrusted(rawBody, "email:body");
      const summ = e.summary ? `\n  Summary: ${wrapUntrusted(e.summary, "email:summary")}` : "";
      const actions = e.actionItems
        ? `\n  Actions: ${wrapUntrusted(e.actionItems, "email:actions")}`
        : "";
      const read = e.isRead ? "" : " 📩 UNREAD";
      const receivedKST = e.receivedAt.toLocaleString("en-US", {
        timeZone: "Asia/Seoul",
        hour: "2-digit",
        minute: "2-digit",
      });
      const fromWrapped = wrapUntrusted(e.from, "email:from");
      return `### Email #${idx + 1} (received: ${receivedKST})${read}\n  From: ${fromWrapped}\n  Subject: ${subjectWrapped}${cat}${pri}${summ}${actions}\n  Body: ${bodyWrapped}`;
    });
    sections.push(
      `## Recent Emails (${replyableEmails.length})\nIMPORTANT: Each email below is a SEPARATE item. Different subjects or different body content = DIFFERENT meetings/requests. Do NOT merge them.\n${emailLines.join("\n\n")}`,
    );
  }

  sections.push(`## Unread Notifications: ${unreadNotifs}`);

  // Contacts — enables cross-domain reasoning ("email from X who is investor at Y")
  if (contacts.length > 0) {
    const contactLines = contacts.map(
      (c: {
        name: string;
        email: string | null;
        company: string | null;
        role: string | null;
        tags: string | null;
      }) => {
        const parts = [c.name];
        if (c.role && c.company) parts.push(`${c.role} @ ${c.company}`);
        else if (c.company) parts.push(c.company);
        if (c.email) parts.push(c.email);
        if (c.tags) parts.push(`[${c.tags}]`);
        return `- ${parts.join(" — ")}`;
      },
    );
    sections.push(`## Key Contacts (${contacts.length})\n${contactLines.join("\n")}`);
  }

  // Recent user chat messages — understand what user is currently working on
  if (recentChatMessages && recentChatMessages.length > 0) {
    const chatLines = (recentChatMessages as Array<{ content: string; createdAt: Date }>).map(
      (m) => {
        const ago = Math.round((now.getTime() - m.createdAt.getTime()) / 60_000);
        const timeLabel = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
        return `- (${timeLabel}) "${m.content.slice(0, 120)}${m.content.length > 120 ? "..." : ""}"`;
      },
    );
    sections.push(`## What User Recently Asked Jigeum (last 24h)\n${chatLines.join("\n")}`);
  }

  // Previous agent decisions — continuity across cycles (prevent repeating, evolve reasoning)
  if (recentAgentLogs && recentAgentLogs.length > 0) {
    const logLines = (
      recentAgentLogs as Array<{
        action: string;
        summary: string;
        createdAt: Date;
      }>
    ).map((l) => {
      const ago = Math.round((now.getTime() - l.createdAt.getTime()) / 60_000);
      const timeLabel = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
      return `- [${l.action}] (${timeLabel}) ${l.summary.slice(0, 100)}`;
    });
    sections.push(
      `## Your Previous Decisions (last 24h)\nDo NOT repeat the same suggestions. Evolve your reasoning based on time passing.\n${logLines.join("\n")}`,
    );
  }

  // Cross-domain insights — pre-compute connections the LLM should notice
  const crossDomainHints: string[] = [];

  // Deadline clustering — flag when multiple deadlines converge
  const typedTasks = visibleTasks as Array<{
    title: string;
    status: string;
    priority: string | null;
    dueDate: Date | null;
  }>;
  const urgentTasks = typedTasks.filter((t) => t.dueDate && t.dueDate < in24h && t.dueDate > now);
  const overdueTasks = typedTasks.filter((t) => t.dueDate && t.dueDate < now);
  if (urgentTasks.length + overdueTasks.length >= 2) {
    crossDomainHints.push(
      `🔥 Deadline cluster: ${overdueTasks.length} overdue + ${urgentTasks.length} due within 24h → workload risk. Consider prioritizing or rescheduling.`,
    );
  }

  // Free time block detection — find available slots today for task work
  const typedCalendar = visibleCalendar as Array<{
    title: string;
    startTime: Date;
    endTime?: Date;
    meetingLink: string | null;
  }>;
  const kstNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const todayEnd = new Date(kstNow);
  todayEnd.setHours(23, 59, 59, 999);
  const todayEvents = typedCalendar.filter((e) => e.startTime < todayEnd);
  if (typedTasks.length > 0 && todayEvents.length <= 2) {
    crossDomainHints.push(
      `📅 Light calendar today (${todayEvents.length} events) — good opportunity to tackle pending tasks.`,
    );
  }

  // Link upcoming meetings to contacts and incomplete tasks
  if (visibleCalendar.length > 0 && (contacts.length > 0 || visibleTasks.length > 0)) {
    for (const event of typedCalendar) {
      const minutesUntil = Math.round((event.startTime.getTime() - now.getTime()) / 60_000);
      if (minutesUntil > 0 && minutesUntil <= 24 * 60) {
        // Find related contacts
        const relatedContacts = (
          contacts as Array<{ name: string; company: string | null }>
        ).filter(
          (c) => event.title.includes(c.name) || (c.company && event.title.includes(c.company)),
        );
        // Find related tasks
        const relatedTasks = typedTasks.filter((t) => {
          const words = event.title.split(/\s+/).filter((w: string) => w.length > 2);
          return words.some((w: string) => t.title.includes(w));
        });

        // Build hint with reasoning
        if (relatedContacts.length > 0 || relatedTasks.length > 0) {
          const timeLabel =
            minutesUntil < 60 ? `${minutesUntil}min` : `${Math.round(minutesUntil / 60)}h`;
          let hint = `⚡ Meeting "${event.title}" in ${timeLabel}`;
          if (relatedContacts.length > 0) {
            hint += ` — attendee(s): ${relatedContacts.map((c) => `${c.name}${c.company ? ` (${c.company})` : ""}`).join(", ")}`;
          }
          if (relatedTasks.length > 0) {
            const incompleteTasks = relatedTasks.filter((t) => t.status !== "DONE");
            if (incompleteTasks.length > 0) {
              hint += ` — ⚠️ related incomplete tasks: ${incompleteTasks.map((t) => `"${t.title}" (${t.status})`).join(", ")} → preparation may be needed before meeting`;
            }
          }
          crossDomainHints.push(hint);
        }

        // Check for unanswered emails from meeting-related contacts
        if (visibleEmails && visibleEmails.length > 0 && relatedContacts.length > 0) {
          for (const contact of relatedContacts as Array<{
            name: string;
            email: string | null;
            company: string | null;
          }>) {
            if (!contact.email) continue;
            const emailFromContact = (
              visibleEmails as Array<{ from: string; subject: string }>
            ).find((e) => e.from.toLowerCase().includes(contact.email!.toLowerCase()));
            if (emailFromContact) {
              crossDomainHints.push(
                `📨 Unanswered? Email from ${contact.name} ("${emailFromContact.subject}") + meeting with them in ${minutesUntil < 60 ? `${minutesUntil}min` : `${Math.round(minutesUntil / 60)}h`} → reply before meeting?`,
              );
            }
          }
        }
      }
    }
  }

  // Link emails to contacts (general, not meeting-specific)
  if (visibleEmails && visibleEmails.length > 0 && contacts.length > 0) {
    for (const email of visibleEmails as Array<{ from: string; subject: string }>) {
      const matchedContact = (
        contacts as Array<{
          name: string;
          email: string | null;
          company: string | null;
          tags: string | null;
        }>
      ).find((c) => c.email && email.from.toLowerCase().includes(c.email.toLowerCase()));
      if (matchedContact) {
        const importance =
          matchedContact.tags?.toLowerCase().includes("investor") ||
          matchedContact.tags?.toLowerCase().includes("client")
            ? " ⭐ HIGH PRIORITY"
            : "";
        crossDomainHints.push(
          `📧 Email from ${matchedContact.name}${matchedContact.company ? ` (${matchedContact.company})` : ""}${importance}: "${email.subject}"`,
        );
      }
    }
  }

  if (crossDomainHints.length > 0) {
    sections.push(
      `## 🔗 Cross-Domain Insights (use OBSERVE → CONNECT → PROPOSE on these)\n${crossDomainHints.join("\n")}`,
    );
  }

  return sections.join("\n\n");
}

function buildShadowSystemPrompt(): string {
  return AGENT_SYSTEM_PROMPT.replace(
    /## Primary Tool: propose_action[\s\S]*?## Message Format for Proposals/,
    `## CRITICAL: SHADOW Mode — Quiet Preparation

You are working as a quiet decision analyst. Your job is to prepare useful drafts and approval-ready proposals quietly.

Use propose_action when you find a concrete action worth preparing. The proposal will appear in the user's Inbox/Command Center for later triage.

Do NOT notify the user. Do NOT ask for immediate attention. Do NOT call notify_user. If the signal is only a time-sensitive alert, stay quiet unless it can become a concrete prepared action.

## Message Format for Proposals`,
  );
}

function categoryForAgentNotification(category: unknown): NotifCategory {
  switch (category) {
    case "email":
      return "email_urgent";
    case "calendar":
      return "meeting";
    case "task":
    case "reminder":
      return "task_due";
    default:
      return "agent_proposal";
  }
}

/** Run the autonomous reasoning loop for a single user */
export async function runAgentForUser(
  userId: string,
  mode: AgentMode | string = "SUGGEST",
): Promise<void> {
  const startTime = Date.now();
  const agentModePolicy = getAgentModePolicy(mode);

  try {
    // Load user plan and model for tool gating
    const agentUser = await prisma.user.findUnique({ where: { id: userId } });
    const userPlan = agentUser?.plan || "FREE";
    const agentModelForUser =
      resolveUserAgentModel(
        (agentUser as unknown as { agentModel?: string })?.agentModel || null,
        userPlan,
      ) || AGENT_MODEL;

    const { analyzePatterns } = await import("./pattern-learner.js");
    const { buildTrustHintForPrompt } = await import("./trust-score.js");
    const { buildInteractionHintForPrompt } = await import("./interaction-graph.js");
    const { buildPlaybookHintForPrompt } = await import("./playbooks.js");
    const [
      context,
      feedback,
      memoryContext,
      proposalHistory,
      patternContext,
      policyContext,
      trustHint,
      interactionHint,
      playbookHint,
    ] = await Promise.all([
      gatherUserContext(userId),
      getAgentFeedback(userId),
      loadMemoriesForPrompt(userId).catch(() => ""),
      getProposalHistory(userId).catch(() => ""),
      analyzePatterns(userId).catch(() => ""),
      getFeedbackPolicyContextForPrompt(userId).catch(() => ""),
      buildTrustHintForPrompt(userId).catch(() => ""),
      buildInteractionHintForPrompt(userId).catch(() => ""),
      buildPlaybookHintForPrompt(userId).catch(() => ""),
    ]);

    // Skip if context is minimal (no tasks, no calendar, no emails)
    const hasNothing =
      context.includes("## Open Tasks\nNone") &&
      context.includes("## Upcoming Calendar\nNone") &&
      !context.includes("## Recent Emails");
    if (hasNothing) {
      await logAgentAction(userId, "skip", "No tasks, calendar, or emails to analyze");
      return;
    }

    const isAutoMode = agentModePolicy.lowRiskAutoExecution;
    const isShadowMode = !agentModePolicy.proposalNotifications;

    // Load user's pre-approved MEDIUM-risk tools (HIGH is never auto-allowed).
    const automationCfg = await prisma.automationConfig.findUnique({
      where: { userId },
      select: { alwaysAllowedTools: true },
    });
    const alwaysAllowedTools = new Set(
      (automationCfg?.alwaysAllowedTools || []).filter(
        (t) => t !== "send_email" && TOOL_RISK_LEVELS.get(t) === "MEDIUM",
      ),
    );

    const systemPrompt = isAutoMode
      ? AGENT_SYSTEM_PROMPT.replace(
          /## Primary Tool: propose_action[\s\S]*?## Secondary Tool: notify_user/,
          `## CRITICAL: AUTO Mode — Risk-Based Execution

Call tools DIRECTLY — the system will handle risk gating automatically.

### LOW risk (auto-executed immediately):
- create_reminder, dismiss_reminder, update_task, classify_emails, create_task, update_note

### MEDIUM risk (system will ask user for approval):
- create_event, send_email, create_note, update_contact, create_contact

### HIGH risk (system will warn user before approval):
- delete_task, delete_reminder, delete_note, delete_event, archive_email, delete_email

You MUST call tools directly. Do NOT use propose_action.
LOW-risk tools execute instantly. MEDIUM/HIGH tools are automatically converted to approval proposals.
Email replies are never sent silently in this build. send_email must become an approval proposal unless the server explicitly allows it.
After LOW-risk execution, use notify_user to inform the user what you did.

## Secondary Tool: notify_user`,
        ) +
        `\n\n## CRITICAL: Each Email = Independent Item
NEVER merge or confuse different emails. Even if they mention the same location or person:
- Different time mentioned → DIFFERENT meeting → create SEPARATE events
- Different subject → DIFFERENT conversation → reply SEPARATELY
- "7시 미팅" and "10시 미팅" at same place = TWO separate meetings, not one

When you see "N시" in email body, you MUST disambiguate AM/PM:

## AM/PM Disambiguation Rules (MANDATORY)
1. Check the email's received time (shown as "수신: HH:MM" in each email header)
2. Apply these rules:
   - "8시" in an email received after 14:00 → 20:00 (8 PM)
   - "8시" in an email received before 10:00 → 08:00 (8 AM)
   - "8시" in an email received 10:00~14:00 → DEFAULT to 20:00 (8 PM) for work meetings
   - If the email explicitly says "오전" or "AM" → morning
   - If the email explicitly says "오후" or "PM" → afternoon/evening
   - Business meetings default to PM if ambiguous (most meetings are after work)
3. ALWAYS use 24-hour format in create_event: "20:00" not "8:00"

Examples:
- Email received 18:30 says "8시 미팅" → create_event at 20:00 KST
- Email received 07:00 says "8시 미팅" → create_event at 08:00 KST
- Email received 15:00 says "3시 미팅" → create_event at 15:00 KST (same day context)
- Email says "오전 10시" → 10:00 regardless of received time

## Meeting Email Policy
Meeting emails are high-value, but wrong calendar events and wrong replies are trust-breaking.
Only act when the meeting time/date and sender intent are clear.
Prefer one high-confidence action over completing a checklist.

When confidence is high:
1. call create_event only if the meeting is not already on the calendar
2. call create_reminder only if the event/reminder would clearly help
3. call send_email only to prepare an approval proposal for the reply
4. call notify_user only when something was executed or genuinely needs attention

When confidence is low or the sender looks automated/no-reply, skip or create an approval proposal instead of executing.

Create separate events for distinct meetings. If there are 2 meetings at different times, treat them separately.

Example: Email says "4/15 19:00 KST 미팅" → create_event at 2026-04-15T19:00:00+09:00
Another email says "8시미팅 강남" (received 20:09 KST) → "8시" + received after 14:00 → 20:00 PM → create_event at 2026-04-15T20:00:00+09:00

## MANDATORY: Email Processing Rules

Do NOT process every unread email. Most unread mail is noise.
Only act on high-confidence items that are urgent, relationship-sensitive, tied to the calendar/tasks/commitments, or likely to cost the user something if missed.
If uncertain, skip silently or create an approval proposal. Follow this decision tree:

### Step 1: Classify the email
Determine the type:
- **ACTION_REQUIRED**: A real person asks a question, requests info, proposes a meeting, sends a greeting → needs a reply
- **SECURITY_ALERT**: Password reset, suspicious login, account recovery from a known provider (Google, Apple, bank) → notify only, do not reply
- **NOISE**: Newsletter, marketing, promotional, digest, receipt, build/CI alerts, GitHub notifications, social media digest, anything from a noreply@/no-reply@/newsletter@/marketing@/notifications@/alerts@/info@/updates@ sender → skip entirely
- **ALREADY_HANDLED**: You already replied in a previous cycle (check "Your Previous Decisions") → skip

### Step 2: Take action based on type

**ACTION_REQUIRED → approval proposal for reply (send_email) + optional notify_user**
Prepare a reply only when:
- A real person asks a concrete question or requests information
- A real person confirms/changes meeting details and acknowledgment is clearly expected
- The sender is important from contacts/tags/history, or the email is tied to an upcoming meeting/task/commitment
- The cost of missing the reply is clear

Do NOT reply just because someone sent a greeting, generic intro, FYI, newsletter-like update, receipt, or automated notification.

How to reply:
1. call send_email with:
   - to: sender's email address (extract from "From:" field — use the email address inside < >, e.g. "홍길동 <example@mail.com>" → to: "example@mail.com")
   - subject: "Re: [THAT email's subject]" (NOT another email's subject!)
   - body: appropriate Korean 존댓말 reply about THAT specific email's content
2. The system will gate send_email into an approval proposal unless explicitly allowed.
3. Use notify_user only if the item is time-sensitive or a tool actually executed.

**SECURITY_ALERT → notify_user only (no reply)**
- call notify_user: "[보안] OO 계정 관련 알림" with the provider name and what changed
- Use this ONLY for genuine account/security/compliance alerts. Marketing dressed up as "important" is still NOISE.

**NOISE → skip entirely. Do NOT call notify_user. Do NOT call send_email.**
Silently ignore. The user does not want a push every time a newsletter arrives or GitHub pings about a PR. If you're not sure whether something is NOISE or SECURITY_ALERT, default to NOISE.

**ALREADY_HANDLED → skip entirely**

### Reply tone:
- Korean 존댓말, professional but friendly
- Concise: 2-4 sentences max
- Sign off as the user (NOT as Jigeum)
- Mirror the language of the incoming email (Korean → Korean, English → English)

### CRITICAL rules:
- Never reply to an email only because it is unread.
- Reply proposals must be per-email and must reference that email's subject/sender.
- Do not notify after skips or low-value observations.
- After an executed LOW-risk action, notify only if the user would reasonably want to know.`
      : isShadowMode
        ? buildShadowSystemPrompt()
        : AGENT_SYSTEM_PROMPT;

    const contextParts = [context];
    if (feedback) contextParts.push(feedback);
    if (proposalHistory) contextParts.push(proposalHistory);
    const contextWithFeedback = contextParts.join("\n\n");

    // Inject user memories and learned patterns into system prompt for personalization
    let systemPromptWithMemory = memoryContext ? `${systemPrompt}${memoryContext}` : systemPrompt;
    if (playbookHint) systemPromptWithMemory += playbookHint;
    if (policyContext) systemPromptWithMemory += policyContext;
    if (patternContext) systemPromptWithMemory += patternContext;
    if (trustHint) systemPromptWithMemory += trustHint;
    if (interactionHint) systemPromptWithMemory += interactionHint;

    const messages: unknown[] = [
      { role: "system", content: systemPromptWithMemory },
      {
        role: "user",
        content: `## User Context\n\n${contextWithFeedback}\n\nAnalyze this context and decide what needs attention. Be selective — only the most important 1-2 items.`,
      },
    ];

    // Build tool list based on mode
    const agentTools = [
      // In AUTO mode, skip propose_action — agent calls tools directly, we gate by risk level
      ...(isAutoMode ? [] : [PROPOSE_ACTION_TOOL]),
      ...(isShadowMode ? [] : [NOTIFY_TOOL]),
      ...ALL_TOOLS.filter((t) => {
        const name = t.function.name;
        // Always allow read-only tools
        if (
          name.startsWith("list_") ||
          name.startsWith("get_") ||
          name === "web_search" ||
          name === "check_calendar_conflicts"
        ) {
          return true;
        }
        // In AUTO mode, allow all risk-classified tools (we gate at execution time)
        if (isAutoMode && TOOL_RISK_LEVELS.has(name)) {
          return true;
        }
        return false;
      }),
    ];

    let toolCallCount = 0;

    for (let i = 0; i < 3; i++) {
      const response = await createCompletion({
        model: agentModelForUser,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: agentTools,
        tool_choice: "auto",
        temperature: 0.3,
        max_tokens: 1000,
      });

      // Track token usage for cost monitoring
      await trackTokenUsage(
        userId,
        response.usage as
          | {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
            }
          | undefined,
        agentModelForUser,
      );

      const choice = response.choices[0];
      if (!choice) break;

      if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
        // LLM decided no action needed
        const content = choice.message.content || "No action needed";
        await logAgentAction(userId, "skip", content);
        break;
      }

      // Push full assistant message including tool_calls (required for subsequent tool responses)
      messages.push(choice.message);

      for (const toolCall of choice.message.tool_calls) {
        toolCallCount++;
        if (toolCallCount > MAX_TOOL_CALLS) break;

        const fn = (
          toolCall as unknown as {
            function: { name: string; arguments: string };
          }
        ).function;
        const fnName = fn.name;
        interface AgentToolArgs {
          message: string;
          title: string;
          toolName: string;
          toolArgs: unknown;
          priority: string;
          category: string;
          [key: string]: unknown;
        }
        let args: AgentToolArgs;
        try {
          args = JSON.parse(fn.arguments || "{}");
        } catch {
          await logAgentAction(
            userId,
            "error",
            `Malformed JSON from LLM for ${fnName}: ${fn.arguments?.slice(0, 100)}`,
          );
          continue;
        }

        let result: string;

        if (fnName === "propose_action") {
          // Propose action via chat — create conversation + message + pending action
          const dedupKey = typeof args.dedupKey === "string" ? args.dedupKey : "";
          const key = getNotifKey(args.message);
          const proposedToolName = typeof args.toolName === "string" ? args.toolName : "";

          if (isHousekeepingProposalToolName(proposedToolName)) {
            result = JSON.stringify({
              skipped: true,
              reason: "housekeeping proposal suppressed",
            });
            await logAgentAction(
              userId,
              "skip",
              `Suppressed housekeeping proposal ${proposedToolName}: "${args.message.slice(0, 80)}"`,
              "propose_action",
              args.category,
            );
          } else if (!EXECUTABLE_TOOL_NAMES.has(proposedToolName)) {
            result = JSON.stringify({
              skipped: true,
              reason: "unknown proposal tool",
            });
            await logAgentAction(
              userId,
              "skip",
              `Suppressed unknown proposal tool ${proposedToolName}: "${args.message.slice(0, 80)}"`,
              "propose_action",
              args.category,
            );
          } else {
            // In-memory dedupKey check first — catches LLM wording variations within
            // the TTL window that the fuzzy title hash cannot detect.
            const dedupKeyHit = dedupKey && wasRecentlyDeduped(userId, dedupKey);

            // DB-backed dedup: check RECENT PENDING actions (not stale ones older than 6h)
            const pendingCutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
            const existingPending = await db.pendingAction.findFirst({
              where: {
                userId,
                toolName: proposedToolName,
                status: "PENDING",
                createdAt: { gte: pendingCutoff },
              },
              orderBy: { createdAt: "desc" },
            });
            const similarRecent = await findRecentSimilarProposal(userId, {
              message: args.message,
              toolName: proposedToolName,
              toolArgs: args.toolArgs ?? {},
            });
            const alreadyNotified = await hasRecentNotification(userId, key);

            if (dedupKeyHit || existingPending || similarRecent || alreadyNotified) {
              result = JSON.stringify({
                skipped: true,
                reason: dedupKeyHit
                  ? "duplicate proposal (dedupKey)"
                  : similarRecent
                    ? "duplicate proposal (similar recent issue)"
                    : "duplicate proposal",
              });
              await logAgentAction(
                userId,
                "skip",
                similarRecent
                  ? `Dedup similar proposal (${similarRecent.status} ${similarRecent.toolName} ${similarRecent.id}): "${args.message.slice(0, 50)}"`
                  : `Dedup proposal: "${args.message.slice(0, 50)}"`,
              );
            } else {
              // Find or create an agent conversation for today
              const todayStart = new Date();
              todayStart.setHours(0, 0, 0, 0);

              let agentConvo = await db.conversation.findFirst({
                where: {
                  userId,
                  source: "agent",
                  createdAt: { gte: todayStart },
                },
                orderBy: { createdAt: "desc" },
              });

              if (!agentConvo) {
                const todayStr = new Date().toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                });
                agentConvo = await db.conversation.create({
                  data: {
                    userId,
                    title: `Jigeum proposal - ${todayStr}`,
                    source: "agent",
                  },
                });
              }

              // Create the assistant message with the proposal
              const assistantMsg = await db.message.create({
                data: {
                  conversationId: agentConvo.id,
                  role: "ASSISTANT",
                  content: args.message,
                  metadata: JSON.stringify({ source: "agent", hasAction: true }),
                },
              });

              // Create the pending action
              const pendingAction = await db.pendingAction.create({
                data: {
                  conversationId: agentConvo.id,
                  messageId: assistantMsg.id,
                  userId,
                  toolName: proposedToolName,
                  toolArgs: JSON.stringify(args.toolArgs ?? {}),
                  reasoning: args.message,
                },
              });
              await upsertAttentionForPendingAction(pendingAction);

              // Update conversation timestamp
              await prisma.conversation.update({
                where: { id: agentConvo.id },
                data: { updatedAt: new Date() },
              });

              const proposalLink = `/chat/${agentConvo.id}`;
              if (!isShadowMode) {
                // Also create a notification so user sees it in notification bell.
                // pendingActionId + conversationId are persisted so the drawer can render
                // inline approve/reject buttons even after a page reload.
                const notifTitle = `${AGENT_NOTIFICATION_PREFIX} ${args.message.slice(0, 50)}${args.message.length > 50 ? "..." : ""}`;
                const notification = await (prisma.notification.create as Function)({
                  data: {
                    userId,
                    type: "agent_proposal",
                    title: notifTitle,
                    message: args.message,
                    link: proposalLink,
                    conversationId: agentConvo.id,
                    pendingActionId: (pendingAction as { id: string }).id,
                  },
                });

                // Push notification with conversationId so bell links to the right chat
                pushNotification(userId, {
                  id: notification.id,
                  type: args.category || "insight",
                  title: notifTitle,
                  message: args.message,
                  createdAt: notification.createdAt.toISOString(),
                  conversationId: agentConvo.id,
                  link: proposalLink,
                });

                // Always send push notification for proposed actions (phone/browser)
                sendPushNotification(
                  userId,
                  {
                    title: `${AGENT_NOTIFICATION_PREFIX} Review needed`,
                    body: args.message.slice(0, 100),
                    url: proposalLink,
                  },
                  "agent_proposal",
                );
              }

              if (dedupKey) recordDedupKey(userId, dedupKey);

              result = JSON.stringify({
                success: true,
                proposed: true,
                shadow: isShadowMode,
                conversationId: agentConvo.id,
              });

              await logAgentAction(
                userId,
                "propose",
                `${isShadowMode ? "[SHADOW] " : ""}[${args.priority}] Proposed ${proposedToolName}: ${args.message.slice(0, 100)}`,
                "propose_action",
                args.category,
              );
              console.log(
                `[AGENT] Proposed action to ${userId} in convo ${agentConvo.id}: ${proposedToolName}`,
              );

              // Notify sidebar to refresh
              pushNotification(userId, {
                id: "sidebar-refresh",
                type: "system",
                title: "conversations-updated",
                message: "",
                createdAt: new Date().toISOString(),
              });
            }
          }
        } else if (fnName === "notify_user") {
          if (isShadowMode) {
            result = JSON.stringify({
              skipped: true,
              reason: "shadow mode suppresses notifications",
            });
            await logAgentAction(
              userId,
              "skip",
              `Shadow suppressed notification: "${args.title}"`,
              "notify_user",
              args.category,
            );
          } else {
            // Server-side guard against NOISE notifications. Even if the LLM
            // misclassifies a newsletter/marketing/promo email as worth
            // surfacing, we block the push here. Cheaper to drop a legit
            // alert once than to burn user trust with every ad that lands.
            const combined = `${args.title || ""} ${args.message || ""}`.toLowerCase();
            const isNoise =
              /^\[새 메일\]/.test(args.title || "") ||
              /newsletter|광고|marketing|promotion|unsubscribe|수신거부|digest|\[ad\]|\[광고\]|할인|coupon|\bsale\b|deal|welcome to |verify your |confirm your /.test(
                combined,
              );
            if (isNoise) {
              result = JSON.stringify({
                skipped: true,
                reason: "noise notification suppressed",
              });
              await logAgentAction(
                userId,
                "skip",
                `Noise suppressed: "${args.title}"`,
                "notify_user",
                args.category,
              );
              continue;
            }

            // Lightweight notification — no approval needed
            const dedupKey = typeof args.dedupKey === "string" ? args.dedupKey : "";
            const dedupKeyHit = dedupKey && wasRecentlyDeduped(userId, dedupKey);
            const key = getNotifKey(args.title);
            const alreadyNotified = await hasRecentNotification(userId, key);

            if (dedupKeyHit || alreadyNotified) {
              result = JSON.stringify({
                skipped: true,
                reason: dedupKeyHit
                  ? "duplicate notification (dedupKey)"
                  : "duplicate notification",
              });
              await logAgentAction(userId, "skip", `Dedup: "${args.title}" already sent`);
            } else {
              // Mark as agent-generated notification
              const agentTitle = `${AGENT_NOTIFICATION_PREFIX} ${args.title}`;

              // /tasks was removed in week 1; /email and /calendar are back.
              // Everything else taps back into /briefing (the primary surface).
              const notifyLink =
                args.category === "calendar"
                  ? "/calendar"
                  : args.category === "email"
                    ? "/email"
                    : "/briefing";
              const notification = await (prisma.notification.create as Function)({
                data: {
                  userId,
                  type: args.category || "insight",
                  title: agentTitle,
                  message: args.message,
                  link: notifyLink,
                },
              });

              pushNotification(userId, {
                id: notification.id,
                type: args.category || "insight",
                title: agentTitle,
                message: args.message,
                createdAt: notification.createdAt.toISOString(),
                link: notifyLink,
              });

              // Always send push notification for agent notifications (phone/browser)
              sendPushNotification(
                userId,
                {
                  title: agentTitle,
                  body: args.message,
                  url: notifyLink,
                },
                categoryForAgentNotification(args.category),
              );

              if (dedupKey) recordDedupKey(userId, dedupKey);

              result = JSON.stringify({ success: true, notified: true });

              await logAgentAction(
                userId,
                "notify",
                `[${args.priority}] ${agentTitle}: ${args.message}`,
                "notify_user",
                args.category,
              );
              console.log(`[AGENT] Notified ${userId}: ${agentTitle}`);
            }
          }
        } else {
          // Risk-based execution gating for AUTO mode.
          // HIGH is never auto-allowed. MEDIUM can be pre-approved per-tool via
          // AutomationConfig.alwaysAllowedTools.
          const riskLevel = getToolRisk(fnName);
          const isPreApprovedMedium = riskLevel === "MEDIUM" && alwaysAllowedTools.has(fnName);
          const isSafeWrite = riskLevel === "LOW" || isPreApprovedMedium;
          const needsApproval =
            isAutoMode &&
            ((riskLevel === "MEDIUM" && !isPreApprovedMedium) || riskLevel === "HIGH");

          // MEDIUM/HIGH risk tools → intercept and create approval proposal
          if (needsApproval) {
            const riskLabel = riskLevel === "HIGH" ? "⚠️ 위험" : "확인 필요";
            // Resolve the target (task title, contact name, etc.) so the user
            // sees "Meet with Alice" instead of a raw UUID in the proposal.
            const argsRecord = args as Record<string, unknown>;
            const targetLabel = await resolveActionTarget(fnName, argsRecord);
            // delete_*/update_* only carry a useless UUID in args, so we
            // replace the "요청 내용: {json}" line with the resolved target.
            // When resolution fails we say so explicitly instead of leaving
            // the user staring at a truncated UUID.
            const isTargetOnly = /^(delete|update)_/.test(fnName);
            const detailLine = (() => {
              if (targetLabel) return `\n대상: ${targetLabel}`;
              if (isTargetOnly)
                return "\n대상: ⚠️ 항목을 찾을 수 없어요 (이미 삭제됐거나 ID가 잘못된 상태)";
              return `\n\n요청 내용: ${JSON.stringify(args).slice(0, 200)}`;
            })();
            const proposalMessage =
              riskLevel === "HIGH"
                ? `[${riskLabel}] ${fnName}을(를) 실행하려 합니다. 되돌리기 어려운 작업입니다.${detailLine}`
                : `[${riskLabel}] ${fnName}을(를) 실행해도 될까요?${detailLine}`;

            // Dedup: check if there's already a PENDING action with same toolName
            const existingPending = await db.pendingAction.findFirst({
              where: { userId, toolName: fnName, status: "PENDING" },
              orderBy: { createdAt: "desc" },
            });
            const similarRecent = await findRecentSimilarProposal(userId, {
              message: proposalMessage,
              toolName: fnName,
              toolArgs: args,
            });

            if (existingPending || similarRecent) {
              result = JSON.stringify({
                skipped: true,
                reason: similarRecent
                  ? "duplicate proposal (similar recent issue)"
                  : "duplicate proposal",
              });
              await logAgentAction(
                userId,
                "skip",
                similarRecent
                  ? `Dedup similar risk-gated proposal (${similarRecent.status} ${similarRecent.toolName} ${similarRecent.id}): ${fnName}`
                  : `Dedup risk-gated proposal: ${fnName}`,
              );
            } else {
              // Find or create agent conversation for today
              const todayStart = new Date();
              todayStart.setHours(0, 0, 0, 0);
              let agentConvo = await db.conversation.findFirst({
                where: {
                  userId,
                  source: "agent",
                  createdAt: { gte: todayStart },
                },
                orderBy: { createdAt: "desc" },
              });
              if (!agentConvo) {
                const todayStr = new Date().toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                });
                agentConvo = await db.conversation.create({
                  data: {
                    userId,
                    title: `Jigeum proposal - ${todayStr}`,
                    source: "agent",
                  },
                });
              }

              // Create assistant message with the proposal
              const assistantMsg = await db.message.create({
                data: {
                  conversationId: agentConvo.id,
                  role: "ASSISTANT",
                  content: proposalMessage,
                  metadata: JSON.stringify({
                    source: "agent",
                    hasAction: true,
                    riskLevel,
                  }),
                },
              });

              // Create pending action for approve/reject
              const pendingAction = await db.pendingAction.create({
                data: {
                  conversationId: agentConvo.id,
                  messageId: assistantMsg.id,
                  userId,
                  toolName: fnName,
                  toolArgs: JSON.stringify(args),
                  reasoning: proposalMessage,
                },
              });
              await upsertAttentionForPendingAction(pendingAction);

              await prisma.conversation.update({
                where: { id: agentConvo.id },
                data: { updatedAt: new Date() },
              });

              // Notification with links to pending action for inline approve/reject
              const notifTitle = `${AGENT_NOTIFICATION_PREFIX} ${riskLabel}: ${fnName}`;
              const riskLink = `/chat/${agentConvo.id}`;
              const notification = await (prisma.notification.create as Function)({
                data: {
                  userId,
                  type: "agent_proposal",
                  title: notifTitle,
                  message: proposalMessage,
                  link: riskLink,
                  conversationId: agentConvo.id,
                  pendingActionId: (pendingAction as { id: string }).id,
                },
              });
              pushNotification(userId, {
                id: notification.id,
                type: "insight",
                title: notifTitle,
                message: proposalMessage,
                createdAt: notification.createdAt.toISOString(),
                conversationId: agentConvo.id,
                link: riskLink,
              });
              sendPushNotification(
                userId,
                {
                  title: notifTitle,
                  body: proposalMessage.slice(0, 100),
                  url: riskLink,
                },
                "agent_proposal",
              );

              // Notify sidebar to refresh
              pushNotification(userId, {
                id: "sidebar-refresh",
                type: "system",
                title: "conversations-updated",
                message: "",
                createdAt: new Date().toISOString(),
              });

              result = JSON.stringify({
                success: true,
                proposed: true,
                riskLevel,
                conversationId: agentConvo.id,
              });
              await logAgentAction(
                userId,
                "propose",
                `[${riskLevel}] Risk-gated ${fnName}: ${JSON.stringify(args).slice(0, 100)}`,
                fnName,
              );
              console.log(
                `[AGENT] Risk-gated (${riskLevel}) ${fnName} for ${userId} → proposal created`,
              );
            }

            messages.push({
              role: "tool",
              content: result,
              tool_call_id: toolCall.id,
            });
            continue;
          }

          // Dedup: prevent repeating the same tool call on the same target within 1 hour
          const TOOL_DEDUP_HOURS = 1;
          const toolDedupSince = new Date(Date.now() - TOOL_DEDUP_HOURS * 60 * 60 * 1000);
          const recentSameAction = await db.agentLog.findFirst({
            where: {
              userId,
              action: "auto_action",
              tool: fnName,
              summary: { contains: JSON.stringify(args).slice(0, 50) },
              createdAt: { gte: toolDedupSince },
            },
          });
          if (recentSameAction) {
            result = JSON.stringify({
              skipped: true,
              reason: `already executed ${fnName} recently`,
            });
            await logAgentAction(
              userId,
              "skip",
              `Dedup: ${fnName} already ran within ${TOOL_DEDUP_HOURS}h`,
            );
            messages.push({
              role: "tool",
              content: result,
              tool_call_id: toolCall.id,
            });
            continue;
          }

          // Dedup: prevent sending same email reply repeatedly across cycles (DB-based, survives restarts)
          if (fnName === "send_email") {
            const emailSubject = (args as { subject?: string }).subject || "";
            const alreadyReplied = await hasRepliedToEmail(userId, emailSubject);

            if (alreadyReplied) {
              result = JSON.stringify({
                skipped: true,
                reason: "already replied to this email",
              });
              await logAgentAction(userId, "skip", `Dedup: already replied to "${emailSubject}"`);
              console.log(`[AGENT] Skipped duplicate email reply for ${userId}: ${emailSubject}`);
              messages.push({
                role: "tool",
                content: result,
                tool_call_id: toolCall.id,
              });
              continue;
            }
          }

          // Plan-based tool gating — reject tools not allowed for user's plan
          if (!isToolAllowedForPlan(fnName, userPlan)) {
            result = JSON.stringify({
              error: `Tool "${fnName}" requires a higher plan. Current plan: ${userPlan}`,
              upgrade_required: true,
            });
            messages.push({
              role: "tool",
              content: result,
              tool_call_id: toolCall.id,
            });
            continue;
          }

          result = await executeToolCall(userId, fnName, args);

          // After successful send_email, optionally mark original email as read in Gmail.
          // Gated by AutomationConfig.autoMarkReadEnabled (default off) so users who rely
          // on Gmail's unread state as a fallback inbox don't silently lose it.
          if (fnName === "send_email" && !result.includes('"error"')) {
            console.log(
              `[AGENT] Marked email as replied: ${(args as { subject?: string }).subject}`,
            );

            const markReadConfig = (await prisma.automationConfig.findUnique({
              where: { userId },
              select: { autoMarkReadEnabled: true },
            })) as { autoMarkReadEnabled?: boolean } | null;
            const autoMarkReadEnabled = markReadConfig?.autoMarkReadEnabled === true;

            if (autoMarkReadEnabled) {
              try {
                const replySubject = ((args as { subject?: string }).subject || "")
                  .replace(/^Re:\s*/i, "")
                  .toLowerCase()
                  .trim();
                const replyTo = ((args as { to?: string }).to || "").toLowerCase().trim();
                const unreadEmails = await prisma.emailMessage.findMany({
                  where: {
                    userId,
                    isRead: false,
                    receivedAt: {
                      gte: new Date(Date.now() - 48 * 60 * 60 * 1000),
                    },
                  },
                  select: { id: true, gmailId: true, subject: true, from: true },
                });
                for (const ue of unreadEmails) {
                  const ueSubject = (ue.subject || "")
                    .replace(/^Re:\s*/i, "")
                    .toLowerCase()
                    .trim();
                  const ueFrom = (ue.from || "").toLowerCase();
                  if (
                    (replySubject && ueSubject.includes(replySubject.slice(0, 20))) ||
                    (replyTo && ueFrom.includes(replyTo))
                  ) {
                    if (ue.gmailId) {
                      await markAsRead(userId, ue.gmailId).catch((err: unknown) =>
                        console.warn(`[AGENT] Failed to mark ${ue.gmailId} as read:`, err),
                      );
                      console.log(
                        `[AGENT] Marked Gmail message as read: ${ue.gmailId} (${ue.subject})`,
                      );
                    } else {
                      await prisma.emailMessage.update({
                        where: { id: ue.id },
                        data: { isRead: true },
                      });
                      console.log(`[AGENT] Marked DB email as read (no gmailId): ${ue.subject}`);
                    }
                    // Log processing so we can distinguish Eve-touched vs user-read emails later.
                    await (
                      prisma as unknown as {
                        emailProcessingLog: {
                          create: (args: unknown) => Promise<unknown>;
                        };
                      }
                    ).emailProcessingLog
                      .create({
                        data: {
                          userId,
                          emailId: ue.id,
                          mode: "AUTO",
                          action: "mark_read",
                        },
                      })
                      .catch((err: unknown) =>
                        console.warn("[AGENT] EmailProcessingLog insert failed:", err),
                      );
                  }
                }
              } catch (err) {
                console.warn(`[AGENT] Failed to mark email as read in Gmail:`, err);
              }
            } else {
              console.log(
                `[AGENT] Skipping auto-markAsRead for user ${userId} (autoMarkReadEnabled=false)`,
              );
            }
          }

          const action = isSafeWrite ? "auto_action" : "tool_call";
          await logAgentAction(
            userId,
            action,
            `Called ${fnName} with ${JSON.stringify(args).slice(0, 200)}`,
            fnName,
          );

          // Auto-notify user about automatic actions taken
          if (isSafeWrite && isAutoMode) {
            const { autoTitle, autoMessage } = humanizeAutoExec(fnName, args);
            // Dedicated list pages (/calendar, /email, /tasks, /notes) were
            // removed in Week 1. Every auto-executed action now opens the
            // chat so the user can review or continue the thread.
            const autoLink = "/chat";
            const notification = await (prisma.notification.create as Function)({
              data: {
                userId,
                type: "insight",
                title: autoTitle,
                message: autoMessage,
                link: autoLink,
              },
            });
            pushNotification(userId, {
              id: notification.id,
              type: "insight",
              title: autoTitle,
              message: autoMessage,
              createdAt: notification.createdAt.toISOString(),
              link: autoLink,
            });

            // No phone push for LOW-risk auto-exec — the DB notification above
            // keeps the bell badge updating, but we no longer ring the phone
            // for every tool call. A single cycle that updates N tasks used
            // to fire N pushes in one second (see 2026-04-20 dogfood logs).
            console.log(`[AGENT] Auto-executed ${fnName} for ${userId}`);
          }
        }

        messages.push({
          role: "tool",
          content: result,
          tool_call_id: toolCall.id,
        });
      }

      if (toolCallCount >= MAX_TOOL_CALLS) break;
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[AGENT] Cycle for ${userId} completed in ${elapsed}ms (${toolCallCount} tool calls)`,
    );
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const message = err instanceof Error ? err.message : "Unknown error";
    await logAgentAction(userId, "error", `Agent error after ${elapsed}ms: ${message}`);
    console.error(`[AGENT] Error for ${userId} after ${elapsed}ms:`, err);
    captureError(err, {
      tags: { area: "autonomous_agent" },
      extra: { userId, elapsedMs: elapsed },
    });
  }
}

const PENDING_ACTION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — expire faster to prevent blocking

/** Expire stale pending actions — prevents deadlock when user ignores proposals */
async function expireStalePendingActions() {
  try {
    const cutoff = new Date(Date.now() - PENDING_ACTION_TTL_MS);
    type ExpiringRow = {
      id: string;
      userId: string;
      toolName: string;
      toolArgs: string;
      conversationId: string;
    };
    const expiringRows = (await db.pendingAction.findMany({
      where: { status: "PENDING", createdAt: { lt: cutoff } },
      select: { id: true, userId: true, toolName: true, toolArgs: true, conversationId: true },
    })) as ExpiringRow[];
    const expired = await db.pendingAction.updateMany({
      where: { status: "PENDING", createdAt: { lt: cutoff } },
      data: { status: "REJECTED", result: "자동 만료 (24시간 초과)" },
    });
    if (expired.count > 0) {
      console.log(`[AGENT] Expired ${expired.count} stale pending action(s)`);
      await bulkResolveAttentionForPendingActions(
        expiringRows.map((r: ExpiringRow) => r.id),
        "REJECTED",
      );
      // IGNORED is a distinct policy signal from REJECTED — the user didn't
      // say no, they just never showed up. Step 8.2 will weight these
      // differently when extracting "this user ignores X" rules.
      await Promise.all(
        expiringRows.map((row: ExpiringRow) =>
          recordFeedback({
            userId: row.userId,
            source: "PENDING_ACTION",
            sourceId: row.id,
            signal: "IGNORED",
            toolName: row.toolName,
            recipient: recipientFromToolArgs(row.toolArgs),
            threadId: row.conversationId,
          }),
        ),
      );
    }
  } catch {
    // Non-critical
  }
}

/** Main scheduler loop — checks all users, respects per-user interval */
async function runAutonomousAgent() {
  // Expire stale pending actions before running new cycles
  await expireStalePendingActions();

  // DB-based dedup — no in-memory pruning needed

  try {
    const configs = await prisma.automationConfig.findMany();

    // Prune lastRunTime for users no longer in configs (prevents unbounded growth)
    const activeUserIds = new Set(configs.map((c) => c.userId));
    for (const userId of lastRunTime.keys()) {
      if (!activeUserIds.has(userId)) lastRunTime.delete(userId);
    }
    if (configs.length === 0) return;

    const now = Date.now();

    // Fetch user plans for feature gating
    const userIds = configs.map((c) => c.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, plan: true },
    });
    const userPlanMap = new Map(users.map((u) => [u.id, u.plan]));

    // Filter users that are due for a run
    const usersToRun: Array<{ userId: string; mode: AgentMode }> = [];
    for (const config of configs) {
      const cfg = config as unknown as Record<string, unknown>;
      if (cfg.autonomousAgent === false) continue;

      // Plan-based gating: autonomous agent requires PRO+ plan
      const userPlan = userPlanMap.get(config.userId) || "FREE";
      if (!planHasFeature(userPlan, "autonomous_agent")) {
        continue;
      }

      const intervalMs = ((cfg.agentIntervalMin as number) || 5) * 60 * 1000;
      const lastRun = lastRunTime.get(config.userId) || 0;
      if (now - lastRun < intervalMs - 30_000) continue;

      // Plan-based mode gating: AUTO mode requires TEAM+ plan
      let mode = normalizeAgentMode(cfg.agentMode);
      if (mode === "AUTO" && !planHasFeature(userPlan, "agent_mode_auto")) {
        mode = "SUGGEST"; // Downgrade to SUGGEST for PRO users
      }

      lastRunTime.set(config.userId, now);
      usersToRun.push({ userId: config.userId, mode });
    }

    // Run in parallel with concurrency limit (not sequential)
    for (let i = 0; i < usersToRun.length; i += CONCURRENCY_LIMIT) {
      const batch = usersToRun.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.allSettled(
        batch.map(({ userId, mode }) =>
          runAgentForUser(userId, mode).catch((err) => {
            console.error(`[AGENT] Unhandled error for ${userId}:`, err);
          }),
        ),
      );
    }
  } catch (err) {
    console.error("[AGENT] Scheduler error:", err);
  }
}

/** Start the autonomous agent scheduler */
export function startAutonomousAgent() {
  if (intervalId) return;

  if (!openai) {
    console.log("[AGENT] Autonomous agent disabled — no LLM configured");
    return;
  }

  console.log("[AGENT] Autonomous agent started (checking every 60s)");

  // First run after 30 seconds
  setTimeout(() => {
    runAutonomousAgent();
  }, 30_000);

  // Check every minute, respects per-user intervals
  intervalId = setInterval(runAutonomousAgent, CHECK_INTERVAL_MS);
}

/** Stop the autonomous agent */
export function stopAutonomousAgent() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[AGENT] Autonomous agent stopped");
  }
}
