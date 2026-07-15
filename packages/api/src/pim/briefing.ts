/**
 * Daily Briefing - Klorn's autonomous planning feature
 *
 * Aggregates tasks, calendar events, and recent emails into a daily summary.
 * Can be triggered manually or via cron.
 */

import type { FastifyInstance } from "fastify";
import { AGENT_SYSTEM_PROMPT } from "../agent/prompt.js";
import { getUserId } from "../auth.js";
import { prisma } from "../db.js";
import { recordFeedback } from "../feedback.js";
import { listEmails } from "../gmail.js";
import { getUserLlmCredentials } from "../llm/llm-credentials.js";
import { createCompletion, MODEL } from "../llm/openai.js";
import { sendPushNotification } from "../notify/push.js";
import { localDayUtcRange, normalizeTimeZone } from "../time-zone.js";
import { stripUntrusted } from "../untrusted.js";
import { pushNotification } from "../websocket.js";
import { type BriefingSignals, buildBriefingSignals } from "./briefing-signals.js";
import { getBriefingStatus } from "./briefing-status.js";
import { listNotes } from "./notes.js";
import { listTasks } from "./tasks.js";

const BRIEFING_CALENDAR_WINDOW_DAYS = 14;
// The briefing is the founder's first read of the day. Five emails was too
// thin once real volume kicked in — anyone with 50+ emails overnight saw a
// brief that named nothing they actually got. Thirty is a reasonable upper
// bound: it stays well under the model's context budget while letting the
// LLM see most overnight signal.
const BRIEFING_EMAIL_WINDOW = 30;

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

/**
 * Read upcoming events from the local calendar table that the Calendar page
 * and the Status readiness check already consume. Previously the briefing
 * pulled events directly from the Google API, which surfaced auto-imported
 * birthdays and other side calendars that the Calendar page never showed —
 * so the briefing claimed eight birthday events while Calendar said "0
 * events in the next 14 days." Sharing the same source removes that lie.
 */
async function listLocalBriefingEvents(userId: string, now: Date): Promise<{ events: unknown[] }> {
  const windowEnd = new Date(now.getTime() + BRIEFING_CALENDAR_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.calendarEvent.findMany({
    where: { userId, startTime: { gte: now, lte: windowEnd } },
    orderBy: { startTime: "asc" },
    take: 20,
    select: {
      id: true,
      title: true,
      description: true,
      location: true,
      startTime: true,
      endTime: true,
    },
  });

  // Defense in depth: an older version of calendar sync wrote
  // <untrusted_content> wrappers into CalendarEvent.title / .description /
  // .location. Newer syncs write raw text, but stale prod rows still leak the
  // wrapper into the rule-based briefing — the user sees raw XML-looking tags
  // and the "shared terms" detector treats "untrusted", "content", "source"
  // as meaningful tokens. Strip on the read side so fallback briefings stay
  // clean even before a one-shot DB cleanup runs.
  //
  // Same row collapsed to a single signal: Google's birthday calendar emits
  // one event per upcoming birthday occurrence, all sharing the same title.
  // The fallback briefing previously listed each one as a separate deadline.
  // Dedup by (clean title, day) so a repeating event takes one line.
  const seenKeys = new Set<string>();
  const events: unknown[] = [];
  for (const row of rows) {
    const summary = stripUntrusted(row.title);
    const description = stripUntrusted(row.description);
    const location = stripUntrusted(row.location);
    const startIso = row.startTime.toISOString();
    const dedupKey = `${summary.trim().toLowerCase()}|${startIso.slice(0, 10)}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);
    events.push({
      id: row.id,
      summary,
      description,
      location,
      start: startIso,
      end: row.endTime.toISOString(),
    });
  }
  return { events };
}

/**
 * Bridge: listEmails pulls email metadata live from Gmail, so it carries no
 * firewall verdict. Join those emails back to the firewall's stored judgment
 * (EmailMessage.priority / needsReply, written by the 4-tier judge) by gmailId
 * so "what matters today" reflects what Klorn already decided about each email
 * rather than a re-derived keyword guess. Best-effort: any DB error degrades to
 * the unenriched emails so the briefing never blocks on the join.
 */
async function attachFirewallJudgment(
  userId: string,
  emailsValue: unknown,
): Promise<{ emails: unknown[] }> {
  const emails =
    emailsValue &&
    typeof emailsValue === "object" &&
    Array.isArray((emailsValue as { emails?: unknown }).emails)
      ? (emailsValue as { emails: unknown[] }).emails
      : [];
  const gmailIds = emails
    .map((e) => (e && typeof e === "object" ? (e as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === "string");
  if (gmailIds.length === 0) return { emails };

  try {
    const rows = await prisma.emailMessage.findMany({
      where: { userId, gmailId: { in: gmailIds } },
      select: { id: true, gmailId: true, priority: true, needsReply: true },
    });
    // Second hop: the 4-tier verdict (PUSH/QUEUE/SILENT/AUTO) lives on the
    // AttentionItem the firewall wrote for each email (sourceId = EmailMessage.id).
    const tierBySourceId = new Map<string, string | null>();
    if (rows.length > 0) {
      // No status filter: the tier is the firewall's classification of the
      // email itself, which stays valid regardless of whether the AttentionItem
      // was later resolved/snoozed — the briefing wants the verdict, not the
      // attention-lifecycle state.
      const attn = await prisma.attentionItem.findMany({
        where: { userId, source: "EMAIL", sourceId: { in: rows.map((r) => r.id) } },
        select: { sourceId: true, tier: true },
      });
      for (const a of attn) tierBySourceId.set(a.sourceId, a.tier);
    }
    const verdict = new Map(
      rows.map((r) => [
        r.gmailId,
        { priority: r.priority, needsReply: r.needsReply, tier: tierBySourceId.get(r.id) ?? null },
      ]),
    );
    return {
      emails: emails.map((e) => {
        const id = e && typeof e === "object" ? (e as { id?: unknown }).id : null;
        const v = typeof id === "string" ? verdict.get(id) : undefined;
        return v
          ? { ...(e as object), priority: v.priority, needsReply: v.needsReply, tier: v.tier }
          : e;
      }),
    };
  } catch (err) {
    // Never block the briefing on the join — log a signal (captureError is a
    // no-op without Sentry) and fall back to the unenriched emails.
    console.warn(
      `[BRIEFING] firewall-judgment join failed for ${userId} — using unenriched emails:`,
      err instanceof Error ? err.message : err,
    );
    return { emails };
  }
}

// Max open-PUSH items pulled in beyond the recent inbox window, so the briefing
// reminds without dumping a backlog.
const OPEN_PUSH_CAP = 5;

/**
 * Recency-cliff guard for the bridge. `listEmails` only returns the most recent
 * inbox window, so a still-open PUSH email older than that window never reaches
 * the briefing — it silently falls off "what matters today" the moment newer
 * mail arrives on top of it. Pull the firewall's OPEN, EMAIL-source, PUSH-tier
 * AttentionItems directly (highest priority first, capped), resolve them to email
 * shape via EmailMessage, and drop any already in the recent window. status=OPEN
 * means a resolved/dismissed/snoozed item is never resurfaced. Best-effort: any
 * DB error returns [] so the briefing never blocks on the guard.
 */
async function fetchOpenPushEmails(
  userId: string,
  excludeGmailIds: Set<string>,
): Promise<unknown[]> {
  try {
    const items = await prisma.attentionItem.findMany({
      where: { userId, source: "EMAIL", status: "OPEN", tier: "PUSH" },
      orderBy: [{ priority: "desc" }, { surfacedAt: "desc" }],
      take: OPEN_PUSH_CAP,
      select: { sourceId: true },
    });
    if (items.length === 0) return [];

    const rows = await prisma.emailMessage.findMany({
      where: { userId, id: { in: items.map((i) => i.sourceId) } },
      select: {
        gmailId: true,
        from: true,
        subject: true,
        snippet: true,
        priority: true,
        needsReply: true,
      },
    });
    return rows
      .filter((r) => !excludeGmailIds.has(r.gmailId))
      .map((r) => ({
        id: r.gmailId,
        from: r.from,
        subject: r.subject,
        snippet: r.snippet,
        priority: r.priority,
        needsReply: r.needsReply,
        tier: "PUSH",
      }));
  } catch (err) {
    console.warn(
      `[BRIEFING] open-PUSH fetch failed for ${userId} — skipping recency-cliff guard:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

async function gatherBriefingData(userId: string): Promise<BriefingData> {
  const now = new Date();
  const results = await Promise.allSettled([
    listTasks(userId),
    listLocalBriefingEvents(userId, now).catch(() => ({ events: [] })),
    listEmails(userId, BRIEFING_EMAIL_WINDOW).catch(() => ({ emails: [] })),
    listNotes(userId).catch(() => ({ notes: [] })),
  ]);

  const recent = await attachFirewallJudgment(
    userId,
    results[2].status === "fulfilled" ? results[2].value : { emails: [] },
  );
  const recentGmailIds = new Set(
    recent.emails
      .map((e) => (e && typeof e === "object" ? (e as { id?: unknown }).id : null))
      .filter((id): id is string => typeof id === "string"),
  );
  const openPush = await fetchOpenPushEmails(userId, recentGmailIds);

  const data = {
    tasks: results[0].status === "fulfilled" ? results[0].value : { tasks: [] },
    events: results[1].status === "fulfilled" ? results[1].value : { events: [] },
    emails: { emails: [...recent.emails, ...openPush] },
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

  // The brief is the user's first read of the day. Klorn's job is to surface
  // the clear signal worth acting on — not to summarize. This prompt asks the
  // model to name the single most important thing first, then connect risks,
  // then prune noise. Tone matches the product: calm, decisive, decision-first.
  const briefingPrompt = `Today is ${today}. Write the one-minute morning briefing the user reads before work starts.

## Klorn voice
Klorn is the clear signal worth acting on. You are not summarizing today; you are filtering it. Be the calm decision partner who already read the noise and tells the user only what matters now.

## Must do
1. **The signal**: Open with one sentence naming the single thing that shapes today. Not a generic greeting, not a status report — the decision-shaped headline.
2. **Cross-domain links**: Use crossLinks, deadlines, and urgentItems from "Server-detected signals" when connecting mail, calendar, tasks, or notes. Do not invent weak links.
3. **Top 3 actions**: Keep the topActions order from "Server-detected signals" as the default. Improve the wording, but do not reshuffle the priority unless the data clearly contradicts it.
4. **Approval-ready**: When an action is one the user could approve (reply, send, hold time), say so plainly so it lands in the decision queue with context.
5. **Open time**: If the calendar is light, suggest a useful focus block.
6. **Omit meta**: Do not say "I received data," "there are no events," or "good morning." The user only needs the decision.

## Output
- First line: the signal — one sentence naming what shapes today.
- **Top 3 Today** — numbered actions with one short reason each.
- **Connected items** — only if useful; explain how mail/tasks/calendar relate.
- **Everything else** — 2 or 3 short bullets for lower-priority context.
- English only.
- Calm, direct, decision-partner tone. Not a report.
- 120-220 words.

## Example
The Alpha Capital follow-up has to land before the 3 PM partner call — everything else bends around that.

**Top 3 Today**
1. Reply to Alpha Capital this morning — the follow-up ties directly to tomorrow's meeting and is approval-ready in the queue.
2. Read the Notion notes before the 3 PM Zoom — fifteen minutes now will make the call cleaner.
3. Block two hours for the deck — next week's partner meeting needs a tighter version.

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
  try {
    const response = await createCompletion(
      {
        model: MODEL,
        messages: [
          { role: "system", content: AGENT_SYSTEM_PROMPT },
          { role: "user", content: briefingPrompt },
        ],
      },
      { credentials, userId, priority: "background" },
    );

    const content = response.choices[0]?.message?.content?.trim();
    if (content) return content;
    console.warn(
      `[BRIEFING] LLM returned empty content for ${userId} — falling back to rule-based view`,
    );
    return buildSignalOnlyBriefing(data.signals);
  } catch (err) {
    // LLM provider exhausted, rate-limited, or otherwise unreachable.
    // Fall back to the deterministic signal summary so the user still
    // gets a useful briefing instead of an error or empty screen.
    // Log the reason — without it, "AI summary unavailable" is invisible
    // in prod and the user has no idea whether the issue is credentials,
    // the cost cap, or a transient provider outage.
    console.warn(
      `[BRIEFING] LLM call failed for ${userId} — falling back to rule-based view:`,
      err instanceof Error ? err.message : err,
    );
    return buildSignalOnlyBriefing(data.signals);
  }
}

/**
 * Render BriefingSignals (already rule-based — see briefing-signals.ts) as a
 * human-readable briefing without any LLM call. Used when every provider is
 * locked out so the briefing page never goes blank.
 */
export function buildSignalOnlyBriefing(signals: BriefingSignals): string {
  const lines: string[] = ["**Briefing (AI summary unavailable — rule-based view)**", ""];

  const topActions = signals.topActions.slice(0, 3);
  if (topActions.length > 0) {
    lines.push("**Top 3 Today**");
    topActions.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.action} — ${a.reason}`);
    });
    lines.push("");
  }

  if (signals.deadlines.length > 0) {
    lines.push("**Deadlines**");
    const seen = new Set<string>();
    let printed = 0;
    for (const d of signals.deadlines) {
      const key = `${d.source}:${d.title.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const due = d.dueText || d.dueAt || "soon";
      lines.push(`- ${d.title} (${due}) — ${d.reason}`);
      printed += 1;
      if (printed === 5) break;
    }
    lines.push("");
  }

  if (signals.urgentItems.length > 0) {
    lines.push("**Urgent**");
    const seen = new Set<string>();
    let printed = 0;
    for (const u of signals.urgentItems) {
      const key = `${u.source}:${u.title.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${u.title} — ${u.reason}`);
      printed += 1;
      if (printed === 5) break;
    }
    lines.push("");
  }

  if (signals.crossLinks.length > 0) {
    lines.push("**Connected items**");
    for (const link of signals.crossLinks.slice(0, 3)) {
      lines.push(`- ${link.reason}`);
    }
    lines.push("");
  }

  if (
    topActions.length === 0 &&
    signals.deadlines.length === 0 &&
    signals.urgentItems.length === 0
  ) {
    lines.push("Nothing urgent surfaced from today's data. Use the open block to plan ahead.");
  }

  return lines.join("\n").trim();
}

/**
 * Deliver today's briefing at most once per user per local day.
 *
 * The dedup is ATOMIC: a `(userId, dayKey)` unique on Note plus a
 * create-catch-P2002 recovery closes the check-then-create (TOCTOU) race. Four
 * callers can fire concurrently — the scheduler, the agent tool-executor, cron,
 * and post-login auth — but only the create winner generates + pushes; every
 * other caller reuses the winner's note and gets `notification: null` (no push).
 */
export async function createDailyBriefingDelivery(userId: string): Promise<{
  briefing: string;
  note: { id: string; createdAt: Date };
  notification: { id: string; createdAt: Date } | null;
  reused: boolean;
}> {
  const dayKey = await briefingDayKeyForUser(userId);

  const existing = await prisma.note.findUnique({
    where: { userId_dayKey: { userId, dayKey } },
    select: { id: true, content: true, createdAt: true },
  });
  if (existing) {
    const notification = await ensureDailyBriefingNotification(userId, existing.content, dayKey);
    return {
      briefing: existing.content,
      note: { id: existing.id, createdAt: existing.createdAt },
      notification,
      reused: true,
    };
  }

  const briefing = await generateBriefing(userId);

  let note: { id: string; createdAt: Date };
  try {
    note = await prisma.note.create({
      data: {
        userId,
        dayKey,
        title: `Daily Briefing — ${new Date().toLocaleDateString("en-US")}`,
        content: briefing,
      },
      select: { id: true, createdAt: true },
    });
  } catch (err) {
    // A concurrent caller won the (userId, dayKey) race between our findUnique
    // miss and this create. Recover by reading the winner's note and reusing it
    // — matches the WebhookEvent P2002-dedup idiom (routes/webhook.ts).
    if ((err as { code?: string })?.code !== "P2002") throw err;
    const winner = await prisma.note.findUnique({
      where: { userId_dayKey: { userId, dayKey } },
      select: { id: true, content: true, createdAt: true },
    });
    if (!winner) throw err; // P2002 but no row — genuinely unexpected, surface it
    const notification = await ensureDailyBriefingNotification(userId, winner.content, dayKey);
    return {
      briefing: winner.content,
      note: { id: winner.id, createdAt: winner.createdAt },
      notification,
      reused: true,
    };
  }

  const notification = await ensureDailyBriefingNotification(userId, briefing, dayKey);

  return { briefing, note, notification, reused: false };
}

/**
 * Create the briefing notification and push it — WINNER-ONLY and atomic.
 *
 * A `(userId, dedupeKey)` unique on Notification (dedupeKey = "briefing:<dayKey>")
 * means exactly one caller's create succeeds. The winner does both pushes and
 * returns the notification; a concurrent loser gets P2002 → returns null WITHOUT
 * pushing, so the user can never receive a duplicate briefing web-push. Matches
 * the WebhookEvent P2002-dedup idiom (routes/webhook.ts).
 */
export async function ensureDailyBriefingNotification(
  userId: string,
  briefing: string,
  dayKey: string,
): Promise<{ id: string; createdAt: Date } | null> {
  const briefingMsg = briefing.slice(0, 200) + (briefing.length > 200 ? "..." : "");
  const dedupeKey = `briefing:${dayKey}`;

  let notification: { id: string; createdAt: Date };
  try {
    notification = await prisma.notification.create({
      data: {
        userId,
        type: "briefing",
        dedupeKey,
        title: "Daily Briefing Ready",
        message: briefingMsg,
        link: "/briefing",
      },
      select: { id: true, createdAt: true },
    });
  } catch (err) {
    // Someone already created + pushed this briefing for the day. Do NOT push
    // again — this is exactly the duplicate-push hole being closed.
    if ((err as { code?: string })?.code === "P2002") return null;
    throw err;
  }

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

/**
 * The user's LOCAL calendar day as YYYY-MM-DD, using the SAME timezone
 * resolution as todayRangeForUser (localDayUtcRange returns this exact key as
 * `dateKey`). Sharing the resolution keeps dayKey aligned with the "today"
 * window and stable across a local day — the dedup key for the daily briefing.
 */
async function briefingDayKeyForUser(userId: string): Promise<string> {
  const config = await prisma.automationConfig.findUnique({
    where: { userId },
    select: { timezone: true },
  });
  return localDayUtcRange(new Date(), normalizeTimeZone(config?.timezone)).dateKey;
}

// Tool for Klorn to generate briefing on demand
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
