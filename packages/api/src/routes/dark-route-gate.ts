/**
 * onRequest hook that makes every route in a plugin answer Fastify's default
 * 404 — byte-for-byte (fastify/lib/four-oh-four.js) — while `gate()` is
 * false. Used for provider surfaces that must stay dark until their flag
 * flips (CASA surface freeze): a dark route has to be indistinguishable from
 * a route that doesn't exist, even to an unauthenticated probe, and a static
 * "Not Found" body would let a scanner diff it against a truly unregistered
 * sibling. onRequest (not preHandler) so it fires before any auth hook.
 */

import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from "fastify";

/** Fastify's default 404 for this request, as for a route that does not exist. */
export function replyRouteNotFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const { url, method } = request.raw;
  reply.code(404);
  return reply.send({
    message: `Route ${method}:${url} not found`,
    error: "Not Found",
    statusCode: 404,
  });
}

export function darkRouteGate(gate: () => boolean): onRequestAsyncHookHandler {
  return async (request, reply) => {
    if (!gate()) return replyRouteNotFound(request, reply);
  };
}
