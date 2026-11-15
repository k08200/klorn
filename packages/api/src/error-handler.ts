import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { COST_CAP_HTTP_STATUS, costCapRefusal } from "./llm/cost-cap-refusal.js";
import { isLlmFailure, llmFailureFacts } from "./llm/describe-failure.js";
import { captureLlmFailure } from "./llm/report-llm-failure.js";
import { DataWipeFenceError, isDataWipeFenceError } from "./privacy/data-wipe-fence.js";
import { captureDbFailure, dbFailureFacts } from "./report-db-failure.js";

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
 *   - answers SERVER (5xx) errors with a generic message and logs and reports
 *     them as facts only, never the error object: an LLM failure as its class,
 *     status and provider code (llmFailureFacts); anything else as its class,
 *     Prisma or system code, Prisma model and operation, HTTP status and
 *     message length (dbFailureFacts). See "Why no 5xx keeps its message";
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

  // An LLM failure no route caught (GET /api/commitments/:id/path and
  // POST /api/commitments/:id/path/rebuild build the path with the model and
  // have no catch). pino, like Sentry, prints the
  // message and the cause chain, and a provider's message can quote the
  // request's mail, so both get the facts only. The response is the same.
  if (isLlmFailure(error)) {
    request.log.error(
      { llmFailure: llmFailureFacts(error) },
      "LLM failure reached the error handler",
    );
    captureLlmFailure("Unhandled LLM failure in a route", error, {
      tags: { scope: "fastify.errorHandler" },
      extra: { method: request.method, route: request.routeOptions?.url ?? null },
    });
    return reply.code(status).send({ error: "Internal server error" });
  }

  // Why no 5xx keeps its message. Every route that rethrows lands here: a
  // Prisma error over the row being written (a PrismaClientValidationError
  // renders the whole call, values included, even in production's "minimal"
  // format; a raw-query failure quotes the bad value), a provider error over
  // the event it sent, a statement timeout carrying the Prisma error as
  // `cause`. pino's err serializer prints the message and the cause chain, and
  // Sentry sends both. A message is safe only when it is provably written in
  // code, and nothing here can prove that at runtime: `name` is assignable, our
  // own classes (TimeoutError, OrgError, StorageError, plain Error) take
  // caller-built text, and a class whose message is fixed (QueryTimeoutError,
  // SendOutcomeUnknownError) carries its cause. A fixed message also says no
  // more than the class name the facts keep, and Sentry keeps the original's
  // stack frames, so the throw site stays visible. Client errors (4xx above:
  // schema validation, typed app errors with a statusCode) keep their message
  // in the response and are not logged here.
  request.log.error(
    { failure: dbFailureFacts(error) },
    "Unhandled failure reached the error handler",
  );
  captureDbFailure("Unhandled failure in a route", error, {
    tags: { scope: "fastify.errorHandler" },
    extra: { method: request.method, route: request.routeOptions?.url ?? null },
  });
  return reply.code(status).send({ error: "Internal server error" });
}
