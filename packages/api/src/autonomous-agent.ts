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
import type { Prisma } from "@prisma/client";
import type OpenAI from "openai";
import { resolveActionTarget } from "./action-target.js";
import { AGENT_SYSTEM_PROMPT, NOTIFY_TOOL, PROPOSE_ACTION_TOOL } from "./agent/prompt.js";
import { gatherUserContext } from "./agent-context.js";
import { recordDedupKey, wasRecentlyDeduped } from "./agent-dedup.js";
import {
  areSimilarProposalIssues,
  getNotifKey,
  getToolRisk,
  isHousekeepingProposalToolName,
  TOOL_RISK_LEVELS,
} from "./agent-logic.js";
import { type AgentMode, getAgentModePolicy } from "./agent-mode.js";
import {
  AGENT_NOTIFICATION_PREFIX,
  findRecentSimilarProposal,
  hasRecentNotification,
  hasRepliedToEmail,
  LEGACY_AGENT_NOTIFICATION_PREFIX,
  safeJson,
} from "./agent-proposal-dedup.js";
import { upsertAttentionForPendingAction } from "./attention-mirror.js";
import { AGENT_MAX_CONTEXT_ITEMS, AGENT_MAX_TOOLS_PER_LOOP } from "./config.js";
import { db, prisma } from "./db.js";
import { recipientFromToolArgs, recordFeedback } from "./feedback.js";
import { isNoReplyAddress, markAsRead } from "./gmail.js";
import { loadMemoriesForPrompt } from "./memory.js";
import { humanizeAutoExec } from "./notification-format.js";
import { notificationSuppressionReason } from "./notification-policy.js";
import type { NotifCategory } from "./notification-prefs.js";
import { AGENT_MODEL, createCompletion } from "./openai.js";
import { getFeedbackPolicyContextForPrompt } from "./policy-extraction.js";
import { sendPushNotification } from "./push.js";
import { captureError } from "./sentry.js";
import { trackTokenUsage } from "./token-usage.js";
import { ALL_TOOLS, executeToolCall, isToolAllowedForPlan } from "./tool-executor.js";
import { pushNotification } from "./websocket.js";

const MAX_TOOL_CALLS = AGENT_MAX_TOOLS_PER_LOOP;
const MAX_CONTEXT_ITEMS = AGENT_MAX_CONTEXT_ITEMS;

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

const EXECUTABLE_TOOL_NAMES = new Set(
  ALL_TOOLS.map((tool) => (tool as { function?: { name?: string } }).function?.name).filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  ),
);

// Proposal/notification dedup helpers and the prefix constants live in
// agent-proposal-dedup.ts so they can be tested without booting the
// full agent runtime. The autonomous loop imports what it needs at the
// top of this file.

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
  } catch (err) {
    console.warn("[AGENT] logAgentAction failed (audit gap):", err);
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
  } catch (err) {
    console.warn("[AGENT] getAgentFeedback failed:", err);
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
  } catch (err) {
    console.warn("[AGENT] getProposalHistory failed:", err);
    return "";
  }
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

/**
 * True when the context has nothing worth a real LLM call: no tasks, no
 * calendar, no emails — OR gatherUserContext's own outer catch fired
 * (context === ""). Without the empty-string branch, a total context
 * failure fell through to a real, paid LLM call with a blank user message
 * instead of skipping the tick the way every other failure mode does.
 */
export function isAgentContextEmpty(context: string): boolean {
  if (context === "") return true;
  return (
    context.includes("## Open Tasks\nNone") &&
    context.includes("## Upcoming Calendar\nNone") &&
    !context.includes("## Recent Emails")
  );
}

/** Run the autonomous reasoning loop for a single user */
// Per-user re-entrancy guard. The scheduler tick and the email-action fast-path
// (email-action-trigger.ts) both call runAgentForUser through separate,
// uncoordinated debounce maps, so an actionable email arriving during a
// scheduler tick for the same user would otherwise run the agent twice
// concurrently — double LLM spend and a race on proposal dedup. In-process only;
// the cross-dyno guard is the advisory lock in autonomous-agent-scheduler.ts.
const runningUsers = new Set<string>();

export async function runAgentForUser(
  userId: string,
  mode: AgentMode | string = "SUGGEST",
): Promise<void> {
  if (runningUsers.has(userId)) {
    console.log(`[AGENT] ${userId} already in flight — skipping re-entrant run`);
    return;
  }
  const startTime = Date.now();
  const agentModePolicy = getAgentModePolicy(mode);
  runningUsers.add(userId);

  try {
    // Load user plan and model for tool gating
    const agentUser = await prisma.user.findUnique({ where: { id: userId } });
    const userPlan = agentUser?.plan || "FREE";
    // Thread role so planHasFeature's ADMIN bypass applies to the in-loop tool
    // gate too — without it an ADMIN on a FREE plan has every tool rejected
    // mid-loop once the paywall locks FREE (the scheduler already passes role).
    const userRole = agentUser?.role ?? undefined;
    // The agent conversation is a CONVERSATIONAL surface: the user's chosen
    // frontier chat model applies here (their agent talks in the model they
    // trust). Unset → the pinned AGENT_MODEL. BYOK keys ride along so a
    // key-holder's cycles bill their own account.
    const { getUserLlmCredentials } = await import("./llm-credentials.js");
    const agentCredentials = await getUserLlmCredentials(userId);
    const agentModelForUser = agentCredentials.userModel ?? AGENT_MODEL;

    const { analyzePatterns } = await import("./pattern-learner.js");
    const { buildTrustHintForPrompt } = await import("./trust-score.js");
    const { buildInteractionHintForPrompt } = await import("./interaction-graph.js");
    const { buildPlaybookHintForPrompt } = await import("./playbooks.js");
    const { buildRejectionHintForPrompt } = await import("./rejection-hint.js");
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
      rejectionHint,
    ] = await Promise.all([
      // gatherUserContext is internally fail-soft per query now (agent-context.ts),
      // but still add the same outer safety net as its 9 siblings here — a
      // future change adding a new non-fail-soft branch there shouldn't be
      // able to abort the whole agent cycle for this user again.
      gatherUserContext(userId).catch(() => ""),
      getAgentFeedback(userId),
      loadMemoriesForPrompt(userId).catch(() => ""),
      getProposalHistory(userId).catch(() => ""),
      analyzePatterns(userId).catch(() => ""),
      getFeedbackPolicyContextForPrompt(userId).catch(() => ""),
      buildTrustHintForPrompt(userId).catch(() => ""),
      buildInteractionHintForPrompt(userId).catch(() => ""),
      buildPlaybookHintForPrompt(userId).catch(() => ""),
      buildRejectionHintForPrompt(userId).catch(() => ""),
    ]);

    if (isAgentContextEmpty(context)) {
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
- classify_emails

### MEDIUM risk (system will ask user for approval):
- create_event, send_email

### HIGH risk (system will warn user before approval):
- delete_event, archive_email, delete_email

You MUST call tools directly. Do NOT use propose_action.
LOW-risk tools execute instantly. MEDIUM/HIGH tools are automatically converted to approval proposals.
Email replies are never sent silently in this build. send_email must become an approval proposal unless the server explicitly allows it.

## Notification policy (STRICT — read carefully)

Routine housekeeping is SILENT. The user reviews these in the daily receipt at /inbox/receipt — they DO NOT need a push for each one.

Do NOT call notify_user after:
- mark_read (the email is just less unread)
- classify_emails (a background batch finished)
- list_skills / execute_skill (internal lookups)
- any tool whose outcome the user can see by opening the inbox or the receipt page

Call notify_user ONLY when one of these is true:
- (a) NEW INFORMATION the user can't see otherwise — e.g. generate_briefing produced today's briefing, a security alert was detected, a deadline was found in mail
- (b) TIME-SENSITIVE — something needs the user's attention within hours
- (c) A MEDIUM/HIGH tool was just approved and executed — the user explicitly opted in and should see the outcome

If the only reason you'd call notify_user is "I just did something," DO NOT call it. The receipt page handles that.

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
2. call send_email only to prepare an approval proposal for the reply
3. call notify_user only when (a) a MEDIUM/HIGH tool actually executed and the outcome matters, or (b) the situation is time-sensitive enough that a push beats the user opening the receipt page. Routine "I read your mail" is NOT a reason.

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
- Sign off as the user (NOT as Klorn)
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
    if (rejectionHint) systemPromptWithMemory += rejectionHint;

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
      const response = await createCompletion(
        {
          model: agentModelForUser,
          messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          tools: agentTools,
          tool_choice: "auto",
          temperature: 0.3,
          max_tokens: 1000,
        },
        { userId, priority: "background", credentials: agentCredentials, useUserModel: true },
      );

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
          // Answer the tool_call even on a parse failure — an unanswered
          // tool_call 400s the next createCompletion and kills the whole cycle.
          messages.push({
            role: "tool",
            content: JSON.stringify({ error: "malformed tool arguments" }),
            tool_call_id: toolCall.id,
          });
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
                    title: `Klorn proposal - ${todayStr}`,
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
                  metadata: { source: "agent", hasAction: true },
                },
              });

              // Create the pending action
              const pendingAction = await db.pendingAction.create({
                data: {
                  conversationId: agentConvo.id,
                  messageId: assistantMsg.id,
                  userId,
                  toolName: proposedToolName,
                  // JSONB after migration 20260519060000 — pass the
                  // object directly; Prisma serializes into the column.
                  toolArgs: (args.toolArgs ?? {}) as Prisma.InputJsonValue,
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
                ).catch((err) => console.warn("[AGENT] proposal push failed", err));
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
            // Server-side guards — see notificationSuppressionReason()
            // for the rule. Two categories: marketing/promo "noise" and
            // mark_read/classify_emails "housekeeping" the user reviews
            // in the daily receipt page. Drop both before they hit push.
            const suppression = notificationSuppressionReason({
              title: args.title,
              message: args.message,
            });
            if (suppression) {
              result = JSON.stringify({
                skipped: true,
                reason:
                  suppression === "noise"
                    ? "noise notification suppressed"
                    : "housekeeping notification suppressed — user reviews these in the receipt",
              });
              await logAgentAction(
                userId,
                "skip",
                `${suppression === "noise" ? "Noise" : "Housekeeping"} suppressed: "${args.title}"`,
                "notify_user",
                args.category,
              );
              // Answer the tool_call before continuing — an unanswered tool_call
              // 400s the next createCompletion and aborts the agent cycle.
              messages.push({ role: "tool", content: result, tool_call_id: toolCall.id });
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
              ).catch((err) => console.warn("[AGENT] notify push failed", err));

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
                    title: `Klorn proposal - ${todayStr}`,
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
                  metadata: {
                    source: "agent",
                    hasAction: true,
                    riskLevel,
                  },
                },
              });

              // Create pending action for approve/reject
              const pendingAction = await db.pendingAction.create({
                data: {
                  conversationId: agentConvo.id,
                  messageId: assistantMsg.id,
                  userId,
                  toolName: fnName,
                  // JSONB after migration 20260519060000.
                  toolArgs: (args ?? {}) as Prisma.InputJsonValue,
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
              ).catch((err) => console.warn("[AGENT] risk push failed", err));

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
          if (!isToolAllowedForPlan(fnName, userPlan, userRole)) {
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
                  select: {
                    id: true,
                    gmailId: true,
                    subject: true,
                    from: true,
                    linkedInboxAccountId: true,
                  },
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
                      await markAsRead(userId, ue.gmailId, ue.linkedInboxAccountId).catch(
                        (err: unknown) =>
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

          // Auto-notify user about automatic actions taken.
          //
          // 2026-05-31 fix: humanizeAutoExec produces titles like
          // "[Klorn] Action complete" and bodies like "mark read finished"
          // for housekeeping tools. Those flood the bell — and previously
          // also flooded phone push. PR #456 dropped them from the
          // notify_user tool path; this branch is the OTHER path that
          // bypassed that guard. Apply the same rule here so the bell
          // and the in-app surface stay quiet for housekeeping work, the
          // same way the daily receipt page already does.
          if (isSafeWrite && isAutoMode) {
            const { autoTitle, autoMessage } = humanizeAutoExec(fnName, args);
            const suppression = notificationSuppressionReason({
              title: autoTitle,
              message: autoMessage,
            });
            if (suppression) {
              console.log(
                `[AGENT] Auto-executed ${fnName} for ${userId} — ${suppression} notification suppressed`,
              );
            } else {
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
              // for every tool call.
              console.log(`[AGENT] Auto-executed ${fnName} for ${userId}`);
            }
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
    const errName = err instanceof Error ? err.name : "";
    // Expected back-pressure from the quota/cost guards — these are NOT bugs.
    // The user has either hit their per-day cost cap, their per-user RPM /
    // background-bucket limit, or every LLM provider is in cooldown. Log
    // quietly, skip Sentry, and let the next cycle recover when the window
    // resets (5 min / next UTC midnight).
    if (
      errName === "DailyCostCapExceededError" ||
      errName === "UserRateLimitedError" ||
      errName === "AllProvidersExhaustedError"
    ) {
      const reason =
        errName === "DailyCostCapExceededError"
          ? "Daily cost cap reached"
          : errName === "UserRateLimitedError"
            ? "User rate limit reached"
            : "All LLM providers in cooldown";
      await logAgentAction(userId, "skipped", `${reason}; skipping cycle`);
      console.log(`[AGENT] ${reason} for ${userId}; skipping cycle`);
      return;
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    await logAgentAction(userId, "error", `Agent error after ${elapsed}ms: ${message}`);
    console.error(`[AGENT] Error for ${userId} after ${elapsed}ms:`, err);
    captureError(err, {
      tags: { area: "autonomous_agent" },
      extra: { userId, elapsedMs: elapsed },
    });
  } finally {
    runningUsers.delete(userId);
  }
}
