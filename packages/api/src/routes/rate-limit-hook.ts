/**
 * One more rate limit on a route, keyed by whatever the caller chooses: a user id
 * after authentication, a device session before it. Route config (`config:
 * { rateLimit }`) gives a route ONE limit, keyed by client address; this adds a
 * second with a key and a place in the hook order of its own.
 *
 * The same hook as the private `limitHook` in routes/device-calendar.ts (C6),
 * which can adopt this one.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const HTTP_TOO_MANY_REQUESTS = 429;

export interface RouteRateLimit {
  readonly max: number;
  readonly timeWindow: string;
}

/**
 * A hook enforcing `limit` per `keyGenerator(request)`, answering 429
 * `{ error: message }` with a retry-after header once it is passed. It does
 * nothing when the rate-limit plugin is not registered (some tests), or when an
 * earlier hook already answered.
 */
export function rateLimitHook(
  app: FastifyInstance,
  limit: RouteRateLimit,
  keyGenerator: (request: FastifyRequest) => string,
  message: string,
) {
  const limiter = app.hasDecorator("createRateLimit")
    ? app.createRateLimit({ ...limit, keyGenerator })
    : null;
  return async function rateLimited(request: FastifyRequest, reply: FastifyReply) {
    if (!limiter || reply.sent) return;
    const result = await limiter(request);
    if (result.isAllowed || !result.isExceeded) return;
    reply.header("retry-after", String(result.ttlInSeconds));
    return reply.code(HTTP_TOO_MANY_REQUESTS).send({ error: message });
  };
}
