/**
 * The way out of a surface whose flag closed after users stored data with it
 * (#1785 for IMAP providers, then the KakaoTalk import). A flag turned off, or
 * a cohort narrowed, used to make every route of the surface answer 404, the
 * way out included: a user could no longer remove what they had connected or
 * imported.
 *
 * The way-out routes (list or status, and delete or disconnect) stay open to a
 * user who owns at least one row of the surface, whatever the flag. Everyone
 * else gets exactly what they got before: the cloaked 404 of darkRouteGate while
 * the flag is off, without a session too, and cohortGate's 404 outside the
 * cohort. The routes that add data (connect, upload) keep darkRouteGate and
 * cohortGate and stay dark.
 */

import type {
  FastifyRequest,
  onRequestAsyncHookHandler,
  preHandlerAsyncHookHandler,
} from "fastify";
import { getUserId, verifiedPayload } from "../auth.js";
import { featureOpenTo } from "../config.js";
import { logDbFailure } from "../report-db-failure.js";
import { replyRouteNotFound } from "./dark-route-gate.js";

/** A surface with a way out, and who owns something on it. */
export interface OwnerExit {
  /** Names the surface in the remembered answers and in a failure log line. */
  readonly surface: string;
  /** Does this user own at least one row of the surface? Scoped to their own rows; may throw. */
  readonly owns: (userId: string) => Promise<boolean>;
}

/**
 * How long a "owns nothing here" answer is remembered. The lookup runs before
 * the rate limiter (a route-level hook), so without this any signed-in user
 * could query it without limit. Safe to remember: while the way out is the only
 * thing open to a user, the routes that add data are closed to them, so they
 * cannot become an owner meanwhile, and opening a flag or a cohort is an
 * environment change, a restart, which empties this. An owner is never
 * remembered: a delete takes effect at once.
 */
export const NOT_OWNER_TTL_MS = 60_000;
export const MAX_REMEMBERED_NON_OWNERS = 10_000;

/** `${surface}:${userId}` -> until when that user is known to own nothing there. */
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

/**
 * Does this user own a row of the surface? A database failure answers no,
 * without remembering it: the caller then gives the same cloaked 404 as for a
 * non-owner (a 500 would show the dark route exists), and the next request asks
 * again.
 */
async function isOwner(exit: OwnerExit, userId: string): Promise<boolean> {
  const key = `${exit.surface}:${userId}`;
  const now = Date.now();
  const until = notOwnerUntil.get(key);
  if (until !== undefined && now < until) return false;
  let owner: boolean;
  try {
    owner = await exit.owns(userId);
  } catch (err) {
    logDbFailure("[owner-exit] ownership check failed", err, {
      ids: { surface: exit.surface, userId },
    });
    return false;
  }
  if (owner) return true;
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
 * owns a row of the surface. A request without a valid token is answered
 * without a database lookup.
 */
export function ownerExitGate(exit: OwnerExit, gate: () => boolean): onRequestAsyncHookHandler {
  return async (request, reply) => {
    if (gate()) return;
    const userId = bearerUserId(request);
    if (userId !== null && (await isOwner(exit, userId))) {
      ownerChecked.set(request, userId);
      return;
    }
    return replyRouteNotFound(request, reply);
  };
}

/** preHandler, in place of cohortGate on the way-out routes: the cohort, and owners. */
export function ownerExitCohortGate(
  exit: OwnerExit,
  flags: readonly string[],
): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const userId = getUserId(request);
    if (featureOpenTo(userId, flags) || ownerChecked.get(request) === userId) return;
    if (await isOwner(exit, userId)) return;
    return replyRouteNotFound(request, reply);
  };
}
