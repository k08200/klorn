import type { FastifyRequest } from "fastify";
import { clientAddress } from "./client-address.js";

/**
 * Fastify's default request serializer (fastify/lib/logger-pino.js), except
 * remoteAddress: the derived client address instead of request.ip, which under
 * trustProxy is the leftmost X-Forwarded-For entry a client writes. Keeps a
 * made-up address out of the request log.
 */
export function serializeRequestForLog(req: FastifyRequest) {
  const version = req.headers["accept-version"];
  return {
    method: req.method,
    url: req.url,
    version: typeof version === "string" ? version : undefined,
    host: req.host,
    remoteAddress: clientAddress(req),
    remotePort: req.socket?.remotePort,
  };
}
