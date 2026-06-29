/**
 * Inbox Command Center API.
 *
 * GET /api/inbox/summary collapses the four signal sources (pending actions,
 * tasks, today's events, agent_proposal notifications) into a single response
 * with a deterministic Top 3 + a today section. The frontend renders it
 * directly — no client-side ranking.
 *
 * GET /api/inbox/reply-needed returns emails where needsReply=true, ordered
 * by confidence desc then receivedAt desc — used by the Command Center sidebar.
 */
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import { requireEntitled } from "../entitlement-guard.js";
import { buildInboxSummary } from "../inbox-summary.js";
import { buildOperatingPlan } from "../operating-plan.js";

const REPLY_NEEDED_LIMIT = 8;

export function inboxRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  // Paywall: refuse non-entitled users at the paid surface (no-op pre-launch).
  app.addHook("preHandler", requireEntitled);

  app.get("/summary", (request) => {
    const userId = getUserId(request);
    return buildInboxSummary(userId);
  });

  app.get("/operating-plan", (request) => {
    const userId = getUserId(request);
    return buildOperatingPlan(userId);
  });

  app.get("/reply-needed", async (request) => {
    const userId = getUserId(request);
    const rows = await prisma.emailMessage.findMany({
      where: { userId, needsReply: true },
      orderBy: [{ needsReplyConfidence: "desc" }, { receivedAt: "desc" }],
      take: REPLY_NEEDED_LIMIT,
      select: {
        id: true,
        subject: true,
        from: true,
        snippet: true,
        needsReplyReason: true,
        needsReplyConfidence: true,
        receivedAt: true,
      },
    });
    return {
      emails: rows.map((r) => ({
        ...r,
        receivedAt: r.receivedAt.toISOString(),
      })),
    };
  });
}
