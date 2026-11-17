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

/**
 * How long a "no mailbox of this provider" answer is remembered. The lookup runs
 * before the rate limiter (a route-level hook), so without this any signed-in user
 * could query it without limit. Safe to remember: while the way out is the only
 * thing open to a user, /connect is closed to them, so they cannot become an owner
 * meanwhile, and opening a flag or a cohort is an environment change, a restart,
 * which empties this. An owner is never remembered: a disconnect takes effect at once.
 */
export const NOT_OWNER_TTL_MS = 60_000;
export const MAX_REMEMBERED_NON_OWNERS = 10_000;

/** `${provider}:${userId}` -> until when that user is known to own no mailbox of it. */
const notOwnerUntil = new Map<string, number>();

function rememberNotOwner(key: string, now: number): void {
  if (!notOwnerUntil.has(key)) {
    for (const oldest of notOwnerUntil.keys()) {
      if (notOwnerUntil.size < MAX_REMEMBERED_NON_OWNERS) break;
      notOwnerUntil.delete(oldest);
    }
  }
  notOwnerUntil.set(key, now + NOT_OWNER_TTL_MS);
}

/** Does this user have a mailbox of this provider? Scoped to their own rows. */
async function ownsMailboxOf(cfg: ImapProviderConfig, userId: string): Promise<boolean> {
  const key = `${cfg.provider}:${userId}`;
  const now = Date.now();
  const until = notOwnerUntil.get(key);
  if (until !== undefined && now < until) return false;
  const row = await prisma.linkedInboxAccount.findFirst({
    where: { userId, provider: cfg.provider },
    select: { id: true },
  });
  if (row !== null) return true;
  rememberNotOwner(key, now);
  return false;
}

/**
 * Requests ownerExitGate let in as an owner, with the user it checked: the cohort
 * check that follows trusts it instead of asking the database a second time.
 * Keyed weakly by the request, so an entry lives as long as its request.
 */
const ownerChecked = new WeakMap<FastifyRequest, string>();

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
    if (userId !== null && (await ownsMailboxOf(cfg, userId))) {
      ownerChecked.set(request, userId);
      return;
    }
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
    if (featureOpenTo(userId, flags) || ownerChecked.get(request) === userId) return;
    if (await ownsMailboxOf(cfg, userId)) return;
    return replyRouteNotFound(request, reply);
  };
}
