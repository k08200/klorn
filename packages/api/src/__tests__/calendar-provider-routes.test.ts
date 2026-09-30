/**
 * C1 dual-write on the calendar routes: every CalendarEvent this router
 * creates or upserts carries provider/externalId next to googleId, a client
 * can never choose them, and reads/lookups are still by googleId and id.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { isGoogleAuthError, markGoogleTokenForReconnect } from "../mail/gmail.js";

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

describe("POST /api/calendar/sync — Google request and failure handling (characterisation, C2)", () => {
  const SYNC_NOW = new Date("2026-09-30T05:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SYNC_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks Google for the next 30 days of the primary calendar, capped at 100, in the user's zone", async () => {
    eventsList.mockResolvedValue({ data: { items: [] } });
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/api/calendar/sync", headers });
    expect(eventsList).toHaveBeenCalledTimes(1);
    expect(eventsList).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: "2026-09-30T05:00:00.000Z",
      timeMax: "2026-10-30T05:00:00.000Z",
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 100,
      timeZone: "Asia/Seoul",
    });
    await app.close();
  });

  it("answers not-connected without a user lookup or a Google call", async () => {
    getAuthedClient.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/calendar/sync", headers });
    expect(res.json()).toEqual({ error: "Google not connected", synced: 0 });
    expect(eventsList).not.toHaveBeenCalled();
    await app.close();
  });

  it("flags the token for reconnect on an auth failure", async () => {
    vi.mocked(isGoogleAuthError).mockReturnValueOnce(true);
    eventsList.mockRejectedValue({ response: { status: 401 } });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/calendar/sync", headers });
    expect(res.json()).toEqual({
      error: "Google not connected. Please reconnect your Google account.",
      synced: 0,
    });
    expect(markGoogleTokenForReconnect).toHaveBeenCalledWith("user-1");
    await app.close();
  });

  it("reports any other failure with its status and message", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    eventsList.mockRejectedValue({
      response: { status: 500, data: { error: { message: "backend down" } } },
    });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/calendar/sync", headers });
    expect(res.json()).toEqual({ error: "Sync failed (500): backend down", synced: 0 });
    errSpy.mockRestore();
    await app.close();
  });

  it("maps meeting links, all-day events and naive times exactly as the scheduler does", async () => {
    eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "g-a",
            summary: "Timed",
            description: "d",
            location: "L",
            start: { dateTime: "2026-10-02T09:00:00" },
            end: { dateTime: "2026-10-02T10:00:00" },
            conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet/x" }] },
          },
          {
            id: "g-b",
            start: { date: "2026-10-03" },
            end: { date: "2026-10-04" },
            hangoutLink: "https://hangouts/y",
          },
        ],
      },
    });
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/api/calendar/sync", headers });
    const creates = eventUpsert.mock.calls.map(
      (c) => (c[0] as { create: Record<string, unknown> }).create,
    );
    expect(creates[0]).toMatchObject({
      googleId: "g-a",
      title: "Timed",
      description: "d",
      location: "L",
      meetingLink: "https://meet/x",
      allDay: false,
      startTime: new Date("2026-10-02T00:00:00.000Z"),
      endTime: new Date("2026-10-02T01:00:00.000Z"),
    });
    expect(creates[1]).toMatchObject({
      googleId: "g-b",
      title: "Untitled",
      description: null,
      location: null,
      meetingLink: "https://hangouts/y",
      allDay: true,
      startTime: new Date("2026-10-03"),
      endTime: new Date("2026-10-04"),
    });
    await app.close();
  });
});

describe("linked calendar rows on the read routes (C2)", () => {
  const start = new Date("2026-10-01T10:00:00.000Z");
  const row = (id: string, externalId: string | null, sourceAccountId: string | null) => ({
    id,
    userId: "user-1",
    title: `event ${id}`,
    startTime: start,
    endTime: new Date(start.getTime() + 3_600_000),
    allDay: false,
    provider: externalId === null ? "LOCAL" : "GOOGLE",
    externalId,
    sourceAccountId,
    sourceKey: sourceAccountId ?? "primary",
  });

  it("GET / shows an invite that is in the primary and a linked calendar once, as the primary row", async () => {
    eventFindMany.mockResolvedValueOnce([
      row("linked", "g-inv", "acct-1"),
      row("primary", "g-inv", null),
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/calendar?start=2026-10-01T00:00:00.000Z&end=2026-10-08T00:00:00.000Z",
      headers,
    });
    const events = res.json().events as Array<{ id: string }>;
    expect(events.map((e) => e.id)).toEqual(["primary"]);
    await app.close();
  });

  it("GET / still shows a linked-only event and every LOCAL event", async () => {
    eventFindMany.mockResolvedValueOnce([
      row("linked-only", "g-work", "acct-1"),
      row("local-a", null, null),
      row("local-b", null, null),
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/calendar", headers });
    const events = res.json().events as Array<{ id: string }>;
    expect(events.map((e) => e.id)).toEqual(["linked-only", "local-a", "local-b"]);
    await app.close();
  });

  it("GET /today/summary counts the duplicated invite once", async () => {
    const future = (id: string, externalId: string, sourceAccountId: string | null) => ({
      ...row(id, externalId, sourceAccountId),
      startTime: new Date(Date.now() + 60_000),
      endTime: new Date(Date.now() + 3_600_000),
    });
    eventFindMany.mockResolvedValueOnce([
      future("p", "g-inv", null),
      future("l", "g-inv", "acct-1"),
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/calendar/today/summary", headers });
    expect(res.json().total).toBe(1);
    expect(res.json().nextEvent.id).toBe("p");
    await app.close();
  });
});

describe("linked calendar rows are read-only mirrors (C2)", () => {
  const linkedRow = {
    id: "ev-linked",
    userId: "user-1",
    title: "Work standup",
    startTime: new Date("2026-10-01T10:00:00.000Z"),
    endTime: new Date("2026-10-01T11:00:00.000Z"),
    allDay: false,
    googleId: null,
    provider: "GOOGLE",
    externalId: "g-work-1",
    sourceAccountId: "acct-1",
    sourceKey: "acct-1",
  };
  const READ_ONLY = {
    error: "This event comes from a linked calendar and is read-only in Klorn.",
  };

  it("PATCH refuses with 409: the next sync would silently revert the edit", async () => {
    eventFindUnique.mockResolvedValue(linkedRow);
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/calendar/ev-linked",
      headers,
      payload: { title: "Renamed" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(READ_ONLY);
    expect(eventUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it("DELETE refuses with 409: the next sync would bring the event back", async () => {
    eventFindUnique.mockResolvedValue(linkedRow);
    const eventDelete = vi.fn();
    const { prisma } = await import("../db.js");
    (prisma.calendarEvent as unknown as { delete: unknown }).delete = eventDelete;
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/calendar/ev-linked", headers });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(READ_ONLY);
    expect(eventDelete).not.toHaveBeenCalled();
    await app.close();
  });

  it("a primary row is still editable (no regression)", async () => {
    const primaryRow = {
      ...linkedRow,
      id: "ev-primary",
      sourceAccountId: null,
      sourceKey: "primary",
    };
    eventFindUnique.mockResolvedValue(primaryRow);
    eventUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...primaryRow,
      ...data,
    }));
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/calendar/ev-primary",
      headers,
      payload: { title: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(eventUpdate).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
