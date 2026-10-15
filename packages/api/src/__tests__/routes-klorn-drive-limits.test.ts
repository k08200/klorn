/**
 * D7: `GET /api/drive/limits`, the probe a client reads before it offers an
 * upload (the Mac app's "Import to Klorn Drive"). Behind the same gate as the
 * other D3 routes (Fastify's default 404 unless all three flags are on),
 * session-authenticated, scoped to the session's user, rate limited per address
 * and per user. It answers the file cap, the quota (null while uploads are
 * refused for want of one) and the user's usage.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKlornDriveApp,
  FLAGS,
  flagsOn,
  type KlornDriveTestApp,
  klornRow,
  PREFIX,
  resetRowIds,
  TEST_QUOTA_BYTES,
} from "./helpers/klorn-drive-app.js";

vi.mock("../db.js", async () => {
  const { klornDriveDbMock } = await import("./helpers/klorn-drive-app.js");
  return klornDriveDbMock();
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const MAX_FILE_BYTES = 25 * 1024 * 1024;
let t: KlornDriveTestApp;

const limits = (headers: Record<string, string>) =>
  t.app.inject({ method: "GET", url: `${PREFIX}/limits`, headers });

beforeEach(async () => {
  resetRowIds();
  flagsOn();
  vi.spyOn(console, "error").mockImplementation(() => {});
  t = await buildKlornDriveApp();
});

afterEach(async () => {
  await t.app.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/drive/limits", () => {
  it.each(FLAGS)("with %s off, it answers like a route that does not exist", async (flag) => {
    vi.stubEnv(flag, "false");
    const bare = Fastify();
    await bare.ready();
    const dark = await limits(t.me);
    const missing = await bare.inject({ method: "GET", url: `${PREFIX}/limits` });
    expect(dark.statusCode).toBe(404);
    expect(dark.body).toBe(missing.body);
    await bare.close();
  });

  it("answers 401 without a session", async () => {
    expect((await limits({})).statusCode).toBe(401);
  });

  it("answers the file cap, the quota and only this user's Klorn usage", async () => {
    await t.app.close();
    t = await buildKlornDriveApp({
      seed: [
        klornRow({ sizeBytes: 100n }),
        klornRow({ sizeBytes: 23n }),
        klornRow({ isFolder: true, mimeType: null, sizeBytes: null }),
        klornRow({ userId: "user-2", sizeBytes: 5000n }),
        klornRow({ provider: "GOOGLE", sourceKey: "g", sizeBytes: 7000n }),
      ],
    });
    const res = await limits(t.me);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      maxFileBytes: MAX_FILE_BYTES,
      quotaBytes: Number(TEST_QUOTA_BYTES),
      usedBytes: 123,
    });
  });

  it.each([
    ["unset", ""],
    ["not a whole number", "10GB"],
  ])("a quota that is %s answers null: uploads are refused", async (_label, value) => {
    vi.stubEnv("KLORN_DRIVE_QUOTA_BYTES", value);
    const res = await limits(t.me);
    expect(res.statusCode).toBe(200);
    expect(res.json().quotaBytes).toBeNull();
  });

  it("60 a minute per address, and 60 per user from any address", async () => {
    await t.app.close();
    t = await buildKlornDriveApp({ withRateLimit: true });
    const from = (ip: number, headers: Record<string, string>) => ({
      ...headers,
      "cf-connecting-ip": `10.0.0.${ip}`,
    });
    for (let i = 0; i < 60; i += 1) {
      expect((await limits(from(1, i % 2 === 0 ? t.me : t.other))).statusCode).toBe(200);
    }
    expect((await limits(from(1, t.me))).statusCode).toBe(429);
    // user-1 asked 30 times above; 30 more from other addresses reach its limit.
    for (let i = 0; i < 30; i += 1) {
      expect((await limits(from(i + 2, t.me))).statusCode).toBe(200);
    }
    const limited = await limits(from(250, t.me));
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe("rate-limited");
    expect((await limits(from(251, t.other))).statusCode).toBe(200);
  });
});
