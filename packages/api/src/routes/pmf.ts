/**
 * PMF probe routes.
 *
 * Gated by `PMF_PROBE_ENABLED`. With the flag off `/eligible` simply answers
 * `false` rather than 404: the client asks this on load, and an error would put
 * a broken-request line in the console of every session for a feature that is
 * merely switched off.
 *
 * The write is a different matter and does 404 when the flag is off — nothing
 * should be able to seed the measurement while the probe is not running.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import type { PmfAnswer } from "../product/cohort.js";
import {
  isPmfEligible,
  isPmfProbeEnabled,
  PMF_ANSWERS,
  recordPmfResponse,
} from "../product/cohort.js";
import { captureError } from "../sentry.js";

const responseBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: {
    answer: { type: "string", enum: [...PMF_ANSWERS] },
  },
} as const;

export async function pmfRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  /** Should this session show the probe? */
  app.get("/eligible", async (req, reply) => {
    const userId = getUserId(req);
    return reply.send({ eligible: await isPmfEligible(userId) });
  });

  /**
   * Record the answer.
   *
   * Deliberately not fail-open: a user who answers and is told nothing went
   * wrong will not answer again, and the number this produces is the one the
   * pricing decision rests on.
   */
  app.post<{ Body: { answer: PmfAnswer } }>(
    "/response",
    { schema: { body: responseBodySchema } },
    async (req, reply) => {
      if (!isPmfProbeEnabled()) return reply.code(404).send({ error: "Not found" });
      const userId = getUserId(req);
      try {
        await recordPmfResponse(userId, req.body.answer);
        return reply.send({ ok: true });
      } catch (err) {
        captureError(err, { tags: { scope: "pmf-response" }, extra: { userId } });
        return reply.code(500).send({ error: "Could not record the answer" });
      }
    },
  );
}
