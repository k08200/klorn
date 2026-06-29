import type { FastifyReply, FastifyRequest } from "fastify";
import { PAYWALL_ENABLED } from "./config.js";
import { prisma } from "./db.js";
import { isEntitled } from "./stripe.js";

/**
 * Fastify preHandler that blocks non-entitled users from paid app features.
 *
 * Run it AFTER requireAuth (which sets request.userId). When the paywall is on,
 * a signed-in but non-entitled user (FREE / trial expired / never paid) is
 * refused with 403 — closing the gap where the only paywall enforcement was the
 * client screen, so a valid token could hit feature routes (send email, run the
 * agent, summarize) directly and bypass it.
 *
 * Pre-launch (PAYWALL_ENABLED unset) this is a zero-cost no-op: it returns
 * before any DB read, so nothing is gated and no extra query runs until launch
 * flips the flag. Entitlement granularity is binary today (all paid tiers share
 * one feature set), so isEntitled is the correct and sufficient gate; per-tool
 * planHasFeature checks remain in the agent loop for defense in depth.
 */
export async function requireEntitled(request: FastifyRequest, reply: FastifyReply) {
  if (!PAYWALL_ENABLED) return;

  const userId = (request as unknown as { userId?: string }).userId;
  if (!userId) {
    return reply.code(401).send({ error: "Authentication required" });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, role: true },
  });
  if (!isEntitled(user?.plan ?? "FREE", user?.role ?? undefined)) {
    return reply.code(403).send({
      error: "An active subscription is required to use this feature.",
      code: "ENTITLEMENT_REQUIRED",
    });
  }
}
