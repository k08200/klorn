/**
 * C1 dual-write on the calendar routes: every CalendarEvent this router
 * creates or upserts carries provider/externalId next to googleId, a client
 * can never choose them, and reads/lookups are still by googleId and id.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const googleCreateEvent = vi.hoisted(() => vi.fn());
const getAuthedClient = vi.hoisted(() => vi.fn());
const eventsList = vi.hoisted(() => vi.fn());

vi.mock("../mail/email.js", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthedClient,
  isGoogleAuthError: vi.fn(() => false),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
}));
vi.mock("../pim/calendar.js", () => ({
  createEvent: googleCreateEvent,
  updateEvent: vi.fn(async () => ({ success: true })),
  deleteEvent: vi.fn(async () => {}),
}));
vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForCalendarEvent: vi.fn(async () => {}),
  deleteAttentionForCalendarEvents: vi.fn(async () => {}),
}));
vi.mock("googleapis", () => ({
  google: { calendar: () => ({ events: { list: eventsList } }) },
}));

const eventCreate = vi.hoisted(() => vi.fn());
const eventUpsert = vi.hoisted(() => vi.fn(async () => ({})));
const eventFindMany = vi.hoisted(() => vi.fn(async () => []));
const eventFindUnique = vi.hoisted(() => vi.fn());
const eventUpdate = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = {
    calendarEvent: {
      findMany: eventFindMany,
      findUnique: eventFindUnique,
      create: eventCreate,
      update: eventUpdate,
      upsert: eventUpsert,
    },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const headers = { authorization: `Bearer ${TOKEN}` };
const BODY = {
  title: "Design review",
  startTime: "2026-10-01T10:00:00.000Z",
  endTime: "2026-10-01T11:00:00.000Z",
};

async function buildApp() {
  const { calendarRoutes } = await import("../routes/calendar.js");
  const app = Fastify();
  await app.register(calendarRoutes, { prefix: "/api/calendar" });
  return app;
}

function lastCreateData(): Record<string, unknown> {
  const arg = eventCreate.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
  return arg.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  eventCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "ev-1",
    ...data,
  }));
  googleCreateEvent.mockResolvedValue({ eventId: null });
  getAuthedClient.mockResolvedValue({});
});

describe("POST /api/calendar — manual create", () => {
  it("writes GOOGLE with externalId = the Google id when the Google insert succeeded", async () => {
    googleCreateEvent.mockResolvedValue({ eventId: "g-abc" });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/calendar", headers, payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(lastCreateData()).toMatchObject({
      googleId: "g-abc",
      provider: "GOOGLE",
      externalId: "g-abc",
      sourceAccountId: null,
    });
    await app.close();
  });

  it("writes LOCAL with no externalId when Google returned no id", async () => {
    googleCreateEvent.mockResolvedValue({ eventId: null });
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/api/calendar", headers, payload: BODY });
    expect(lastCreateData()).toMatchObject({
      googleId: null,
      provider: "LOCAL",
      externalId: null,
      sourceAccountId: null,
    });
    await app.close();
  });

  it("writes LOCAL when the Google insert throws (the local row still lands)", async () => {
    googleCreateEvent.mockRejectedValue(new Error("quota"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/calendar", headers, payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(lastCreateData()).toMatchObject({ provider: "LOCAL", externalId: null });
    errSpy.mockRestore();
    await app.close();
  });

  it("ignores provider/externalId/sourceAccountId/googleId sent by the client", async () => {
    googleCreateEvent.mockResolvedValue({ eventId: null });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/calendar",
      headers,
      payload: {
        ...BODY,
        provider: "ICLOUD",
        externalId: "forged",
        sourceAccountId: "someone-elses-account",
        googleId: "forged-google-id",
      },
    });
    expect(lastCreateData()).toMatchObject({
      googleId: null,
      provider: "LOCAL",
      externalId: null,
      sourceAccountId: null,
    });
    await app.close();
  });
});

describe("PATCH /api/calendar/:id", () => {
  it("cannot rewrite provider/externalId/sourceAccountId/googleId", async () => {
    const existing = {
      id: "ev-1",
      userId: "user-1",
      title: "Old",
      startTime: new Date("2026-10-01T10:00:00.000Z"),
      endTime: new Date("2026-10-01T11:00:00.000Z"),
      allDay: false,
      googleId: null,
      provider: "LOCAL",
      externalId: null,
    };
    eventFindUnique.mockResolvedValue(existing);
    eventUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...existing,
      ...data,
    }));
    const app = await buildApp();
    await app.inject({
      method: "PATCH",
      url: "/api/calendar/ev-1",
      headers,
      payload: {
        title: "Renamed",
        provider: "GOOGLE",
        externalId: "forged",
        sourceAccountId: "x",
        googleId: "forged",
      },
    });
    const data = (eventUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data).toEqual({ title: "Renamed" });
    await app.close();
  });
});

describe("GET /api/calendar — reads are unchanged", () => {
  it("lists by user and time range only, with no provider/externalId filter", async () => {
    const app = await buildApp();
    await app.inject({
      method: "GET",
      url: "/api/calendar?start=2026-10-01T00:00:00.000Z&end=2026-10-08T00:00:00.000Z",
      headers,
    });
    const arg = eventFindMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(Object.keys(arg.where).sort()).toEqual(["startTime", "userId"]);
    await app.close();
  });
});

describe("POST /api/calendar/sync — Google sync upsert", () => {
  const item = {
    id: "g-sync-1",
    summary: "Planning",
    start: { dateTime: "2026-10-02T09:00:00+09:00" },
    end: { dateTime: "2026-10-02T10:00:00+09:00" },
  };

  it("upserts by (userId, googleId) and dual-writes provider/externalId on create and update", async () => {
    eventsList.mockResolvedValue({ data: { items: [item] } });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/calendar/sync", headers });
    expect(res.json()).toMatchObject({ success: true, synced: 1 });

    const arg = eventUpsert.mock.calls[0]?.[0] as {
      where: unknown;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ userId_googleId: { userId: "user-1", googleId: "g-sync-1" } });
    expect(arg.create).toMatchObject({
      userId: "user-1",
      googleId: "g-sync-1",
      provider: "GOOGLE",
      externalId: "g-sync-1",
      sourceAccountId: null,
      title: "Planning",
    });
    expect(arg.update).toMatchObject({ provider: "GOOGLE", externalId: "g-sync-1" });
    expect(arg.update).not.toHaveProperty("googleId");
    await app.close();
  });

  it("skips items with no id or no times without writing anything", async () => {
    eventsList.mockResolvedValue({
      data: {
        items: [
          { summary: "no id", start: {}, end: {} },
          { id: "g-2", start: {}, end: {} },
        ],
      },
    });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/calendar/sync", headers });
    expect(res.json()).toMatchObject({ success: true, synced: 0 });
    expect(eventUpsert).not.toHaveBeenCalled();
    await app.close();
  });
});
