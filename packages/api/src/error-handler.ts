import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { DataWipeFenceError, isDataWipeFenceError } from "./privacy/data-wipe-fence.js";
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
 *     body with a generic message;
 *   - answers a write the data-wipe fence rejected with 409
 *     DATA_WIPE_IN_PROGRESS.
 */
export function handleError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  // The data-wipe fence rejected a write (the app check or the database
  // trigger): the account's data wipe is finishing or the request began before
  // it. A plain 409 the user can act on, never the trigger's text.
  if (isDataWipeFenceError(error)) {
    request.log.warn({ code: "DATA_WIPE_IN_PROGRESS" }, "write rejected by the data-wipe fence");
    const fence = new DataWipeFenceError();
    return reply.code(fence.statusCode).send({
      error: "Your data was just wiped. Try again in a few minutes.",
      code: fence.code,
    });
  }

  const status = error.statusCode ?? 500;

  if (status < 500) {
    return reply.code(status).send({ error: error.message });
  }

  request.log.error(error);
  captureError(error, { tags: { scope: "fastify.errorHandler" } });
  return reply.code(status).send({ error: "Internal server error" });
}
