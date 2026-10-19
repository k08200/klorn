import { describe, expect, it, vi } from "vitest";
import { HEALTH_DB_PROBE_TIMEOUT_MS, healthResponse } from "../ops/health-response.js";

// Two endpoints share one probe. /api/health is liveness: it answers 200 while
// the process serves requests, whatever the database does, so a platform
// health check pointed at it (Render's dashboard can set one) never restarts a
// healthy process over a database blip. /api/health/ready is readiness: 503
// while the database probe fails, so monitors that read the status code
// (`curl -f` in the keepalive workflow) see the outage. Both carry the same body.

const meta = {
  version: "0.3.0",
  commit: "abc123",
  now: new Date("2026-10-16T12:00:00Z"),
  uptimeSeconds: 42,
};

describe("healthResponse", () => {
  it("is ready, with an ok body, when the database answers", async () => {
    const { ready, body } = await healthResponse(async () => {}, meta);

    expect(ready).toBe(true);
    expect(body).toEqual({
      status: "ok",
      db: "connected",
      timestamp: "2026-10-16T12:00:00.000Z",
      uptime: 42,
      version: "0.3.0",
      commit: "abc123",
    });
  });

  it("is not ready, with the same fields and no error text, when the probe fails", async () => {
    const { ready, body } = await healthResponse(async () => {
      throw new Error("Can't reach database server");
    }, meta);

    expect(ready).toBe(false);
    expect(body).toMatchObject({ status: "degraded", db: "unreachable", commit: "abc123" });
    expect(JSON.stringify(body)).not.toContain("reach database");
  });
});

describe("healthResponse probe timeout", () => {
  it("gives up on a hanging probe within a platform health check's patience", async () => {
    expect(HEALTH_DB_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
    vi.useFakeTimers();
    try {
      const pending = healthResponse(() => new Promise(() => {}), meta);
      await vi.advanceTimersByTimeAsync(HEALTH_DB_PROBE_TIMEOUT_MS);
      const { ready, body } = await pending;
      expect(ready).toBe(false);
      expect(body.db).toBe("unreachable");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the health routes", () => {
  const source = () =>
    import("node:fs").then(({ readFileSync }) =>
      readFileSync(new URL("../index.ts", import.meta.url), "utf8"),
    );

  it("answers liveness with 200 whatever the probe said", async () => {
    const index = await source();
    const route = index.slice(index.indexOf('app.get("/api/health",'));
    const handler = route.slice(0, route.indexOf("\n});"));
    expect(handler).toContain("reply.code(200).send(body)");
  });

  it("answers readiness with 503 when the probe failed", async () => {
    const index = await source();
    expect(index).toContain('app.get("/api/health/ready",');
    const route = index.slice(index.indexOf('app.get("/api/health/ready",'));
    const handler = route.slice(0, route.indexOf("\n});"));
    expect(handler).toContain("reply.code(ready ? 200 : 503).send(body)");
  });
});
