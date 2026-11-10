/**
 * The global limiter's identity: the exact options index.ts registers
 * (rateLimitOptions), with a smaller max. Proves the
 * two properties that matter: a client cannot pick its bucket or claim an
 * exempt address by sending a header the deployment does not trust, and
 * traffic through a trusted edge keeps one bucket per real client.
 */

import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rateLimitOptions } from "../security/rate-limit-identity.js";
import { parseAllowedCidrs } from "../security/scanner-allowlist.js";

const MAX = 2;
const EXEMPT = "198.51.100.10";

async function buildApp(warn: (message: string) => void = () => {}) {
  // trustProxy as in index.ts, so request.ip is the forgeable value it is in prod.
  const app = Fastify({ trustProxy: true });
  await app.register(rateLimit, {
    ...rateLimitOptions(parseAllowedCidrs(EXEMPT), warn),
    max: MAX,
  });
  app.get("/api/ping", async () => ({ ok: true }));
  app.get("/api/auth/google/callback", async () => ({ ok: true }));
  return app;
}

function hit(
  app: Awaited<ReturnType<typeof buildApp>>,
  headers: Record<string, string> = {},
  url = "/api/ping",
  remoteAddress = "10.0.0.1",
) {
  return app.inject({ method: "GET", url, headers, remoteAddress });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("global limiter identity — default (self-host, no trusted header)", () => {
  it("a rotated CF-Connecting-IP does not buy a fresh bucket", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "");
    vi.stubEnv("RENDER", "");
    const app = await buildApp();
    for (let i = 0; i < MAX; i++) {
      expect((await hit(app, { "cf-connecting-ip": `203.0.113.${i + 1}` })).statusCode).toBe(200);
    }
    const rotated = await hit(app, { "cf-connecting-ip": "203.0.113.99" });
    expect(rotated.statusCode).toBe(429);
    await app.close();
  });

  it("a client-sent CF-Connecting-IP naming an exempt address is not exempt", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "");
    vi.stubEnv("RENDER", "");
    const app = await buildApp();
    const claimed = { "cf-connecting-ip": EXEMPT };
    for (let i = 0; i < MAX; i++) expect((await hit(app, claimed)).statusCode).toBe(200);
    expect((await hit(app, claimed)).statusCode).toBe(429);
    await app.close();
  });

  it("a forged X-Forwarded-For does not buy a fresh bucket either", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "");
    vi.stubEnv("RENDER", "");
    const app = await buildApp();
    for (let i = 0; i < MAX; i++) {
      expect((await hit(app, { "x-forwarded-for": `198.51.100.${i + 1}` })).statusCode).toBe(200);
    }
    expect((await hit(app, { "x-forwarded-for": "198.51.100.99" })).statusCode).toBe(429);
    await app.close();
  });
});

describe("global limiter identity — behind Cloudflare (hosted)", () => {
  it("keeps one bucket per real client", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "cf-connecting-ip");
    const app = await buildApp();
    const alice = { "cf-connecting-ip": "203.0.113.7" };
    const bob = { "cf-connecting-ip": "203.0.113.8" };
    for (let i = 0; i < MAX; i++) expect((await hit(app, alice)).statusCode).toBe(200);
    expect((await hit(app, alice)).statusCode).toBe(429);
    expect((await hit(app, bob)).statusCode).toBe(200);
    await app.close();
  });

  it("a forged X-Forwarded-For does not move a client out of its bucket", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "cf-connecting-ip");
    const app = await buildApp();
    const alice = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < MAX; i++) expect((await hit(app, alice)).statusCode).toBe(200);
    const forged = await hit(app, { ...alice, "x-forwarded-for": "198.51.100.1" });
    expect(forged.statusCode).toBe(429);
    await app.close();
  });

  it("exempts an allowlisted address the edge reports", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "cf-connecting-ip");
    const app = await buildApp();
    for (let i = 0; i < MAX + 2; i++) {
      expect((await hit(app, { "cf-connecting-ip": EXEMPT })).statusCode).toBe(200);
    }
    await app.close();
  });
});

describe("global limiter identity — behind a proxy that appends X-Forwarded-For", () => {
  it("keys on the proxy-appended entry, so a prepended value changes nothing", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "x-forwarded-for");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const app = await buildApp();
    for (let i = 0; i < MAX; i++) {
      const res = await hit(app, { "x-forwarded-for": `198.51.100.${i + 1}, 192.0.2.44` });
      expect(res.statusCode).toBe(200);
    }
    const forged = await hit(app, { "x-forwarded-for": "198.51.100.99, 192.0.2.44" });
    expect(forged.statusCode).toBe(429);
    const otherClient = await hit(app, { "x-forwarded-for": "192.0.2.45" });
    expect(otherClient.statusCode).toBe(200);
    await app.close();
  });
});

describe("global limiter allow list — scan exemption", () => {
  it("default: exempts a listed TCP peer (a scanner connecting directly)", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "");
    vi.stubEnv("RENDER", "");
    const app = await buildApp();
    for (let i = 0; i < MAX + 2; i++) {
      expect((await hit(app, {}, "/api/ping", EXEMPT)).statusCode).toBe(200);
    }
    await app.close();
  });

  it("default: a client-sent X-Forwarded-For naming a listed address is not exempt", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "");
    vi.stubEnv("RENDER", "");
    const app = await buildApp();
    const claimed = { "x-forwarded-for": EXEMPT };
    for (let i = 0; i < MAX; i++) expect((await hit(app, claimed)).statusCode).toBe(200);
    expect((await hit(app, claimed)).statusCode).toBe(429);
    await app.close();
  });

  it("x-forwarded-for: a prepended listed address is not exempt, a proxy-appended one is", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "x-forwarded-for");
    const app = await buildApp();
    const prepended = { "x-forwarded-for": `${EXEMPT}, 192.0.2.44` };
    for (let i = 0; i < MAX; i++) expect((await hit(app, prepended)).statusCode).toBe(200);
    expect((await hit(app, prepended)).statusCode).toBe(429);
    for (let i = 0; i < MAX + 2; i++) {
      expect((await hit(app, { "x-forwarded-for": `192.0.2.44, ${EXEMPT}` })).statusCode).toBe(200);
    }
    await app.close();
  });
});

describe("global limiter — proxied-without-source warning", () => {
  it("warns once when the TCP peer is the source but requests carry a forwarding header", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "");
    vi.stubEnv("RENDER", "");
    const warn = vi.fn();
    const app = await buildApp(warn);
    await hit(app, {});
    expect(warn).not.toHaveBeenCalled();
    await hit(app, { "x-forwarded-for": "192.0.2.44" });
    await hit(app, { "cf-connecting-ip": "192.0.2.45" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("CLIENT_IP_SOURCE");
    await app.close();
  });

  it("stays quiet when a header source is configured", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "x-forwarded-for");
    const warn = vi.fn();
    const app = await buildApp(warn);
    await hit(app, { "x-forwarded-for": "192.0.2.44" });
    expect(warn).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("global limiter allow list — route exemptions", () => {
  it("still exempts the Google OAuth callback", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "");
    const app = await buildApp();
    for (let i = 0; i < MAX + 2; i++) {
      expect((await hit(app, {}, "/api/auth/google/callback")).statusCode).toBe(200);
    }
    await app.close();
  });
});
