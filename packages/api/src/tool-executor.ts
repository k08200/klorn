/**
 * Shared Tool Executor — Used by both chat routes and autonomous agent
 *
 * Extracts executeToolCall from chat.ts so background agents can use the same tools.
 */

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
  FILE_TOOLS,
  listRecentDownloads,
  organizeDownloads,
  readAndSummarize,
  searchFiles,
} from "./files.js";
import {
  classifyEmails,
  GMAIL_TOOLS,
  listEmails,
  markAsRead,
  readEmail,
  sendEmail,
} from "./gmail.js";
import {
  IMESSAGE_TOOLS,
  isIMessageAvailable,
  listRecentChats as listIMessageChats,
  readIMessages,
  sendIMessage,
} from "./imessage.js";
import {
  getClipboard,
  getRunningApps,
  getSystemInfo,
  isMacOS,
  MACOS_TOOLS,
  openItem,
  setClipboard,
  takeScreenshot,
} from "./macos.js";
import { getUpcomingMeetings, joinMeeting, MEETING_TOOLS, summarizeMeeting } from "./meeting.js";
import { forget, MEMORY_TOOLS, recall, remember } from "./memory.js";
import { getNews, NEWS_TOOLS } from "./news.js";
import {
  createNotionPage,
  listNotionDatabases,
  NOTION_CONFIGURED,
  NOTION_TOOLS,
  searchNotion,
} from "./notion.js";
import { SEARCH_TOOLS, webSearch } from "./search.js";
import { captureError } from "./sentry.js";
import { executeSkill, listUserSkills, SKILL_TOOLS } from "./skill-executor.js";
import { listSlackChannels, readSlackMessages, SLACK_TOOLS, sendSlackMessage } from "./slack.js";
import { planHasFeature, TOOL_FEATURE_MAP } from "./stripe.js";
import { capToolResult } from "./tool-result-budget.js";
import { wrapUntrusted } from "./untrusted.js";
import {
  calculate,
  convertCurrency,
  generatePassword,
  shortenUrl,
  translate,
  UTILITY_TOOLS,
} from "./utilities.js";
import { getWeather, WEATHER_TOOLS } from "./weather.js";
import { WRITER_TOOLS, writeDocument } from "./writer.js";

const SLACK_CONFIGURED = !!(process.env.SLACK_BOT_TOKEN || process.env.SLACK_WEBHOOK_URL);

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
  ...WRITER_TOOLS,
  ...BRIEFING_TOOLS,
  ...MEETING_TOOLS,
  ...FILE_TOOLS,
  ...WEATHER_TOOLS,
  ...NEWS_TOOLS,
  ...UTILITY_TOOLS,
  ...MEMORY_TOOLS,
  ...SKILL_TOOLS,
  TIME_TOOL,
  ...(SLACK_CONFIGURED ? SLACK_TOOLS : []),
  ...(NOTION_CONFIGURED ? NOTION_TOOLS : []),
  ...(isMacOS() ? MACOS_TOOLS : []),
  ...(isIMessageAvailable() ? IMESSAGE_TOOLS : []),
];

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

export async function executeToolCall(
  userId: string,
  functionName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const raw = await executeToolCallInternal(userId, functionName, args);
  return capToolResult(raw);
}

async function executeToolCallInternal(
  userId: string,
  functionName: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    switch (functionName) {
      case "list_emails":
        return JSON.stringify(await listEmails(userId, safeInt(args.max_results, 10, 100)));
      case "read_email":
        return JSON.stringify(await readEmail(userId, requireString(args.email_id, "email_id")));
      case "send_email":
        return JSON.stringify(
          await sendEmail(
            userId,
            requireString(args.to, "to"),
            requireString(args.subject, "subject"),
            requireString(args.body, "body"),
          ),
        );
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

        // Also save to local DB
        const evGoogleId =
          "eventId" in evResult && evResult.eventId ? (evResult.eventId as string) : null;
        const localEvent = await prisma.calendarEvent.create({
          data: {
            userId,
            title: evSummary,
            description: (args.description as string) || null,
            startTime: new Date(evStart),
            endTime: new Date(evEnd),
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
      case "send_slack_message":
        return JSON.stringify(
          await sendSlackMessage({
            channel: requireString(args.channel, "channel"),
            text: requireString(args.text, "text"),
            thread_ts: args.thread_ts as string | undefined,
          }),
        );
      case "list_slack_channels":
        return JSON.stringify(await listSlackChannels());
      case "read_slack_messages":
        return JSON.stringify(
          await readSlackMessages(
            requireString(args.channel, "channel"),
            safeInt(args.limit, 10, 100),
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
      case "write_document":
        return JSON.stringify(
          await writeDocument(
            userId,
            requireString(args.type, "type"),
            requireString(args.topic, "topic"),
            args.details as string | undefined,
          ),
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
      case "search_notion":
        return wrapUntrusted(
          JSON.stringify(await searchNotion(requireString(args.query, "query"))),
          "notion:search",
        );
      case "create_notion_page":
        return JSON.stringify(
          await createNotionPage(
            requireString(args.parent_id, "parent_id"),
            requireString(args.title, "title"),
            requireString(args.content, "content"),
          ),
        );
      case "list_notion_databases":
        return wrapUntrusted(JSON.stringify(await listNotionDatabases()), "notion:databases");
      case "send_imessage":
        return JSON.stringify(
          await sendIMessage(requireString(args.to, "to"), requireString(args.text, "text")),
        );
      case "read_imessages":
        return JSON.stringify(
          await readIMessages(requireString(args.from, "from"), safeInt(args.count, 10, 100)),
        );
      case "list_imessage_chats":
        return JSON.stringify(await listIMessageChats(safeInt(args.count, 20, 100)));
      case "get_clipboard":
        return JSON.stringify(await getClipboard());
      case "set_clipboard":
        return JSON.stringify(await setClipboard(requireString(args.text, "text")));
      case "get_running_apps":
        return JSON.stringify(await getRunningApps());
      case "open_item":
        return JSON.stringify(await openItem(requireString(args.path, "path")));
      case "get_system_info":
        return JSON.stringify(await getSystemInfo());
      case "take_screenshot":
        return JSON.stringify(await takeScreenshot());
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
      case "search_files":
        return JSON.stringify(
          await searchFiles(requireString(args.query, "query"), args.folder as string | undefined),
        );
      case "read_and_summarize_file":
        return JSON.stringify(
          await readAndSummarize(userId, requireString(args.file_path, "file_path")),
        );
      case "organize_downloads":
        return JSON.stringify(await organizeDownloads());
      case "list_recent_downloads":
        return JSON.stringify(await listRecentDownloads(safeInt(args.count, 10, 50)));
      case "get_weather":
        return JSON.stringify(await getWeather(requireString(args.location, "location")));
      case "get_news":
        return JSON.stringify(
          await getNews(args.topic as string | undefined, args.sources as string[] | undefined),
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
    const message = err instanceof Error ? err.message : "Unknown error";
    captureError(err, {
      tags: { area: "tool_executor", tool: functionName },
      extra: { userId, argKeys: Object.keys(args) },
    });
    return JSON.stringify({ error: message });
  }
}
