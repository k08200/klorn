import type { FastifyReply, FastifyRequest } from "fastify";
import { replyRouteNotFound } from "../routes/dark-route-gate.js";
import { clientAddress } from "./client-address.js";

/**
 * A request target without its query string or fragment.
 *
 * The query is where an OAuth callback's code and signed state, an unsubscribe
 * or push-later token and a looked-up address travel, and the log drain keeps
 * whatever reaches it beyond the account (a wipe or deletion does not reach
 * it). The path says which route was asked for, which is what a request log is
 * for.
 */
export function pathOfRequestTarget(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * Fastify's default request serializer (fastify/lib/logger-pino.js), except:
 *   - remoteAddress: the derived client address instead of request.ip, which
 *     under trustProxy is the leftmost X-Forwarded-For entry a client writes.
 *     Keeps a made-up address out of the request log.
 *   - url: the path only (pathOfRequestTarget). Fastify logs `req` through this
 *     serializer on the incoming line and on a 5xx's error line.
 */
export function serializeRequestForLog(req: FastifyRequest) {
  const version = req.headers["accept-version"];
  return {
    method: req.method,
    url: pathOfRequestTarget(req.url),
    version: typeof version === "string" ? version : undefined,
    host: req.host,
    remoteAddress: clientAddress(req),
    remotePort: req.socket?.remotePort,
  };
}

/**
 * The not-found handler (index.ts). Fastify's default (fastify/lib/four-oh-four.js
 * basic404) logs `Route GET:<url> not found` with the raw URL, query included,
 * past the `req` serializer. This logs that line with the path only, and
 * answers exactly as the default does (replyRouteNotFound): a dark route
 * (dark-route-gate.ts) answers with that same body and must stay
 * indistinguishable from a missing one, and clients tell an undeployed route
 * by it (web notification-center.ts). The body echoes the query back only to
 * the client that sent it.
 *
 * Unlike the default it logs even under Fastify's `disableRequestLogging`,
 * which the API does not set.
 */
export function answerRouteNotFound(request: FastifyRequest, reply: FastifyReply) {
  request.log.info(`Route ${request.method}:${pathOfRequestTarget(request.url)} not found`);
  return replyRouteNotFound(request, reply);
}
