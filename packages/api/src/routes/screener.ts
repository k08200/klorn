/**
 * Screener routes — the first-contact gate's read and decide surface.
 *
 * Gated by `SCREENER_ENABLED`. With the flag off every route answers 404, not
 * 403: an unshipped feature should be indistinguishable from one that does not
 * exist, so nothing here becomes a probe for what we are building.
 *
 * See `judge/screener.ts` for why a BLOCK writes into the existing pin ladder
 * rather than introducing a lane.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import {
  isScreenerEnabled,
  listPendingScreener,
  recordScreenerDecision,
  type ScreenerVerdict,
} from "../judge/screener.js";
import { captureError } from "../sentry.js";

const decisionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["sender", "verdict"],
  properties: {
    // 320 is the RFC-bounded maximum for an address; AJV rejects longer before
    // it reaches normalisation or the database.
    sender: { type: "string", minLength: 3, maxLength: 320 },
    verdict: { type: "string", enum: ["ALLOW", "BLOCK"] },
  },
} as const;

export async function screenerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  /** Senders waiting on a first-contact decision, newest first. */
  app.get("/pending", async (req, reply) => {
    if (!isScreenerEnabled()) return reply.code(404).send({ error: "Not found" });
    const userId = getUserId(req);
    const pending = await listPendingScreener(userId);
    return reply.send({
      pending: pending.map((p) => ({
        sender: p.sender,
        messageCount: p.messageCount,
        lastReceivedAt: p.lastReceivedAt?.toISOString() ?? null,
      })),
    });
  });

  /**
   * Record a permanent decision.
   *
   * Deliberately not fail-open: if the write throws, say so. A user who clicks
   * "block" and is told nothing went wrong will assume the sender is handled.
   */
  app.post<{ Body: { sender: string; verdict: ScreenerVerdict } }>(
    "/decision",
    { schema: { body: decisionBodySchema } },
    async (req, reply) => {
      if (!isScreenerEnabled()) return reply.code(404).send({ error: "Not found" });
      const userId = getUserId(req);
      const { sender, verdict } = req.body;
      try {
        await recordScreenerDecision(userId, sender, verdict);
        return reply.send({ ok: true, sender: sender.trim().toLowerCase(), verdict });
      } catch (err) {
        captureError(err, { tags: { scope: "screener-decision" }, extra: { userId } });
        return reply.code(500).send({ error: "Could not record the decision" });
      }
    },
  );
}
