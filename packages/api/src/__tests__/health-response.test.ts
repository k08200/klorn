import { describe, expect, it } from "vitest";
import { healthResponse } from "../ops/health-response.js";

// /api/health checked the database but answered 200 either way, so nothing
// that reads the status code (the keepalive and prod-lag workflows use
// `curl -f`) noticed a database outage. It now answers 503 when the database
// probe fails, with the same JSON body (commit, version, uptime) as before.

const meta = {
  version: "0.3.0",
  commit: "abc123",
  now: new Date("2026-10-16T12:00:00Z"),
  uptimeSeconds: 42,
};

describe("healthResponse", () => {
  it("is 200 and ok when the database answers", async () => {
    const { statusCode, body } = await healthResponse(async () => {}, meta);

    expect(statusCode).toBe(200);
    expect(body).toEqual({
      status: "ok",
      db: "connected",
      timestamp: "2026-10-16T12:00:00.000Z",
      uptime: 42,
      version: "0.3.0",
      commit: "abc123",
    });
  });

  it("is 503 and degraded, with the same fields, when the database probe fails", async () => {
    const { statusCode, body } = await healthResponse(async () => {
      throw new Error("Can't reach database server");
    }, meta);

    expect(statusCode).toBe(503);
    expect(body).toMatchObject({ status: "degraded", db: "unreachable", commit: "abc123" });
    expect(JSON.stringify(body)).not.toContain("reach database");
  });
});
