/**
 * Notification center routes (NC1): GET /api/notifications rows carry the
 * optional lane / reason / held / group (additive, fail-soft) and the list
 * carries `budget` only where the interrupt budget applies;
 * GET /api/notifications/:id/delivery is owner-scoped (404 otherwise).
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import type { NotificationDTO } from "../background.js";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

process.env.PUSH_ALLOWED_ORIGINS = "https://app.klorn.ai";

const dbHolder = vi.hoisted(() => ({ current: null as unknown, failItems: false }));
const listRows = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const base = fakePrismaClient(() => dbHolder.current as FakeDb);
  const prisma = new Proxy(base, {
    get(target, model, receiver) {
      const delegate = Reflect.get(target, model, receiver);
      if (model !== "attentionItem") return delegate;
      return {
        ...delegate,
        findMany: async (args: unknown) => {
          if (dbHolder.failItems) throw new Error("connection reset");
          return (delegate as { findMany: (a: unknown) => unknown }).findMany(args);
        },
      };
    },
  });
  return { prisma, db: prisma };
});
vi.mock("../auth.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../auth.js")>();
  return {
    ...real,
    // Session validity is auth.ts's own concern (tested there); here a valid
    // signed token is the caller.
    requireAuth: vi.fn(async (request: never, reply: never) => {
      const header = (request as { headers: { authorization?: string } }).headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        return (reply as { code: (n: number) => { send: (b: unknown) => unknown } })
          .code(401)
          .send({ error: "Authentication required" });
      }
      (request as unknown as { userId: string }).userId = real.verifyToken(header.slice(7)).userId;
    }),
  };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../mail/email.js", () => ({ sendVerificationEmail: vi.fn() }));
vi.mock("../mail/gmail.js", () => ({ getAuthedClient: vi.fn() }));
vi.mock("../background.js", () => ({
  getNotifications: vi.fn(async () => listRows.current),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  clearNotifications: vi.fn(),
}));
vi.mock("../notify/push.js", () => ({
  getVapidPublicKey: vi.fn(() => "k"),
  sendPushNotification: vi.fn(),
}));
vi.mock("../notify/push-device.js", () => ({ sendDevicePush: vi.fn() }));
vi.mock("../notify/push-later.js", () => ({ remindLaterFromPush: vi.fn() }));

const USER = "user-1";
const OTHER = "user-2";
const N1 = "11111111-1111-4111-8111-111111111111";
const N2 = "22222222-2222-4222-8222-222222222222";
const HOUR = 3_600_000;
const NOW = new Date("2026-11-14T01:00:00.000Z");

const auth = (userId = USER) => ({
  authorization: `Bearer ${signToken({ userId, email: `${userId}@e.com` })}`,
});

function bell(id: string, overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id,
    type: "email",
    title: "Urgent email",
    message: "Alice: Contract [g]",
    isRead: false,
    link: null,
    conversationId: null,
    sourceEmailId: "e1",
    pendingActionId: null,
    pendingActionStatus: null,
    createdAt: new Date(NOW.getTime() - HOUR).toISOString(),
    ...overrides,
  };
}

function seed(extra: Partial<Record<string, Row[]>> = {}) {
  const db = createFakeDb({
    automationConfig: [{ id: "cfg", userId: USER, timezone: "Asia/Seoul" }],
    emailMessage: [
      {
        id: "e1",
        userId: USER,
        gmailId: "g",
        from: "Alice <a@x.io>",
        to: "me@x.io",
        subject: "Contract",
        receivedAt: new Date(NOW.getTime() - HOUR),
      },
    ],
    attentionItem: [
      {
        id: "i1",
        userId: USER,
        source: "EMAIL",
        sourceId: "e1",
        type: "REPLY_NEEDED",
        title: "Contract",
        tier: "PUSH",
        tierReason: "email.heldByInterruptBudget",
        status: "OPEN",
      },
    ],
    notification: [
      {
        id: N1,
        userId: USER,
        type: "email",
        title: "t",
        message: "m",
        sourceEmailId: "e1",
        createdAt: new Date(NOW.getTime() - HOUR),
      },
    ],
    pushDeliveryLog: [],
    ...extra,
  });
  dbHolder.current = db;
  return db;
}

async function buildApp() {
  const { notificationRoutes } = await import("../routes/notifications.js");
  const app = Fastify();
  await app.register(notificationRoutes, { prefix: "/api/notifications" });
  return app;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  dbHolder.failItems = false;
  listRows.current = [bell(N1)];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.JUDGE_V3_POLICY;
  delete process.env.JUDGE_V3_SHADOW;
  delete process.env.JUDGE_V3_PUSH_BUDGET;
});

describe("GET /api/notifications — notification center fields", () => {
  it("401 without a session", async () => {
    seed();
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).statusCode).toBe(401);
    await app.close();
  });

  it("adds lane / reason / held / group, keeps every existing field, renders reasons in ?lang", async () => {
    seed();
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications?lang=ko",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.unread).toBe(1);
    expect(body.notifications[0]).toEqual({
      ...bell(N1),
      lane: "PUSH",
      reason: { text: "보류: 오늘 알림 한도에 도달해 알림을 보내지 않았어요", verified: false },
      held: false,
      group: "now",
    });
    expect(body).not.toHaveProperty("budget");
    await app.close();
  });

  it("never emits a retired lane: AUTO reads as QUEUE", async () => {
    const db = seed();
    (db.tables.attentionItem?.[0] as Row).tier = "AUTO";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/notifications", headers: auth() });
    expect(res.json().notifications[0].lane).toBe("QUEUE");
    await app.close();
  });

  it("a failed enrichment read still returns the list, as before", async () => {
    seed();
    dbHolder.failItems = true;
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/notifications", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().notifications).toEqual([bell(N1)]);
    await app.close();
  });

  it("another user's caller enriches nothing from this user's mail", async () => {
    seed();
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications",
      headers: auth(OTHER),
    });
    const [row] = res.json().notifications;
    expect(row).not.toHaveProperty("lane");
    expect(row).not.toHaveProperty("reason");
    await app.close();
  });
});

describe("GET /api/notifications — budget", () => {
  function seedSlots(used: number) {
    const slots: Row[] = Array.from({ length: used }, (_, i) => ({
      id: `slot-${i}`,
      userId: USER,
      type: "claim",
      title: "t",
      message: "m",
      dedupeKey: `interrupt:2026-11-14:${i + 1}`,
      createdAt: NOW,
    }));
    const db = seed();
    db.tables.notification = [...(db.tables.notification ?? []), ...slots];
  }

  it("present under policy v3 with a finite budget: used / limit", async () => {
    process.env.JUDGE_V3_POLICY = "true";
    process.env.JUDGE_V3_SHADOW = "true";
    seedSlots(2);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/notifications", headers: auth() });
    expect(res.json().budget).toEqual({ used: 2, limit: 5 });
    await app.close();
  });

  it("omitted when the budget is unlimited", async () => {
    process.env.JUDGE_V3_POLICY = "true";
    process.env.JUDGE_V3_SHADOW = "true";
    process.env.JUDGE_V3_PUSH_BUDGET = "unlimited";
    seedSlots(1);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/notifications", headers: auth() });
    expect(res.json()).not.toHaveProperty("budget");
    await app.close();
  });

  it("omitted outside policy v3", async () => {
    seedSlots(1);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/notifications", headers: auth() });
    expect(res.json()).not.toHaveProperty("budget");
    await app.close();
  });
});

describe("GET /api/notifications/:id/delivery", () => {
  function seedDelivery() {
    seed({
      pushDeliveryLog: [
        {
          userId: USER,
          channel: "apns",
          bellNotificationId: N1,
          category: "email_urgent",
          title: "Alice",
          status: "ACCEPTED",
          acceptedAt: NOW,
          createdAt: NOW,
        },
      ],
    });
  }

  it("401 without a session", async () => {
    seedDelivery();
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/notifications/${N1}/delivery` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("the owner gets deliveredTo as string[]", async () => {
    seedDelivery();
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/notifications/${N1}/delivery`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      deliveredTo: ["ios"],
      channels: [{ name: "ios", state: "sent" }],
    });
    await app.close();
  });

  it("IDOR: another user's row is 404, indistinguishable from a missing one", async () => {
    seedDelivery();
    const app = await buildApp();
    const foreign = await app.inject({
      method: "GET",
      url: `/api/notifications/${N1}/delivery`,
      headers: auth(OTHER),
    });
    const missing = await app.inject({
      method: "GET",
      url: `/api/notifications/${N2}/delivery`,
      headers: auth(OTHER),
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("400 for an id that is not a uuid, before any read", async () => {
    seedDelivery();
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications/not-a-uuid/delivery",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
