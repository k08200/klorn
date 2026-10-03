/**
 * C6: the device calendar routes. A desktop app uploads one snapshot per calendar
 * the user turned on (PUT .../sources/:key/window), lists what it uploaded, and
 * removes a calendar the user turned off (DELETE .../sources/:key). Device-session
 * authenticated, user-scoped, validated at the boundary, rate limited per device
 * session and per user, and dark (Fastify's default 404, byte-identical to an
 * unregistered route) while DEVICE_CALENDAR_ENABLED is off.
 */

import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  ingest: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "PRO", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "device-1" })),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../pim/device-calendar/device-ingest.js", () => ({ ingestDeviceSnapshot: m.ingest }));
vi.mock("../pim/device-calendar/device-sources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pim/device-calendar/device-sources.js")>()),
  listDeviceSources: m.list,
  removeDeviceSource: m.remove,
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  DEVICE_SNAPSHOT_BODY_LIMIT_BYTES,
  DEVICE_SNAPSHOT_MAX_EVENTS,
} from "../pim/device-calendar/device-snapshot.js";

const KEY = "c".repeat(64);
const PREFIX = "/api/device-calendar";
const saved = process.env.DEVICE_CALENDAR_ENABLED;

async function buildApp(opts: { withRateLimit?: boolean } = {}) {
  vi.resetModules();
  const { signToken } = await import("../auth.js");
  const { deviceCalendarRoutes } = await import("../routes/device-calendar.js");
  const { deviceCalendarEnabled } = await import("../config.js");
  const app = Fastify();
  if (opts.withRateLimit) await app.register(rateLimit, { max: 100_000, timeWindow: "1 minute" });
  await app.register(deviceCalendarRoutes({ gate: deviceCalendarEnabled }), { prefix: PREFIX });
  await app.ready();
  const token = (email: string) => signToken({ userId: "user-1", email });
  return {
    app,
    headers: { authorization: `Bearer ${token("a@example.com")}` },
    otherDevice: { authorization: `Bearer ${token("b@example.com")}` },
    thirdDevice: { authorization: `Bearer ${token("c@example.com")}` },
  };
}

function snapshotBody(init: Record<string, unknown> = {}) {
  return {
    windowStart: "2026-10-01T15:00:00.000Z",
    windowEnd: "2026-10-31T15:00:00.000Z",
    snapshotAt: "2026-10-02T02:59:00.000Z",
    calendarTitle: "Work",
    events: [
      {
        externalId: "e1",
        title: "Design review",
        start: "2026-10-05T10:00:00+09:00",
        end: "2026-10-05T11:00:00+09:00",
        allDay: false,
        location: null,
        meetingLink: "javascript:alert(1)",
        status: "confirmed",
      },
    ],
    ...init,
  };
}

function put(key: string, payload: unknown, headers: Record<string, string>) {
  return {
    method: "PUT" as const,
    url: `${PREFIX}/sources/${key}/window`,
    payload: payload as object,
    headers,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T03:00:00.000Z"));
  process.env.DEVICE_CALENDAR_ENABLED = "true";
  m.ingest.mockResolvedValue({
    kind: "stored",
    created: 1,
    updated: 0,
    removed: 0,
    resolved: 0,
    valveRefused: false,
  });
  m.list.mockResolvedValue([]);
  m.remove.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  if (saved === undefined) delete process.env.DEVICE_CALENDAR_ENABLED;
  else process.env.DEVICE_CALENDAR_ENABLED = saved;
});

describe("dark while DEVICE_CALENDAR_ENABLED is off", () => {
  it.each([
    ["GET", `${PREFIX}/sources`],
    ["PUT", `${PREFIX}/sources/${KEY}/window`],
    ["DELETE", `${PREFIX}/sources/${KEY}`],
  ] as const)("%s %s answers exactly what an unregistered route answers", async (method, url) => {
    process.env.DEVICE_CALENDAR_ENABLED = "false";
    const { app, headers } = await buildApp();
    const bare = Fastify();
    await bare.ready();

    const res = await app.inject({
      method,
      url,
      headers,
      payload: method === "PUT" ? snapshotBody() : undefined,
    });
    const unregistered = await bare.inject({ method, url });

    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(unregistered.body);
    expect(m.ingest).not.toHaveBeenCalled();
    expect(m.list).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
  });

  it("an unauthenticated probe gets the same 404, not a 401", async () => {
    process.env.DEVICE_CALENDAR_ENABLED = "false";
    const { app } = await buildApp();
    const res = await app.inject({ method: "GET", url: `${PREFIX}/sources` });
    expect(res.statusCode).toBe(404);
  });

  it("is read per request: turning it on needs no restart", async () => {
    process.env.DEVICE_CALENDAR_ENABLED = "false";
    const { app, headers } = await buildApp();
    expect(
      (await app.inject({ method: "GET", url: `${PREFIX}/sources`, headers })).statusCode,
    ).toBe(404);
    process.env.DEVICE_CALENDAR_ENABLED = "true";
    expect(
      (await app.inject({ method: "GET", url: `${PREFIX}/sources`, headers })).statusCode,
    ).toBe(200);
  });
});

describe("authentication", () => {
  it.each([
    ["GET", `${PREFIX}/sources`],
    ["PUT", `${PREFIX}/sources/${KEY}/window`],
    ["DELETE", `${PREFIX}/sources/${KEY}`],
  ] as const)("%s %s needs a device session", async (method, url) => {
    const { app } = await buildApp();
    const res = await app.inject({
      method,
      url,
      payload: method === "PUT" ? snapshotBody() : undefined,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("PUT /sources/:key/window", () => {
  it("stores the normalised snapshot for the token's user and that key", async () => {
    const { app, headers } = await buildApp();

    const res = await app.inject(put(KEY, snapshotBody(), headers));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      created: 1,
      updated: 0,
      removed: 0,
      skipped: 0,
      valveRefused: false,
    });
    expect(m.ingest).toHaveBeenCalledTimes(1);
    const [userId, key, snapshot] = m.ingest.mock.calls[0] ?? [];
    expect(userId).toBe("user-1");
    expect(key).toBe(KEY);
    // safeMeetingLink ran at the boundary: the javascript: link never reaches a row.
    expect(snapshot.events[0].fields.meetingLink).toBeNull();
    expect(snapshot.events[0].fields.startTime.toISOString()).toBe("2026-10-05T01:00:00.000Z");
  });

  it.each([
    ["a raw EventKit identifier", "5C7B3D2E-1F4A-4B6C-9D8E-0A1B2C3D4E5F"],
    ["uppercase hex", "C".repeat(64)],
    ["a short key", "c".repeat(32)],
  ])("refuses %s as the key", async (_label, key) => {
    const { app, headers } = await buildApp();
    const res = await app.inject(put(key, snapshotBody(), headers));
    expect(res.statusCode).toBe(400);
    expect(m.ingest).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing window", { windowStart: undefined }],
    ["a window over the maximum", { windowEnd: "2026-12-31T15:00:00.000Z" }],
    ["a naive window time", { windowStart: "2026-10-02T00:00:00" }],
    [
      "too many events",
      {
        events: Array.from({ length: DEVICE_SNAPSHOT_MAX_EVENTS + 1 }, (_, i) => ({
          externalId: `e${i}`,
          title: "x",
          start: "2026-10-05T01:00:00Z",
          end: "2026-10-05T02:00:00Z",
          allDay: false,
        })),
      },
    ],
    [
      "an over-long title",
      {
        events: [
          {
            externalId: "e1",
            title: "x".repeat(501),
            start: "2026-10-05T01:00:00Z",
            end: "2026-10-05T02:00:00Z",
            allDay: false,
          },
        ],
      },
    ],
    ["an over-long calendar title", { calendarTitle: "x".repeat(201) }],
    [
      "an over-long location",
      {
        events: [
          {
            externalId: "e1",
            title: "x",
            start: "2026-10-05T01:00:00Z",
            end: "2026-10-05T02:00:00Z",
            allDay: false,
            location: "x".repeat(501),
          },
        ],
      },
    ],
    [
      "an over-long meeting link",
      {
        events: [
          {
            externalId: "e1",
            title: "x",
            start: "2026-10-05T01:00:00Z",
            end: "2026-10-05T02:00:00Z",
            allDay: false,
            meetingLink: `https://x.example/${"a".repeat(2048)}`,
          },
        ],
      },
    ],
    [
      "an over-long external id",
      {
        events: [
          {
            externalId: "x".repeat(513),
            title: "x",
            start: "2026-10-05T01:00:00Z",
            end: "2026-10-05T02:00:00Z",
            allDay: false,
          },
        ],
      },
    ],
    [
      "an unknown status",
      {
        events: [
          {
            externalId: "e1",
            title: "x",
            start: "2026-10-05T01:00:00Z",
            end: "2026-10-05T02:00:00Z",
            allDay: false,
            status: "maybe",
          },
        ],
      },
    ],
    [
      "an all-day event given as an instant",
      {
        events: [
          {
            externalId: "e1",
            title: "x",
            start: "2026-10-05T00:00:00Z",
            end: "2026-10-06",
            allDay: true,
          },
        ],
      },
    ],
  ])("answers 400 for %s, storing nothing", async (_label, init) => {
    const { app, headers } = await buildApp();
    const res = await app.inject(put(KEY, snapshotBody(init), headers));
    expect(res.statusCode).toBe(400);
    expect(m.ingest).not.toHaveBeenCalled();
  });

  it(`answers 413 for a body over ${DEVICE_SNAPSHOT_BODY_LIMIT_BYTES} bytes`, async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      ...put(KEY, undefined, { ...headers, "content-type": "application/json" }),
      payload: JSON.stringify({
        ...snapshotBody(),
        pad: "x".repeat(DEVICE_SNAPSHOT_BODY_LIMIT_BYTES),
      }),
    });
    expect(res.statusCode).toBe(413);
    expect(m.ingest).not.toHaveBeenCalled();
  });

  it("answers 409 when the rows would pass a row cap, in its own words (not the calendar-count ones)", async () => {
    const { DEVICE_ROW_CAP_ERROR, DEVICE_SOURCE_CAP_ERROR } = await import(
      "../routes/device-calendar.js"
    );
    m.ingest.mockResolvedValue({ kind: "over-row-cap" });
    const { app, headers } = await buildApp();
    const res = await app.inject(put(KEY, snapshotBody(), headers));
    expect(res.statusCode).toBe(409);
    // A machine code beside the words: the Mac app picks its own localised text by it.
    expect(res.json()).toEqual({ error: DEVICE_ROW_CAP_ERROR, code: "device_row_cap" });
    expect(DEVICE_ROW_CAP_ERROR).not.toBe(DEVICE_SOURCE_CAP_ERROR);
    expect(DEVICE_ROW_CAP_ERROR).toBe("Too many events are stored from device calendars.");

    m.ingest.mockResolvedValue({ kind: "over-cap" });
    const capped = await app.inject(put(KEY, snapshotBody(), headers));
    expect(capped.json()).toEqual({ error: DEVICE_SOURCE_CAP_ERROR, code: "device_source_cap" });
  });

  it("answers 200 with stale: true for a snapshot older than the one applied, changing nothing", async () => {
    m.ingest.mockResolvedValue({ kind: "stale" });
    const { app, headers } = await buildApp();
    const res = await app.inject(put(KEY, snapshotBody(), headers));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stale: true, created: 0, updated: 0, removed: 0 });
  });

  it("refuses a snapshot without its snapshot time", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject(put(KEY, snapshotBody({ snapshotAt: undefined }), headers));
    expect(res.statusCode).toBe(400);
    expect(m.ingest).not.toHaveBeenCalled();
  });

  it("answers 409 for a new calendar past the per-user cap", async () => {
    m.ingest.mockResolvedValue({ kind: "over-cap" });
    const { app, headers } = await buildApp();
    const res = await app.inject(put(KEY, snapshotBody(), headers));
    expect(res.statusCode).toBe(409);
  });

  it("drops an unknown field instead of storing it", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject(put(KEY, snapshotBody({ description: "secret notes" }), headers));
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(m.ingest.mock.calls[0]?.[2])).not.toContain("secret notes");
  });
});

describe("GET /sources and DELETE /sources/:key", () => {
  it("lists the user's device calendars", async () => {
    m.list.mockResolvedValue([
      { key: KEY, title: "Work", uploadedAt: new Date("2026-10-02T02:00:00.000Z") },
    ]);
    const { app, headers } = await buildApp();
    const res = await app.inject({ method: "GET", url: `${PREFIX}/sources`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sources: [{ key: KEY, title: "Work", uploadedAt: "2026-10-02T02:00:00.000Z" }],
    });
    expect(m.list).toHaveBeenCalledWith("user-1");
  });

  it("removes one calendar of the token's user (the device turned it off)", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `${PREFIX}/sources/${KEY}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(m.remove).toHaveBeenCalledWith("user-1", KEY);
  });

  it("answers 404 for a calendar the user does not have", async () => {
    m.remove.mockResolvedValue(false);
    const { app, headers } = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `${PREFIX}/sources/${KEY}`, headers });
    expect(res.statusCode).toBe(404);
  });

  it("refuses a malformed key on DELETE", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `${PREFIX}/sources/not-a-key`, headers });
    expect(res.statusCode).toBe(400);
    expect(m.remove).not.toHaveBeenCalled();
  });
});

describe("rate limits", () => {
  it("limits one device session, and the user across devices", async () => {
    const { DEVICE_CALENDAR_DEVICE_LIMIT, DEVICE_CALENDAR_USER_LIMIT } = await import(
      "../routes/device-calendar.js"
    );
    const { app, headers, otherDevice, thirdDevice } = await buildApp({ withRateLimit: true });
    const get = (h: Record<string, string>) =>
      app.inject({ method: "GET", url: `${PREFIX}/sources`, headers: h });

    for (let i = 0; i < DEVICE_CALENDAR_DEVICE_LIMIT.max; i++) {
      expect((await get(headers)).statusCode).toBe(200);
    }
    // This device is out; another device of the same user is not.
    expect((await get(headers)).statusCode).toBe(429);
    const remaining = DEVICE_CALENDAR_USER_LIMIT.max - DEVICE_CALENDAR_DEVICE_LIMIT.max;
    for (let i = 0; i < remaining; i++) {
      expect((await get(i % 2 === 0 ? otherDevice : thirdDevice)).statusCode).toBe(200);
    }
    // The user is out on every device.
    expect((await get(thirdDevice)).statusCode).toBe(429);
    expect((await get(otherDevice)).statusCode).toBe(429);
  });
});

describe("the Pro gate runs before the body is read", () => {
  it("a signed-in user without Pro gets 403 for an upload, even an oversized one", async () => {
    const savedPaywall = process.env.PAYWALL_ENABLED;
    process.env.PAYWALL_ENABLED = "true";
    try {
      const { prisma } = await import("../db.js");
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: "user-1",
        plan: "FREE",
        role: "USER",
      } as never);
      const { app, headers } = await buildApp();
      const res = await app.inject({
        ...put(KEY, undefined, { ...headers, "content-type": "application/json" }),
        payload: JSON.stringify({
          ...snapshotBody(),
          pad: "x".repeat(DEVICE_SNAPSHOT_BODY_LIMIT_BYTES),
        }),
      });
      expect(res.statusCode).toBe(403);
      expect(m.ingest).not.toHaveBeenCalled();
      // Listing and removing stay open to a downgraded user.
      expect(
        (await app.inject({ method: "GET", url: `${PREFIX}/sources`, headers })).statusCode,
      ).toBe(200);
    } finally {
      if (savedPaywall === undefined) delete process.env.PAYWALL_ENABLED;
      else process.env.PAYWALL_ENABLED = savedPaywall;
    }
  });
});

describe("the device-session limiter key", () => {
  it("is a hash of the bearer token, never the token, and without one the unspoofable address", async () => {
    const { deviceSessionKey } = await import("../routes/device-calendar.js");
    const withToken = deviceSessionKey({
      headers: { authorization: "Bearer secret-token" },
    } as never);
    expect(withToken).toMatch(/^device-cal:session:[a-f0-9]{32}$/);
    expect(withToken).not.toContain("secret-token");
    const viaCloudflare = deviceSessionKey({
      headers: { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" },
      socket: { remoteAddress: "10.0.0.1" },
      ip: "198.51.100.1",
    } as never);
    expect(viaCloudflare).toBe("device-cal:ip:203.0.113.9");
    const direct = deviceSessionKey({
      headers: { "x-forwarded-for": "198.51.100.1" },
      socket: { remoteAddress: "10.0.0.1" },
      ip: "198.51.100.1",
    } as never);
    expect(direct).toBe("device-cal:ip:10.0.0.1");
  });
});
