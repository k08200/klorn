/**
 * Shared Tool Executor — Used by both chat routes and autonomous agent
 *
 * Extracts executeToolCall from chat.ts so background agents can use the same tools.
 */

import {
  type ActionReceipt,
  ActionReceiptMismatchError,
  ActionReceiptSchemaError,
  sendEmailPayloadHash,
  verifyReceipt,
} from "./attention-floor.js";
import { upsertAttentionForCalendarEvent } from "./attention-mirror.js";
import { BRIEFING_TOOLS } from "./briefing.js";
import {
  CALENDAR_TOOLS,
  checkConflicts,
  createEvent,
  deleteEvent,
  listEvents,
} from "./calendar.js";
import { prisma } from "./db.js";
import {
  classifyEmails,
  GMAIL_TOOLS,
  listEmails,
  markAsRead,
  readEmail,
  sendEmail,
} from "./gmail.js";
import { getUpcomingMeetings, joinMeeting, MEETING_TOOLS, summarizeMeeting } from "./meeting.js";
import { forget, MEMORY_TOOLS, recall, remember } from "./memory.js";
import { SEARCH_TOOLS, webSearch } from "./search.js";
import { captureError } from "./sentry.js";
import { executeSkill, listUserSkills, SKILL_TOOLS } from "./skill-executor.js";
import { planHasFeature, TOOL_FEATURE_MAP } from "./stripe.js";
import { capToolResult } from "./tool-result-budget.js";
import {
  calculate,
  convertCurrency,
  generatePassword,
  shortenUrl,
  translate,
  UTILITY_TOOLS,
} from "./utilities.js";

const TIME_TOOL = {
  type: "function" as const,
  function: {
    name: "get_current_time",
    description: "Get current date and time in KST (Korean Standard Time) and UTC.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const GOOGLE_TOOLS = [...GMAIL_TOOLS, ...CALENDAR_TOOLS];

export const ALWAYS_TOOLS = [
  ...SEARCH_TOOLS,
  ...BRIEFING_TOOLS,
  ...MEETING_TOOLS,
  ...UTILITY_TOOLS,
  ...MEMORY_TOOLS,
  ...SKILL_TOOLS,
  TIME_TOOL,
];

// The full tool surface. NOTE: importing this does NOT grant the agent these
// tools. The autonomous agent only receives mutating tools when the user has
// explicitly opted into AUTO mode (see autonomous-agent.ts — SUGGEST, the
// default, hands the model read-only tools and propose_action only). The three
// irreversible actions (send_email / permanent_delete / forward_external) sit
// behind the ActionReceipt deterministic floor regardless of mode.
export const ALL_TOOLS = [...ALWAYS_TOOLS, ...GOOGLE_TOOLS];

/**
 * Return tools available for a given user plan.
 * Filters out tools that require features not included in the plan.
 * @param hasGoogle - whether user has Google OAuth connected
 * @param plan - user's billing plan (FREE, PRO, TEAM, ENTERPRISE)
 */
export function getToolsForPlan(hasGoogle: boolean, plan: string) {
  const base = hasGoogle ? ALL_TOOLS : [...ALWAYS_TOOLS];
  return base.filter((tool) => {
    const featureKey = TOOL_FEATURE_MAP[tool.function.name];
    // Tools not in the map are always available.
    if (!featureKey) return true;
    return planHasFeature(plan, featureKey);
  });
}

/**
 * Check if a specific tool call is allowed for a plan.
 * Used by autonomous agent and tool executor to reject gated calls at runtime.
 */
export function isToolAllowedForPlan(toolName: string, plan: string): boolean {
  const featureKey = TOOL_FEATURE_MAP[toolName];
  if (!featureKey) return true;
  return planHasFeature(plan, featureKey);
}

/** Basic string guard — returns trimmed string or throws */
function requireString(val: unknown, name: string): string {
  if (typeof val !== "string" || val.trim().length === 0) {
    throw new Error(`Missing or invalid parameter: ${name}`);
  }
  return val.trim();
}

/** Clamp numeric arg to a safe range */
function safeInt(val: unknown, fallback: number, max: number): number {
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.round(n), max);
}

/**
 * Deterministic-floor enforcement on the caller side. When the tool being
 * invoked is in FLOOR_ACTIONS, the caller MUST provide a verified
 * ActionReceipt — otherwise this throws FloorReceiptRequiredError and the
 * action is refused before any side-effect.
 *
 * The receipt is minted at /approve time (chat-pending-actions.ts) so
 * direct executeToolCall callers (autonomous-agent, batch-executor) that
 * try to side-step the user approval flow now fail closed instead of
 * silently sending mail / forwarding / hard-deleting.
 */
export class FloorReceiptRequiredError extends Error {
  constructor(public readonly toolName: string) {
    super(`floor action "${toolName}" requires a verified ActionReceipt — none provided`);
    this.name = "FloorReceiptRequiredError";
  }
}

export async function executeToolCall(
  userId: string,
  functionName: string,
  args: Record<string, unknown>,
  receipt?: ActionReceipt | null,
): Promise<string> {
  const raw = await executeToolCallInternal(userId, functionName, args, receipt ?? null);
  return capToolResult(raw);
}

async function executeToolCallInternal(
  userId: string,
  functionName: string,
  args: Record<string, unknown>,
  receipt: ActionReceipt | null,
): Promise<string> {
  try {
    switch (functionName) {
      case "list_emails":
        return JSON.stringify(await listEmails(userId, safeInt(args.max_results, 10, 100)));
      case "read_email":
        return JSON.stringify(await readEmail(userId, requireString(args.email_id, "email_id")));
      case "send_email": {
        const to = requireString(args.to, "to");
        const subject = requireString(args.subject, "subject");
        const body = requireString(args.body, "body");
        // Floor: refuse to execute without a verified receipt. The receipt's
        // payloadHash must match a fresh hash of the bytes about to leave.
        if (!receipt) throw new FloorReceiptRequiredError("send_email");
        verifyReceipt(receipt, {
          action: "send_email",
          currentPayloadHash: sendEmailPayloadHash({ to, subject, body }),
        });
        return JSON.stringify(await sendEmail(userId, to, subject, body));
      }
      case "classify_emails":
        return JSON.stringify(await classifyEmails(userId, safeInt(args.max_results, 10, 100)));
      case "mark_read":
        return JSON.stringify(await markAsRead(userId, requireString(args.email_id, "email_id")));
      case "list_events":
        return JSON.stringify(await listEvents(userId, safeInt(args.max_results, 10, 200)));
      case "create_event": {
        const evSummary = requireString(args.summary, "summary");
        const evStart = requireString(args.start_time, "start_time");
        const evEnd = requireString(args.end_time, "end_time");

        // Dedup: check if a similar event already exists within ±30 min
        const evStartDate = new Date(evStart);
        const dupCheck = await prisma.calendarEvent.findFirst({
          where: {
            userId,
            startTime: {
              gte: new Date(evStartDate.getTime() - 30 * 60_000),
              lte: new Date(evStartDate.getTime() + 30 * 60_000),
            },
          },
        });
        if (dupCheck) {
          return JSON.stringify({
            skipped: true,
            message: `이미 같은 시간대에 이벤트가 있습니다: "${dupCheck.title}" (${dupCheck.startTime.toISOString()})`,
            existingEventId: dupCheck.id,
          });
        }

        const evResult = await createEvent(
          userId,
          evSummary,
          evStart,
          evEnd,
          args.description as string | undefined,
          args.location as string | undefined,
        );

        // Refuse to create a local row when Google insert failed. Otherwise
        // we end up with an orphan row whose startTime is whatever string
        // the LLM produced, with no way to reconcile against the source of
        // truth. The 2026-06-04 +13h shift was a direct consequence of
        // these orphans — Klorn showed agent-fabricated times that were
        // never in Google.
        if ("error" in evResult) {
          return JSON.stringify(evResult);
        }

        const evGoogleId =
          "eventId" in evResult && evResult.eventId ? (evResult.eventId as string) : null;

        // Use Google's canonical timestamps for local DB. These are what
        // Google actually stored after applying its own offset/timeZone
        // resolution, so they round-trip through subsequent syncs cleanly.
        // Fall back to the LLM input only if Google didn't echo back a
        // dateTime (rare; defensive).
        const canonicalStart =
          "canonicalStart" in evResult && typeof evResult.canonicalStart === "string"
            ? evResult.canonicalStart
            : evStart;
        const canonicalEnd =
          "canonicalEnd" in evResult && typeof evResult.canonicalEnd === "string"
            ? evResult.canonicalEnd
            : evEnd;
        const localEvent = await prisma.calendarEvent.create({
          data: {
            userId,
            title: evSummary,
            description: (args.description as string) || null,
            startTime: new Date(canonicalStart),
            endTime: new Date(canonicalEnd),
            location: (args.location as string) || null,
            googleId: evGoogleId,
          },
        });
        await upsertAttentionForCalendarEvent(localEvent);

        return JSON.stringify(evResult);
      }
      case "delete_event":
        return JSON.stringify(await deleteEvent(userId, requireString(args.event_id, "event_id")));
      case "check_calendar_conflicts":
        return JSON.stringify(
          await checkConflicts(
            userId,
            requireString(args.start_time, "start_time"),
            requireString(args.end_time, "end_time"),
          ),
        );
      case "generate_briefing": {
        const { createDailyBriefingDelivery } = await import("./briefing.js");
        const { briefing, note, notification, reused } = await createDailyBriefingDelivery(userId);
        return JSON.stringify({ briefing, note, notification, reused });
      }
      case "web_search":
        return JSON.stringify(
          await webSearch(requireString(args.query, "query"), safeInt(args.max_results, 5, 20)),
        );
      case "get_current_time": {
        const now = new Date();
        const kstFmt = new Intl.DateTimeFormat("sv-SE", {
          timeZone: "Asia/Seoul",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        });
        return JSON.stringify({
          utc: now.toISOString(),
          kst: kstFmt.format(now).replace(" ", "T") + "+09:00",
          formatted_kst: now.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
          day_of_week: now.toLocaleDateString("ko-KR", { weekday: "long", timeZone: "Asia/Seoul" }),
        });
      }
      case "get_upcoming_meetings":
        return JSON.stringify(await getUpcomingMeetings(userId));
      case "join_meeting":
        return JSON.stringify(await joinMeeting(requireString(args.meeting_link, "meeting_link")));
      case "summarize_meeting":
        return JSON.stringify(
          await summarizeMeeting(
            userId,
            requireString(args.title, "title"),
            requireString(args.notes, "notes"),
            (args.attendees as string[]) || [],
          ),
        );
      case "translate_text":
        return JSON.stringify(
          await translate(
            requireString(args.text, "text"),
            requireString(args.from, "from"),
            requireString(args.to, "to"),
          ),
        );
      case "shorten_url":
        return JSON.stringify(await shortenUrl(requireString(args.url, "url")));
      case "calculate":
        return JSON.stringify(calculate(requireString(args.expression, "expression")));
      case "convert_currency":
        return JSON.stringify(
          await convertCurrency(
            typeof args.amount === "number" ? args.amount : Number(args.amount) || 0,
            requireString(args.from, "from"),
            requireString(args.to, "to"),
          ),
        );
      case "generate_password":
        return JSON.stringify(generatePassword(safeInt(args.length, 16, 64)));
      case "remember":
        return await remember(
          userId,
          requireString(args.type, "type"),
          requireString(args.key, "key"),
          requireString(args.content, "content"),
        );
      case "recall":
        return await recall(
          userId,
          args.query as string | undefined,
          args.type as string | undefined,
        );
      case "forget":
        return await forget(
          userId,
          requireString(args.key, "key"),
          requireString(args.type, "type"),
        );
      case "record_skill": {
        const skillKey = requireString(args.key, "key");
        const skillName = requireString(args.name, "name");
        const skillPrompt = requireString(args.prompt, "prompt");
        const recorded = await prisma.skill.upsert({
          where: { userId_key: { userId, key: skillKey } },
          create: {
            userId,
            key: skillKey,
            name: skillName,
            description: "Auto-recorded from repeated usage pattern",
            prompt: skillPrompt,
          },
          update: { name: skillName, prompt: skillPrompt },
        });
        return JSON.stringify({ ok: true, key: recorded.key, name: recorded.name });
      }
      case "execute_skill":
        return JSON.stringify(
          await executeSkill(
            userId,
            requireString(args.skill_name, "skill_name"),
            (args.variables as Record<string, string>) || undefined,
          ),
        );
      case "list_skills":
        return JSON.stringify(await listUserSkills(userId));
      default:
        return JSON.stringify({ error: `Unknown function: ${functionName}` });
    }
  } catch (err) {
    // Floor refusals bubble up to the caller (e.g. the /approve route) so
    // the PendingAction can be rolled back to FAILED and the audit row
    // captures the verify failure. Wrapping these in a tool-result string
    // would let the LLM read "execution failed" and silently move on,
    // which is the exact silent-failure mode the floor is meant to refuse.
    if (
      err instanceof FloorReceiptRequiredError ||
      err instanceof ActionReceiptMismatchError ||
      err instanceof ActionReceiptSchemaError
    ) {
      captureError(err, {
        tags: { area: "tool_executor", tool: functionName, scope: "floor_refusal" },
        extra: { userId, argKeys: Object.keys(args) },
      });
      throw err;
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    captureError(err, {
      tags: { area: "tool_executor", tool: functionName },
      extra: { userId, argKeys: Object.keys(args) },
    });
    return JSON.stringify({ error: message });
  }
}
