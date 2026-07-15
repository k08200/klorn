import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

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
  deleteEvent: vi.fn(async () => {}),
}));

const parseEventText = vi.fn(
  async (): Promise<Record<string, unknown> | null> => ({
    title: "김대표 미팅",
    startTime: "2026-07-07T15:00:00+09:00",
    endTime: "2026-07-07T16:00:00+09:00",
  }),
);
vi.mock("../event-parse.js", () => ({
  parseEventText: (...args: unknown[]) => parseEventText(...args),
}));

type Ev = {
  id: string;
  userId: string;
  title: string;
  startTime: Date;
  endTime: Date;
  googleId: string | null;
  [k: string]: unknown;
};
const store = new Map<string, Ev>();
let nextId = 1;

vi.mock("../db.js", () => {
  const prisma = {
    calendarEvent: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const r: Ev[] = [];
        for (const e of store.values()) if (e.userId === where.userId) r.push(e);
        return r;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `ev-${nextId++}`;
        const ev = { id, ...data } as Ev;
        store.set(id, ev);
        return ev;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const ev = store.get(where.id);
          if (!ev) throw new Error("Not found");
          const u = { ...ev, ...data };
          store.set(where.id, u as Ev);
          return u;
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

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const OTHER = signToken({ userId: "user-2", email: "o@e.com" });
const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` });

async function buildApp() {
  const { calendarRoutes } = await import("../routes/calendar.js");
  const app = Fastify();
  await app.register(calendarRoutes, { prefix: "/api/calendar" });
  return app;
}

describe("calendar routes", () => {
  beforeEach(() => {
    store.clear();
    nextId = 1;
  });

  it("rejects unauthenticated with 401", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/calendar" })).statusCode).toBe(401);
    await app.close();
  });

  it("creates and lists events", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/calendar",
      headers: auth(),
      payload: {
        title: "Meeting",
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    expect(c.statusCode).toBe(200);
    expect(c.json().title).toBe("Meeting");

    const list = await app.inject({ method: "GET", url: "/api/calendar", headers: auth() });
    expect(list.json().events).toHaveLength(1);
    await app.close();
  });

  it("gets single event", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/calendar",
      headers: auth(),
      payload: {
        title: "Ev",
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/calendar/${c.json().id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("returns 403 for other user's event", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/calendar",
      headers: auth(),
      payload: {
        title: "Mine",
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/calendar/${c.json().id}`,
      headers: auth(OTHER),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("updates own event", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/calendar",
      headers: auth(),
      payload: {
        title: "Old",
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/calendar/${c.json().id}`,
      headers: auth(),
      payload: { description: "Updated" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("deletes own event", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/calendar",
      headers: auth(),
      payload: {
        title: "Del",
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/calendar/${c.json().id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("returns 403 when deleting other user's event", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/calendar",
      headers: auth(),
      payload: {
        title: "Mine",
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/calendar/${c.json().id}`,
      headers: auth(OTHER),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("POST /api/calendar/parse-event", () => {
  it("rejects missing or blank text with 400", async () => {
    const app = await buildApp();
    for (const payload of [{}, { text: "" }, { text: "   " }]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/calendar/parse-event",
        headers: auth(),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("rejects oversized text with 400", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/parse-event",
      headers: auth(),
      payload: { text: "x".repeat(501) },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns the parsed draft for the caller", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/parse-event",
      headers: auth(),
      payload: { text: "내일 3시 김대표 미팅" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      event: {
        title: "김대표 미팅",
        startTime: "2026-07-07T15:00:00+09:00",
        endTime: "2026-07-07T16:00:00+09:00",
      },
    });
    expect(parseEventText).toHaveBeenCalledWith("user-1", "내일 3시 김대표 미팅");
    await app.close();
  });

  it("returns event: null when nothing is extractable", async () => {
    parseEventText.mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/parse-event",
      headers: auth(),
      payload: { text: "으으음" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ event: null });
    await app.close();
  });

  it("answers 502 when the parser transport fails", async () => {
    parseEventText.mockRejectedValueOnce(new Error("provider down"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/parse-event",
      headers: auth(),
      payload: { text: "내일 미팅" },
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});
