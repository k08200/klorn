/**
 * The briefing's HTTP routes: generate, today's card, raw data, status, pick
 * opens and the Top 3 feedback. Split from briefing.ts, which re-exports
 * briefingRoutes.
 */

import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { meetingPrepRoutes } from "../context/meeting-prep-routes.js";
import { meetingPrepForUser } from "../context/meeting-prep-surface.js";
import { prisma } from "../db.js";
import { recordFeedback } from "../learning/feedback.js";
import { logDbFailure } from "../report-db-failure.js";
import { localDayUtcRange, normalizeTimeZone } from "../time-zone.js";
import {
  briefingDayKeyForUser,
  createDailyBriefingDelivery,
  picksColumn,
} from "./briefing-delivery.js";
import { gatherBriefingData } from "./briefing-gather.js";
import { readStoredPicks } from "./briefing-picks.js";
import { getBriefingStatus } from "./briefing-status.js";

/** Read-compare-write rounds for a pick open before giving up on contention. */
const PICK_OPEN_ATTEMPTS = 3;

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

const briefingFeedbackSummaryQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    days: { type: "string", maxLength: 500 },
  },
} as const;

export function briefingRoutes(app: FastifyInstance) {
  // GET /api/briefing/feedback/summary — dogfood trust metric for Top 3 quality
  app.get(
    "/feedback/summary",
    { schema: { querystring: briefingFeedbackSummaryQuerySchema } },
    async (request) => {
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
    },
  );

  // POST /api/briefing/generate — Generate daily briefing
  app.post(
    "/generate",
    {
      schema: {
        body: {
          type: ["object", "null"],
          properties: { force: { type: "boolean" } },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const userId = getUserId(request);
      // `force` regenerates from scratch: today's briefing is deduped to one
      // note per local day, so without this a user who wants a fresh briefing
      // (after new mail, or when the first run fell back) always gets the
      // cached one. Deleting the day's note lets createDailyBriefingDelivery
      // re-run. Deliberately does NOT reset the day's Notification dedupe: the
      // caller is interacting live and receives the fresh content in this
      // response — a second OS push for the same day would double-notify.
      const { force } = (request.body as { force?: boolean } | null) ?? {};
      if (force) {
        const dayKey = await briefingDayKeyForUser(userId);
        await prisma.note.deleteMany({ where: { userId, dayKey } });
      }
      const { briefing, note, notification, reused, llm } =
        await createDailyBriefingDelivery(userId);
      // llm is THIS request's outcome (request-scoped, threaded through return
      // values) so a rule-based fallback is diagnosable in prod. On a reuse
      // race after force-delete it reads "cache" — honest about what happened.
      return { briefing, note, notification, reused, llm };
    },
  );

  // GET /api/briefing/data — Get raw briefing data
  app.get("/data", async (request) => {
    const userId = getUserId(request);
    const dayKey = await briefingDayKeyForUser(userId);
    const { windowMail, openPush, ...data } = await gatherBriefingData(userId, dayKey);
    return { ...data, windowMailCount: windowMail.length, openPushCount: openPush.length };
  });

  // GET /api/briefing/today — Latest briefing stored today (or null)
  // requireAuth (session revocation, idle timeout): the payload carries mail
  // subjects and, with meeting prep, meeting titles and commitments.
  app.get("/today", { preHandler: requireAuth }, async (request) => {
    const userId = getUserId(request);
    // Meeting prep for the next 24 hours (CONTEXT_MEETING_PREP_ENABLED), built
    // at read time alongside the rest; fail-open, and absent when off.
    const prepWork = meetingPrepForUser(userId, new Date());
    const today = await todayRangeForUser(userId);

    const row = await prisma.note.findFirst({
      where: {
        userId,
        title: { startsWith: "Daily Briefing" },
        createdAt: today,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, content: true, createdAt: true, picks: true },
    });
    const note = row && { ...row, picks: readStoredPicks(row.picks) };

    // The glanceable v2 layer (verdict + segments + curve + attention).
    // Deterministic at read time; fail-open null keeps old clients working.
    let structured = null;
    try {
      const { buildBriefingStructure } = await import("./briefing-structure.js");
      structured = await buildBriefingStructure(userId);
    } catch (err) {
      logDbFailure("[BRIEFING] structure build failed", err, { ids: { userId } });
    }

    const meetingPrep = await prepWork;
    return { briefing: note, structured, ...(meetingPrep ? { meetingPrep } : {}) };
  });

  meetingPrepRoutes(app);

  // POST /api/briefing/:id/picks/:rank/open — the user opened a pick's mail
  // from the briefing. Stamps the pick's openedAt once (first open wins), so
  // "picks shown" vs "picks opened" is countable per briefing. The client
  // navigates to the mail itself; this only records the open. The write is
  // conditional on the picks it read, so two opens at once cannot drop a stamp.
  app.post("/:id/picks/:rank/open", async (request, reply) => {
    const userId = getUserId(request);
    const { id, rank: rawRank } = request.params as { id: string; rank: string };
    const rank = parseRank(rawRank);
    if (!rank) return reply.code(400).send({ error: "rank must be 1, 2, or 3" });

    for (let attempt = 0; attempt < PICK_OPEN_ATTEMPTS; attempt++) {
      const note = await prisma.note.findFirst({
        where: { id, userId, title: { startsWith: "Daily Briefing" } },
        select: { id: true, picks: true },
      });
      const picks = readStoredPicks(note?.picks);
      const pick = picks.find((p) => p.rank === rank);
      if (!note || !pick) return reply.code(404).send({ error: "Pick not found" });
      if (pick.openedAt) return { emailId: pick.emailId, openedAt: pick.openedAt, first: false };

      const openedAt = new Date().toISOString();
      const next = picks.map((p) => (p.rank === rank ? { ...p, openedAt } : p));
      const { count } = await prisma.note.updateMany({
        where: { id: note.id, userId, picks: { equals: note.picks as Prisma.InputJsonValue } },
        data: { picks: picksColumn(next) },
      });
      if (count === 1) return { emailId: pick.emailId, openedAt, first: true };
    }
    return reply.code(409).send({ error: "Briefing changed; try again" });
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
