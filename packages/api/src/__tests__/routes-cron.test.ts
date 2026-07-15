/**
 * Auth boundary tests for the external cron endpoint. The trigger logic
 * itself (briefing window math, dedup, error mapping) is covered by the
 * existing automation-scheduler + briefing tests; this file only locks
 * down the "no one can pretend to be the cron caller" property.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Don't let the real briefing path or DB run during this test — we're
// asserting on the AUTH branch, which short-circuits before the DB call.
vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: {
      findMany: vi.fn(async () => []),
    },
  },
}));
vi.mock("../pim/briefing.js", () => ({
  createDailyBriefingDelivery: vi.fn(),
}));
vi.mock("../automation-scheduler.js", () => ({
  isBriefingDue: vi.fn(() => false),
  hasBriefingBeenSentToday: vi.fn(async () => false),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../time-zone.js", () => ({ normalizeTimeZone: (tz: string | null) => tz ?? "UTC" }));

const { cronRoutes } = await import("../routes/cron.js");

async function buildApp(secret: string | undefined) {
  if (secret === undefined) delete process.env.BRIEFING_CRON_SECRET;
  else process.env.BRIEFING_CRON_SECRET = secret;
  const app = Fastify();
  await app.register(cronRoutes, { prefix: "/api/cron" });
  return app;
}

describe("POST /api/cron/briefing-tick — auth boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 503 when BRIEFING_CRON_SECRET is unset (fail closed)", async () => {
    const app = await buildApp(undefined);
    const res = await app.inject({ method: "POST", url: "/api/cron/briefing-tick" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false });
    await app.close();
  });

  it("returns 503 when the configured secret is too short", async () => {
    const app = await buildApp("short");
    const res = await app.inject({
      method: "POST",
      url: "/api/cron/briefing-tick",
      headers: { "x-cron-secret": "short" },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("returns 401 when no X-Cron-Secret header is provided", async () => {
    const app = await buildApp("a-properly-long-cron-secret-value-1234");
    const res = await app.inject({ method: "POST", url: "/api/cron/briefing-tick" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 when the secret is wrong", async () => {
    const app = await buildApp("a-properly-long-cron-secret-value-1234");
    const res = await app.inject({
      method: "POST",
      url: "/api/cron/briefing-tick",
      headers: { "x-cron-secret": "a-properly-long-cron-secret-value-WRNG" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 when the provided secret has a different length", async () => {
    // Defensive — timingSafeEqual would throw on different-length buffers;
    // we short-circuit on length first.
    const app = await buildApp("a-properly-long-cron-secret-value-1234");
    const res = await app.inject({
      method: "POST",
      url: "/api/cron/briefing-tick",
      headers: { "x-cron-secret": "shorter" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 200 with the correct secret", async () => {
    const app = await buildApp("a-properly-long-cron-secret-value-1234");
    const res = await app.inject({
      method: "POST",
      url: "/api/cron/briefing-tick",
      headers: { "x-cron-secret": "a-properly-long-cron-secret-value-1234" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, triggered: 0, skipped: 0, failed: 0 });
    await app.close();
  });
});
