import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { COST_CAP_HTTP_STATUS, costCapRefusal } from "./llm/cost-cap-refusal.js";
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
 *     DATA_WIPE_IN_PROGRESS;
 *   - answers an LLM call the daily cost cap refused with 429 and the cap's
 *     own message + code — expected back-pressure, so no Sentry alert.
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

  // The daily cost cap stopped an LLM call no route caught. It cannot succeed
  // until the cap resets, so a 500 ("something broke, retry") is the wrong
  // signal — answer the same 429 the routes that catch it answer.
  const capped = costCapRefusal(error);
  if (capped) {
    request.log.warn({ code: capped.code }, "LLM call refused by the daily cost cap");
    return reply.code(COST_CAP_HTTP_STATUS).send(capped);
  }

  const status = error.statusCode ?? 500;

  if (status < 500) {
    return reply.code(status).send({ error: error.message });
  }

  request.log.error(error);
  captureError(error, { tags: { scope: "fastify.errorHandler" } });
  return reply.code(status).send({ error: "Internal server error" });
}
