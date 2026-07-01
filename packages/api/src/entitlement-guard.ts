import type { FastifyReply, FastifyRequest } from "fastify";
import { PAYWALL_ENABLED } from "./config.js";
import { prisma } from "./db.js";
import { captureError } from "./sentry.js";
import { isEntitled, isHardPaywalled } from "./stripe.js";

async function loadPlanRole(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ plan: string; role?: string } | null> {
  const userId = (request as unknown as { userId?: string }).userId;
  if (!userId) {
    reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true, role: true },
    });
    return { plan: user?.plan ?? "FREE", role: user?.role ?? undefined };
  } catch (err) {
    // Fail CLOSED (re-throw → Fastify 500): an access guard must not admit a
    // request when it can't determine entitlement. Surface it so a DB fault on
    // the guard path isn't invisible. captureError no-ops when Sentry is off.
    captureError(err, { tags: { scope: "entitlement-guard.load-plan" }, extra: { userId } });
    throw err;
  }
}

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

  const who = await loadPlanRole(request, reply);
  if (!who) return;
  if (!isEntitled(who.plan, who.role)) {
    return reply.code(403).send({
      error: "An active subscription is required to use this feature.",
      code: "ENTITLEMENT_REQUIRED",
    });
  }
}

/**
 * Fastify preHandler that admits anyone who can use the app at all — everyone
 * except a hard-walled user in pure subscriber-only mode. With the usable free
 * tier this lets FREE users reach the core read/classify surfaces (inbox,
 * firewall, mail + calendar reads, briefing). Paid mutations inside those
 * routes stay gated by a per-route requireEntitled or per-tool planHasFeature,
 * and free volume is bounded by the free daily cost cap. Mirrors the client's
 * `paywalled` gate so server and app agree on who gets in.
 *
 * Zero-cost no-op pre-launch (PAYWALL_ENABLED off): returns before any DB read.
 */
export async function requireAppAccess(request: FastifyRequest, reply: FastifyReply) {
  if (!PAYWALL_ENABLED) return;

  const who = await loadPlanRole(request, reply);
  if (!who) return;
  if (isHardPaywalled(who.plan, who.role)) {
    return reply.code(403).send({
      error: "An active subscription is required.",
      code: "ENTITLEMENT_REQUIRED",
    });
  }
}
