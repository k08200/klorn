/**
 * Guards for the two lane reads that scan a user's whole mailbox — the
 * thread-grouped page (`GET /api/email?threads=1` with a lane) and the lane
 * counts (`GET /api/email/lane-counts`) — ahead of MAIL_V2 / UNIFIED_HOME
 * being turned on:
 *
 * - a per-USER rate limit, on top of the per-address route limit, so one
 *   account cannot loop either read from many addresses;
 * - a retryable 503 when the read passed its statement timeout
 *   (db-statement-timeout.ts), instead of a generic 500.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserId } from "../auth.js";
import { QueryTimeoutError } from "../db-statement-timeout.js";
import { isJudgeV3PolicyEnabled } from "../judge/v3/flags.js";
import { rateLimitHook } from "./rate-limit-hook.js";

/** Each grouped page is a full-view scan; a busy session pages well under this. */
export const LANE_THREADS_USER_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;
/** Lane counts are re-read on every view change and action, like their per-address limit. */
export const LANE_COUNTS_USER_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

const HTTP_SERVICE_UNAVAILABLE = 503;
/** Seconds a client should wait before retrying a timed-out lane read. */
const QUERY_TIMEOUT_RETRY_AFTER_S = 5;
const RATE_LIMITED = "Too many mail list requests. Try again shortly.";
const QUERY_TIMED_OUT = "Mail is taking too long to load. Try again shortly.";

/** True when the list request asks for the thread-grouped lane page. */
export function wantsThreadGroups(query: unknown): boolean {
  const { threads, tier } = (query ?? {}) as { threads?: unknown; tier?: unknown };
  return (threads === "1" || threads === "true") && typeof tier === "string" && tier.length > 0;
}

/**
 * True when the list request asks for the ranked QUEUE page: attention engine
 * v3, for a user under the policy. Ranked order sorts the whole lane, like a
 * thread page scans it.
 */
export function wantsRankedQueue(userId: string, query: unknown): boolean {
  const { tier } = (query ?? {}) as { tier?: unknown };
  return tier === "QUEUE" && isJudgeV3PolicyEnabled(userId);
}

/**
 * preHandler: the per-user limit, applied only to the full-view list requests:
 * thread-grouped pages and the ranked QUEUE page (one shared budget).
 */
export function laneThreadsUserLimit(app: FastifyInstance) {
  const limit = rateLimitHook(
    app,
    LANE_THREADS_USER_RATE_LIMIT,
    (request) => `email:threads:user:${getUserId(request)}`,
    RATE_LIMITED,
  );
  return async function threadsLimited(request: FastifyRequest, reply: FastifyReply) {
    const fullView =
      wantsThreadGroups(request.query) || wantsRankedQueue(getUserId(request), request.query);
    if (!fullView) return;
    return limit(request, reply);
  };
}

/** preHandler: the per-user limit on the lane counts. */
export function laneCountsUserLimit(app: FastifyInstance) {
  return rateLimitHook(
    app,
    LANE_COUNTS_USER_RATE_LIMIT,
    (request) => `email:lane-counts:user:${getUserId(request)}`,
    RATE_LIMITED,
  );
}

/**
 * Answer a timed-out lane read as a retryable 503 and return true; return
 * false for any other error, which the caller rethrows.
 */
export function replyIfQueryTimedOut(err: unknown, reply: FastifyReply): boolean {
  if (!(err instanceof QueryTimeoutError)) return false;
  reply
    .code(HTTP_SERVICE_UNAVAILABLE)
    .header("retry-after", String(QUERY_TIMEOUT_RETRY_AFTER_S))
    .send({ error: QUERY_TIMED_OUT, code: "query-timeout", retryable: true });
  return true;
}
