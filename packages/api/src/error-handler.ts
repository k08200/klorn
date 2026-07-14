import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { captureError } from "./sentry.js";

/**
 * Global Fastify error handler.
 *
 * Fastify's default handler serializes `error.message` to the client
 * regardless of NODE_ENV, so an unexpected 5xx (e.g. a Prisma error that names
 * a table/column/enum, or a library error carrying an internal host) would leak
 * internals straight to the caller. This handler:
 *   - passes CLIENT (4xx) errors through unchanged — schema validation,
 *     rate-limit, and explicit `reply.code(4xx)` carry safe, intentional
 *     messages the caller needs;
 *   - logs SERVER (5xx) errors in full (+ Sentry) but replaces the response
 *     body with a generic message.
 */
export function handleError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const status = error.statusCode ?? 500;

  if (status < 500) {
    return reply.code(status).send({ error: error.message });
  }

  request.log.error(error);
  captureError(error, { tags: { scope: "fastify.errorHandler" } });
  return reply.code(status).send({ error: "Internal server error" });
}
