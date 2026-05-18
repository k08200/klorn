/**
 * Daily Briefing - Jigeum's autonomous planning feature
 *
 * Aggregates tasks, calendar events, and recent emails into a daily summary.
 * Can be triggered manually or via cron.
 */

import type { FastifyInstance } from "fastify";
import { AGENT_SYSTEM_PROMPT } from "./agent/prompt.js";
import { getUserId } from "./auth.js";
import { type BriefingSignals, buildBriefingSignals } from "./briefing-signals.js";
import { getBriefingStatus } from "./briefing-status.js";
import { listEvents } from "./calendar.js";
import { prisma } from "./db.js";
import { recordFeedback } from "./feedback.js";
import { listEmails } from "./gmail.js";
import { getUserLlmCredentials } from "./llm-credentials.js";
import { listNotes } from "./notes.js";
import { createCompletion, MODEL } from "./openai.js";
import { sendPushNotification } from "./push.js";
import { listTasks } from "./tasks.js";
import { localDayUtcRange, normalizeTimeZone } from "./time-zone.js";
import { pushNotification } from "./websocket.js";

interface BriefingData {
  tasks: unknown;
  events: unknown;
  emails: unknown;
  notes: unknown;
  signals: BriefingSignals;
}

type BriefingFeedbackChoice = "useful" | "wrong" | "later" | "done";

const BRIEFING_TOP_ACTION_TOOL = "briefing_top_action";
const BRIEFING_FEEDBACK_CHOICES = new Set<BriefingFeedbackChoice>([
  "useful",
  "wrong",
  "later",
  "done",
]);
const BRIEFING_SIGNAL_BY_CHOICE = {
  useful: "APPROVED",
  wrong: "REJECTED",
  later: "SNOOZED",
  done: "DISMISSED",
} as const;
const BRIEFING_CHOICE_BY_SIGNAL = {
  APPROVED: "useful",
  REJECTED: "wrong",
  SNOOZED: "later",
  DISMISSED: "done",
} as const;

async function gatherBriefingData(userId: string): Promise<BriefingData> {
  const results = await Promise.allSettled([
    listTasks(userId),
    listEvents(userId, 10).catch(() => ({ events: [] })),
    listEmails(userId, 5).catch(() => ({ emails: [] })),
    listNotes(userId).catch(() => ({ notes: [] })),
  ]);

  const data = {
    tasks: results[0].status === "fulfilled" ? results[0].value : { tasks: [] },
    events: results[1].status === "fulfilled" ? results[1].value : { events: [] },
    emails: results[2].status === "fulfilled" ? results[2].value : { emails: [] },
    notes: results[3].status === "fulfilled" ? results[3].value : { notes: [] },
  };

  return {
    ...data,
    signals: buildBriefingSignals(data),
  };
}

function briefingTopActionSourceId(noteId: string, rank: number): string {
  return `briefing:${noteId}:top:${rank}`;
}

function parseRank(value: string | undefined): number | null {
  if (!value) return null;
  const rank = Number.parseInt(value, 10);
  return Number.isInteger(rank) && rank >= 1 && rank <= 3 ? rank : null;
}

function findUserBriefingNote(userId: string, noteId: string) {
  return prisma.note.findFirst({
    where: {
      id: noteId,
      userId,
      title: { startsWith: "Daily Briefing" },
    },
    select: { id: true, createdAt: true },
  });
}

export default async function generateBriefing(userId: string): Promise<string> {
  const data = await gatherBriefingData(userId);

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // The brief is the user's first read of the day — it has to make them feel
  // "someone thought about my day." Data dumps fail that bar. This prompt asks
  // the model to *decide* what matters and surface connections across domains.
  const briefingPrompt = `Today is ${today}. Write the one-minute morning briefing the user reads before work starts.

## Role
Do not merely summarize data. Decide what matters first. Sound like a calm decision partner who connects context, risk, and the next move.

## Must do
1. **Cross-domain links**: Use crossLinks, deadlines, and urgentItems from "Server-detected signals" when connecting mail, calendar, tasks, or notes. Do not invent weak links.
2. **Top 3 actions**: Keep the topActions order from "Server-detected signals" as the default. Improve the wording, but do not reshuffle the priority unless the data clearly contradicts it.
3. **Open time**: If the calendar is light, suggest a useful focus block.
4. **Omit meta comments**: Do not say "I received data" or "there are no events." The user only needs the decision.

## Output
- First line: a one-sentence summary of the day.
- **Top 3 Today** - numbered actions with one short reason each.
- **Connected items** - only if useful; explain how mail/tasks/calendar relate.
- **Everything else** - 2 or 3 short bullets for lower-priority context.
- English only.
- Calm, direct, decision-partner tone. Not a report.
- 120-220 words.

## Example
One investor reply and a 3 PM meeting shape the day.

**Top 3 Today**
1. Reply to Alpha Capital this morning - the follow-up is already tied to tomorrow's meeting.
2. Read the Notion notes before the 3 PM Zoom - fifteen minutes now will make the call cleaner.
3. Block two hours for the deck - next week's partner meeting needs a tighter version.

**Connected items**
- The Vercel security email and the open deployment task are the same risk. Handle them before the investor reply expands.

**Everything else**
- No other meeting needs prep.
- The remaining mail can wait until the afternoon.

---

## Server-detected signals
This section is rule-based evidence. Use crossLinks, deadlines, and urgentItems here when naming connected work.
Use topActions as the primary Top 3 source. The model's job is to make the wording useful, not to invent a new priority list.
Signals: ${JSON.stringify(data.signals)}

## Today's data
Tasks: ${JSON.stringify(data.tasks)}
Calendar: ${JSON.stringify(data.events)}
Emails: ${JSON.stringify(data.emails)}
Recent Notes: ${JSON.stringify(data.notes)}`;

  const credentials = await getUserLlmCredentials(userId);
  const response = await createCompletion(
    {
      model: MODEL,
      messages: [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        { role: "user", content: briefingPrompt },
      ],
    },
    { credentials, userId },
  );

  return response.choices[0]?.message?.content || "No briefing generated.";
}

export async function createDailyBriefingDelivery(userId: string): Promise<{
  briefing: string;
  note: { id: string; createdAt: Date };
  notification: { id: string; createdAt: Date } | null;
  reused: boolean;
}> {
  const today = await todayRangeForUser(userId);
  const existing = await prisma.note.findFirst({
    where: {
      userId,
      title: { startsWith: "Daily Briefing" },
      createdAt: today,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, content: true, createdAt: true },
  });
  if (existing) {
    const notification = await ensureDailyBriefingNotification(userId, existing.content);
    return {
      briefing: existing.content,
      note: { id: existing.id, createdAt: existing.createdAt },
      notification,
      reused: true,
    };
  }

  const briefing = await generateBriefing(userId);

  const note = await prisma.note.create({
    data: {
      userId,
      title: `Daily Briefing — ${new Date().toLocaleDateString("en-US")}`,
      content: briefing,
    },
    select: { id: true, createdAt: true },
  });

  const notification = await ensureDailyBriefingNotification(userId, briefing);

  return { briefing, note, notification, reused: false };
}

async function ensureDailyBriefingNotification(
  userId: string,
  briefing: string,
): Promise<{ id: string; createdAt: Date } | null> {
  const today = await todayRangeForUser(userId);
  const existing = await prisma.notification.findFirst({
    where: {
      userId,
      type: "briefing",
      createdAt: today,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true },
  });
  if (existing) return null;

  const briefingMsg = briefing.slice(0, 200) + (briefing.length > 200 ? "..." : "");
  const notification = await prisma.notification.create({
    data: {
      userId,
      type: "briefing",
      title: "Daily Briefing Ready",
      message: briefingMsg,
      link: "/briefing",
    },
    select: { id: true, createdAt: true },
  });

  pushNotification(userId, {
    id: notification.id,
    type: "briefing",
    title: "Daily Briefing Ready",
    message: briefingMsg,
    createdAt: notification.createdAt.toISOString(),
  });

  await sendPushNotification(
    userId,
    {
      title: "Daily Briefing Ready",
      body: briefingMsg,
      url: "/briefing",
      notificationId: notification.id,
    },
    "daily_briefing",
  );

  return notification;
}

export function briefingRoutes(app: FastifyInstance) {
  // GET /api/briefing/feedback/summary — dogfood trust metric for Top 3 quality
  app.get("/feedback/summary", async (request) => {
    const userId = getUserId(request);
    const { days } = request.query as { days?: string };
    const parsedDays = days ? Number.parseInt(days, 10) : 7;
    const windowDays = Number.isFinite(parsedDays) ? Math.min(Math.max(parsedDays, 1), 90) : 7;
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const rows = await prisma.feedbackEvent.groupBy({
      by: ["signal"],
      where: {
        userId,
        source: "ATTENTION_ITEM",
        toolName: BRIEFING_TOP_ACTION_TOOL,
        createdAt: { gte: since },
      },
      _count: { signal: true },
    });

    const counts = { useful: 0, wrong: 0, later: 0, done: 0 };
    for (const row of rows) {
      const choice =
        BRIEFING_CHOICE_BY_SIGNAL[row.signal as keyof typeof BRIEFING_CHOICE_BY_SIGNAL];
      if (choice) counts[choice] = row._count.signal;
    }
    const total = counts.useful + counts.wrong + counts.later + counts.done;

    return {
      since: since.toISOString(),
      days: windowDays,
      total,
      counts,
      usefulRate: total > 0 ? counts.useful / total : null,
    };
  });

  // POST /api/briefing/generate — Generate daily briefing
  app.post("/generate", async (request) => {
    const userId = getUserId(request);
    const { briefing, note, notification, reused } = await createDailyBriefingDelivery(userId);
    return { briefing, note, notification, reused };
  });

  // GET /api/briefing/data — Get raw briefing data
  app.get("/data", async (request) => {
    const userId = getUserId(request);
    const data = await gatherBriefingData(userId);
    return data;
  });

  // GET /api/briefing/today — Latest briefing stored today (or null)
  app.get("/today", async (request) => {
    const userId = getUserId(request);
    const today = await todayRangeForUser(userId);

    const note = await prisma.note.findFirst({
      where: {
        userId,
        title: { startsWith: "Daily Briefing" },
        createdAt: today,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, content: true, createdAt: true },
    });

    return { briefing: note };
  });

  // GET /api/briefing/:id/top-actions/feedback — latest feedback per Top 3 rank
  app.get("/:id/top-actions/feedback", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const note = await findUserBriefingNote(userId, id);
    if (!note) return reply.code(404).send({ error: "Briefing not found" });

    const sourceIds = [1, 2, 3].map((rank) => briefingTopActionSourceId(id, rank));
    const rows = await prisma.feedbackEvent.findMany({
      where: {
        userId,
        source: "ATTENTION_ITEM",
        toolName: BRIEFING_TOP_ACTION_TOOL,
        sourceId: { in: sourceIds },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        sourceId: true,
        signal: true,
        evidence: true,
        createdAt: true,
      },
    });

    const feedback: Record<number, unknown> = {};
    for (const row of rows) {
      const rank = parseRank(row.sourceId.split(":").at(-1));
      if (!rank || feedback[rank]) continue;
      const choice =
        BRIEFING_CHOICE_BY_SIGNAL[row.signal as keyof typeof BRIEFING_CHOICE_BY_SIGNAL];
      if (!choice) continue;
      feedback[rank] = {
        id: row.id,
        rank,
        choice,
        signal: row.signal,
        evidence: row.evidence,
        createdAt: row.createdAt.toISOString(),
      };
    }

    return { feedback };
  });

  // POST /api/briefing/:id/top-actions/:rank/feedback — capture Top 3 quality
  app.post("/:id/top-actions/:rank/feedback", async (request, reply) => {
    const userId = getUserId(request);
    const { id, rank: rawRank } = request.params as { id: string; rank: string };
    const rank = parseRank(rawRank);
    if (!rank) return reply.code(400).send({ error: "rank must be 1, 2, or 3" });

    const body = (request.body ?? {}) as {
      choice?: string;
      label?: string;
      evidence?: string;
    };
    const choice = body.choice as BriefingFeedbackChoice | undefined;
    if (!choice || !BRIEFING_FEEDBACK_CHOICES.has(choice)) {
      return reply.code(400).send({ error: "choice must be one of useful, wrong, later, done" });
    }

    const note = await findUserBriefingNote(userId, id);
    if (!note) return reply.code(404).send({ error: "Briefing not found" });

    const signal = BRIEFING_SIGNAL_BY_CHOICE[choice];
    const evidence = JSON.stringify({
      choice,
      noteId: id,
      rank,
      label: typeof body.label === "string" ? body.label.slice(0, 500) : null,
      evidence: typeof body.evidence === "string" ? body.evidence.slice(0, 500) : null,
    });

    await recordFeedback({
      userId,
      source: "ATTENTION_ITEM",
      sourceId: briefingTopActionSourceId(id, rank),
      signal,
      toolName: BRIEFING_TOP_ACTION_TOOL,
      evidence,
    });

    return {
      feedback: {
        noteId: id,
        rank,
        choice,
        signal,
      },
    };
  });

  // GET /api/briefing/status — Today's briefing, notification, and push state
  app.get("/status", (request) => {
    const userId = getUserId(request);
    return getBriefingStatus(userId);
  });
}

async function todayRangeForUser(userId: string): Promise<{ gte: Date; lt: Date }> {
  const config = await prisma.automationConfig.findUnique({
    where: { userId },
    select: { timezone: true },
  });
  const { gte, lt } = localDayUtcRange(new Date(), normalizeTimeZone(config?.timezone));
  return { gte, lt };
}

// Tool for Jigeum to generate briefing on demand
export const BRIEFING_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "generate_briefing",
      description:
        "Generate a daily briefing summarizing today's tasks, calendar events, emails, and notes. Use this when the user asks for a daily summary or morning briefing.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];
