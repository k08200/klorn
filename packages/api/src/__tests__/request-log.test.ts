/**
 * The request log (index.ts registers serializeRequestForLog and
 * answerRouteNotFound): the derived client address, never request.ip, which
 * under trustProxy is the leftmost X-Forwarded-For entry a client writes; and
 * the request path, never its query string, which carries OAuth codes, signed
 * states, unsubscribe tokens and addresses.
 */

import { Writable } from "node:stream";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerRouteNotFound, serializeRequestForLog } from "../security/request-log.js";

interface LoggedRequest {
  readonly method?: string;
  readonly url?: string;
  readonly host?: string;
  readonly remoteAddress?: string;
  readonly remotePort?: number;
}

/** Every log line one request writes, through the production serializer and 404 handler. */
async function logLines(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ lines: string[]; response: { statusCode: number; body: string } }> {
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
  app.setNotFoundHandler(answerRouteNotFound);
  app.get("/api/ping", async () => ({ ok: true }));
  app.get("/api/boom", async () => {
    throw new Error("boom");
  });
  const response = await app.inject({ method: "GET", url, headers, remoteAddress: "192.0.2.20" });
  await app.close();
  return { lines, response: { statusCode: response.statusCode, body: response.body } };
}

async function loggedRequest(headers: Record<string, string>): Promise<LoggedRequest> {
  const { lines } = await logLines("/api/ping", headers);
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

describe("the request log carries the path, never the query string", () => {
  const QUERY = "?code=4%2F0AbOauthCode-9f2&state=eyJhbGciOi.signed&email=alice%40example.com";
  const LEAKS = ["4%2F0AbOauthCode-9f2", "eyJhbGciOi", "alice", "example.com"];

  function expectNoQuery(lines: string[]): void {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      for (const leak of LEAKS) expect(line).not.toContain(leak);
    }
  }

  it("a matched route: the incoming line logs /api/ping", async () => {
    const { lines } = await logLines(`/api/ping${QUERY}`);
    expectNoQuery(lines);
    const incoming = lines
      .map((line) => JSON.parse(line) as { msg?: string; req?: LoggedRequest })
      .find((entry) => entry.msg === "incoming request");
    expect(incoming?.req?.url).toBe("/api/ping");
  });

  it("a route that fails with a 5xx: Fastify's error line logs the request too", async () => {
    const { lines, response } = await logLines(`/api/boom${QUERY}`);
    expect(response.statusCode).toBe(500);
    expect(lines.some((line) => line.includes('"level":50'))).toBe(true);
    expectNoQuery(lines);
  });

  it("an unmatched route: no 'Route GET:<url> not found' line with the query", async () => {
    const { lines, response } = await logLines(`/api/missing${QUERY}#frag=secret-frag`);
    expect(response.statusCode).toBe(404);
    expectNoQuery(lines);
    expect(lines.join("\n")).not.toContain("secret-frag");
    expect(lines.some((line) => line.includes("Route GET:/api/missing not found"))).toBe(true);
  });

  it("an unmatched route keeps Fastify's 404 body shape, which clients match on", async () => {
    const { response } = await logLines(`/api/missing${QUERY}`);
    expect(JSON.parse(response.body)).toEqual({
      message: "Route GET:/api/missing not found",
      error: "Not Found",
      statusCode: 404,
    });
  });
});
