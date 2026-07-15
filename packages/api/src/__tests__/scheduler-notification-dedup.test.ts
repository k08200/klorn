import { beforeEach, describe, expect, it, vi } from "vitest";

// Three sibling scheduler notifications used to dedup via findFirst-then-create
// (TOCTOU): under concurrent ticks they could double-create + double-push. They
// now use the SAME atomic pattern as the daily briefing — a (userId, dedupeKey)
// unique on Notification plus a create-catch-P2002 winner-only push. These tests
// drive the winner/loser race paths to prove the push is WINNER-ONLY.
const state = vi.hoisted(() => ({
  notificationCreateP2002: false,
  pushCalls: 0,
  webPushCalls: 0,
}));

class MockPrismaError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

vi.mock("../db.js", () => ({
  prisma: {
    notification: {
      create: vi.fn(() => {
        if (state.notificationCreateP2002) return Promise.reject(new MockPrismaError("P2002"));
        return Promise.resolve({ id: "notif-new", createdAt: new Date() });
      }),
    },
  },
}));

vi.mock("../notify/push.js", () => ({
  sendPushNotification: vi.fn(() => {
    state.webPushCalls++;
    return Promise.resolve();
  }),
}));
vi.mock("../websocket.js", () => ({
  pushNotification: vi.fn(() => {
    state.pushCalls++;
  }),
}));

import {
  ensureAutoReplyNotification,
  ensureCalendarDisconnectNotification,
  ensureUrgentEmailNotification,
} from "../automation-scheduler.js";
import { sendPushNotification } from "../notify/push.js";

const USER = "user-1";
const DAY_KEY = "2026-07-01";
const GMAIL_ID = "abc123";

beforeEach(() => {
  state.notificationCreateP2002 = false;
  state.pushCalls = 0;
  state.webPushCalls = 0;
  vi.clearAllMocks();
});

describe("ensureCalendarDisconnectNotification — winner-only atomic push", () => {
  it("winner: creates the alert AND pushes once with dedupeKey calendar-disconnect:<dayKey>", async () => {
    const { prisma } = await import("../db.js");
    const result = await ensureCalendarDisconnectNotification(USER, DAY_KEY);
    expect(result).not.toBeNull();
    expect(state.pushCalls).toBe(1);
    expect(vi.mocked(prisma.notification.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupeKey: `calendar-disconnect:${DAY_KEY}`,
          type: "calendar",
        }),
      }),
    );
  });

  it("loser (P2002): returns null and does NOT push — no duplicate alert", async () => {
    state.notificationCreateP2002 = true;
    const result = await ensureCalendarDisconnectNotification(USER, DAY_KEY);
    expect(result).toBeNull();
    expect(state.pushCalls).toBe(0);
  });
});

describe("ensureAutoReplyNotification — winner-only atomic push", () => {
  it("winner: creates + pushes once with dedupeKey auto-reply:<gmailId>", async () => {
    const { prisma } = await import("../db.js");
    const result = await ensureAutoReplyNotification(USER, GMAIL_ID, "to@example.com", "My Rule");
    expect(result).not.toBeNull();
    expect(state.pushCalls).toBe(1);
    expect(vi.mocked(prisma.notification.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupeKey: `auto-reply:${GMAIL_ID}`,
          type: "email",
          title: "Auto-reply sent",
        }),
      }),
    );
  });

  it("loser (P2002): returns null and does NOT push — no duplicate auto-reply alert", async () => {
    state.notificationCreateP2002 = true;
    const result = await ensureAutoReplyNotification(USER, GMAIL_ID, "to@example.com", "My Rule");
    expect(result).toBeNull();
    expect(state.pushCalls).toBe(0);
  });
});

describe("ensureUrgentEmailNotification — winner-only atomic push", () => {
  it("winner: creates + pushes once with dedupeKey urgent:<leadGmailId>", async () => {
    const { prisma } = await import("../db.js");
    const result = await ensureUrgentEmailNotification(
      USER,
      GMAIL_ID,
      `body [${GMAIL_ID}]`,
      "body",
    );
    expect(result).not.toBeNull();
    expect(state.pushCalls).toBe(1);
    expect(vi.mocked(prisma.notification.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupeKey: `urgent:${GMAIL_ID}`,
          type: "email",
          title: "Urgent email",
          // Preserve the notifiedGmailIds accumulation marker in message.
          message: `body [${GMAIL_ID}]`,
        }),
      }),
    );
  });

  it("loser (P2002): returns null and does NOT push — no duplicate urgent alert", async () => {
    state.notificationCreateP2002 = true;
    const result = await ensureUrgentEmailNotification(
      USER,
      GMAIL_ID,
      `body [${GMAIL_ID}]`,
      "body",
    );
    expect(result).toBeNull();
    expect(state.pushCalls).toBe(0);
    // The follow-on web-push / SMS side-effects are the caller's responsibility
    // and are gated on this non-null return, so a loser triggers no web-push.
    expect(vi.mocked(sendPushNotification)).not.toHaveBeenCalled();
  });
});
