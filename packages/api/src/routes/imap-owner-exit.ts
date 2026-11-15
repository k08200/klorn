/**
 * The way out of an IMAP provider whose flag closed after users connected it
 * (follow-up to #1756). IMAP_PRESETS_ENABLED (or ICLOUD_INBOX_ENABLED,
 * GENERIC_IMAP_ENABLED) turned off, or a cohort narrowed, used to make every
 * route of the provider answer 404, /disconnect included: a user who had
 * connected a mailbox could no longer remove it, nor the app password Klorn
 * stores for it.
 *
 * /status and /disconnect now stay open to a user who owns at least one mailbox
 * of that provider, whatever the flag. Everyone else gets exactly what they got
 * before: the cloaked 404 of darkRouteGate while the flag is off, without a
 * session too, and cohortGate's 404 outside the cohort. /connect stays dark (it
 * keeps darkRouteGate and cohortGate in routes/imap-connect.ts), and the
 * scheduler polls no row of a provider whose flag is off (imap-scheduler.ts).
 */

import type {
  FastifyRequest,
  onRequestAsyncHookHandler,
  preHandlerAsyncHookHandler,
} from "fastify";
import { getUserId, verifiedPayload } from "../auth.js";
import { featureOpenTo } from "../config.js";
import { prisma } from "../db.js";
import type { ImapProviderConfig } from "../mail/imap-providers.js";
import { replyRouteNotFound } from "./dark-route-gate.js";

/** Does this user have a mailbox of this provider? Scoped to their own rows. */
async function ownsMailboxOf(cfg: ImapProviderConfig, userId: string): Promise<boolean> {
  const row = await prisma.linkedInboxAccount.findFirst({
    where: { userId, provider: cfg.provider },
    select: { id: true },
  });
  return row !== null;
}

/**
 * The user a bearer token names, when its signature and expiry verify; null
 * otherwise. Only decides 404 or not: requireAuth still checks the session.
 */
function bearerUserId(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return verifiedPayload(auth.slice(7))?.userId ?? null;
}

/**
 * onRequest, in place of darkRouteGate on the way-out routes: while the gate is
 * closed they answer the same 404, before authentication, unless the bearer
 * owns a mailbox of this provider. A request without a valid token is answered
 * without a database lookup.
 */
export function ownerExitGate(
  cfg: ImapProviderConfig,
  gate: () => boolean,
): onRequestAsyncHookHandler {
  return async (request, reply) => {
    if (gate()) return;
    const userId = bearerUserId(request);
    if (userId !== null && (await ownsMailboxOf(cfg, userId))) return;
    return replyRouteNotFound(request, reply);
  };
}

/** preHandler, in place of cohortGate on the way-out routes: the cohort, and owners. */
export function ownerExitCohortGate(
  cfg: ImapProviderConfig,
  flags: readonly string[],
): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const userId = getUserId(request);
    if (featureOpenTo(userId, flags) || (await ownsMailboxOf(cfg, userId))) return;
    return replyRouteNotFound(request, reply);
  };
}
