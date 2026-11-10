/**
 * The request log's remoteAddress (index.ts registers serializeRequestForLog):
 * the derived client address, never request.ip, which under trustProxy is the
 * leftmost X-Forwarded-For entry a client writes.
 */

import { Writable } from "node:stream";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeRequestForLog } from "../security/request-log.js";

interface LoggedRequest {
  readonly method?: string;
  readonly url?: string;
  readonly host?: string;
  readonly remoteAddress?: string;
  readonly remotePort?: number;
}

async function loggedRequest(headers: Record<string, string>): Promise<LoggedRequest> {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const app = Fastify({
    trustProxy: true,
    logger: { level: "info", stream, serializers: { req: serializeRequestForLog } },
  });
  app.get("/api/ping", async () => ({ ok: true }));
  await app.inject({ method: "GET", url: "/api/ping", headers, remoteAddress: "192.0.2.20" });
  await app.close();
  const incoming = lines
    .map((line) => JSON.parse(line) as { msg?: string; req?: LoggedRequest })
    .find((entry) => entry.msg === "incoming request");
  if (!incoming?.req) throw new Error("no incoming request line was logged");
  return incoming.req;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("serializeRequestForLog", () => {
  it("logs the TCP peer by default, not a client-sent X-Forwarded-For", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "");
    vi.stubEnv("RENDER", "");
    const req = await loggedRequest({ "x-forwarded-for": "198.51.100.66" });
    expect(req.remoteAddress).toBe("192.0.2.20");
  });

  it("logs the edge-reported address behind Cloudflare", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "cf-connecting-ip");
    const req = await loggedRequest({
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "198.51.100.66",
    });
    expect(req.remoteAddress).toBe("203.0.113.7");
  });

  it("keeps Fastify's default fields", async () => {
    // remotePort is undefined under inject (no real socket), so JSON drops it.
    const req = await loggedRequest({});
    expect(req).toMatchObject({ method: "GET", url: "/api/ping", remoteAddress: "192.0.2.20" });
    expect(Object.keys(req)).toEqual(
      expect.arrayContaining(["method", "url", "host", "remoteAddress"]),
    );
  });
});
