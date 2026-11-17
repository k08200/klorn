import type { FastifyReply, FastifyRequest } from "fastify";
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
 * past the `req` serializer. Same line and same body, path only: clients tell a
 * route that is not deployed by that body (web notification-center.ts matches
 * `Route <METHOD>:<path> not found`).
 */
export function answerRouteNotFound(request: FastifyRequest, reply: FastifyReply) {
  const message = `Route ${request.method}:${pathOfRequestTarget(request.url)} not found`;
  request.log.info(message);
  return reply.code(404).send({ message, error: "Not Found", statusCode: 404 });
}
