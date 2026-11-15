/**
 * The calendar routes' Google catches report facts, never the provider's words.
 *
 * A googleapis error carries the API's message (which can name the attendee or
 * echo the event) plus the request it sent (`config.data`: the title,
 * description, attendees) and the response body; Node's console prints every
 * own property and Sentry sends the message. Each route below keeps its
 * response; only what reaches the console and Sentry changes.
 */
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { callText } from "./helpers/canary.js";
import { DB_CANARY } from "./helpers/prisma-canary.js";

vi.mock("../sentry.js", () => ({ captureError: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock("../mail/email.js", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(async () => null),
  isGoogleAuthError: vi.fn(() => false),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
}));
vi.mock("../pim/calendar.js", () => ({
  createEvent: vi.fn(async () => ({ eventId: null })),
  updateEvent: vi.fn(async () => ({ success: true })),
  deleteEvent: vi.fn(async () => {}),
}));
vi.mock("../pim/calendar-providers/dispatch.js", () => ({
  connectPrimaryCalendar: vi.fn(async () => ({ provider: "google" })),
}));
vi.mock("../pim/calendar-sync.js", () => ({
  readSyncTimezone: vi.fn(async () => "UTC"),
  syncPrimaryCalendarWindow: vi.fn(async () => 0),
}));
vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForCalendarEvent: vi.fn(async () => undefined),
  deleteAttentionForCalendarEvents: vi.fn(async () => undefined),
}));

type Ev = { id: string; userId: string; googleId: string | null; [k: string]: unknown };
const store = new Map<string, Ev>();
let nextId = 1;

vi.mock("../db.js", () => {
  const prisma = {
    calendarEvent: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const ev = { id: `ev-${nextId++}`, ...data } as Ev;
        store.set(ev.id, ev);
        return ev;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const ev = { ...(store.get(where.id) as Ev), ...data };
          store.set(where.id, ev);
          return ev;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => store.delete(where.id)),
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

const { captureError } = await import("../sentry.js");
const googleCalendar = await import("../pim/calendar.js");
const { syncPrimaryCalendarWindow } = await import("../pim/calendar-sync.js");

const auth = { authorization: `Bearer ${signToken({ userId: "user-1", email: "t@e.com" })}` };

/** A googleapis error as gaxios raises it: the API's words and the request it sent. */
function googleErrorQuotingEvent(): Error {
  return Object.assign(new Error(`Invalid attendee email: ${DB_CANARY}@example.com`), {
    code: 400,
    status: 400,
    config: { data: { summary: `${DB_CANARY} board meeting`, attendees: [`${DB_CANARY}@x.io`] } },
    response: {
      status: 400,
      data: {
        error: {
          message: `Invalid attendee email: ${DB_CANARY}@example.com`,
          errors: [{ reason: "invalid", message: `${DB_CANARY}@example.com` }],
        },
      },
    },
  });
}

async function buildApp() {
  const { calendarRoutes } = await import("../routes/calendar.js");
  const app = Fastify();
  await app.register(calendarRoutes, { prefix: "/api/calendar" });
  return app;
}

function seedSynced(): Ev {
  const ev: Ev = {
    id: "ev-g",
    userId: "user-1",
    title: "T",
    startTime: new Date("2026-08-01T09:00:00Z"),
    endTime: new Date("2026-08-01T10:00:00Z"),
    allDay: false,
    googleId: "goog-1",
  };
  store.set(ev.id, ev);
  return ev;
}

describe("calendar routes — a Google failure reaches the console and Sentry as facts", () => {
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    store.clear();
    nextId = 1;
    vi.mocked(captureError).mockClear();
    consoleSpies = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
  });

  const sinkText = () =>
    consoleSpies.map((spy) => callText(spy)).join("\n") + callText(vi.mocked(captureError));

  it("POST: the Google create failure still saves locally; facts only", async () => {
    vi.mocked(googleCalendar.createEvent).mockRejectedValueOnce(googleErrorQuotingEvent());
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/calendar",
      headers: auth,
      payload: {
        title: "Board",
        startTime: "2026-08-01T09:00:00Z",
        endTime: "2026-08-01T10:00:00Z",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(sinkText()).toContain("[CALENDAR] Google sync on create failed");
    expect(sinkText()).toContain("400");
    expect(sinkText()).not.toContain(DB_CANARY);
    await app.close();
  });

  it("PATCH: a thrown Google update still saves locally; facts only, scope unchanged", async () => {
    seedSynced();
    vi.mocked(googleCalendar.updateEvent).mockRejectedValueOnce(googleErrorQuotingEvent());
    const app = await buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/calendar/ev-g",
      headers: auth,
      payload: { title: "T2" },
    });

    expect(res.statusCode).toBe(200);
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { scope: "calendar.update.google-sync" },
        extra: expect.objectContaining({ userId: "user-1", googleId: "goog-1", status: 400 }),
      }),
    );
    expect(sinkText()).not.toContain(DB_CANARY);
    await app.close();
  });

  it("PATCH: an update the provider refused logs no provider words", async () => {
    seedSynced();
    vi.mocked(googleCalendar.updateEvent).mockResolvedValueOnce({
      error: `Calendar API error (400): Invalid attendee email: ${DB_CANARY}@example.com`,
    } as never);
    const app = await buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/calendar/ev-g",
      headers: auth,
      payload: { title: "T2" },
    });

    expect(res.statusCode).toBe(200);
    expect(sinkText()).toContain("[calendar] Google update failed");
    expect(sinkText()).not.toContain(DB_CANARY);
    await app.close();
  });

  it("DELETE: a Google delete failure still deletes locally; facts only, scope unchanged", async () => {
    seedSynced();
    vi.mocked(googleCalendar.deleteEvent).mockRejectedValueOnce(googleErrorQuotingEvent());
    const app = await buildApp();

    const res = await app.inject({ method: "DELETE", url: "/api/calendar/ev-g", headers: auth });

    expect(res.statusCode).toBe(204);
    expect(store.has("ev-g")).toBe(false);
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { scope: "calendar.delete.google-sync" } }),
    );
    expect(sinkText()).not.toContain(DB_CANARY);
    await app.close();
  });

  it("POST /sync: a failed sync logs facts only", async () => {
    vi.mocked(syncPrimaryCalendarWindow).mockRejectedValueOnce(googleErrorQuotingEvent());
    const app = await buildApp();

    const res = await app.inject({ method: "POST", url: "/api/calendar/sync", headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().synced).toBe(0);
    expect(sinkText()).toContain("[CALENDAR SYNC] Failed");
    expect(sinkText()).not.toContain(DB_CANARY);
    await app.close();
  });
});
