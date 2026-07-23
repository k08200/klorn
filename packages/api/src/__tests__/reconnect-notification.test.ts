import { beforeEach, describe, expect, it, vi } from "vitest";

// "Gmail disconnected" reconnect alert — the OAuth Testing-mode 7-day refresh
// token death used to be silent for any user with the app closed (the only
// signal was a websocket broadcast on the calendar sync path). These tests
// prove the new alert is WINNER-ONLY atomic (same (userId, dedupeKey) +
// create-catch-P2002 idiom as the daily briefing) and that it goes out over
// BOTH the in-app bell (websocket) and web push.
const state = vi.hoisted(() => ({
  notificationCreateP2002: false,
  wsCalls: 0,
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
        return Promise.resolve({ id: "notif-reconnect", createdAt: new Date() });
      }),
    },
  },
}));

vi.mock("../websocket.js", () => ({
  pushNotification: vi.fn(() => {
    state.wsCalls++;
  }),
}));

vi.mock("../notify/push.js", () => ({
  sendPushNotification: vi.fn(() => {
    state.webPushCalls++;
    return Promise.resolve({
      status: "sent",
      subscriptions: 1,
      attempted: 1,
      accepted: 1,
      failed: 0,
    });
  }),
}));

import { prisma } from "../db.js";
import { sendPushNotification } from "../notify/push.js";
import {
  ensureGmailReconnectNotification,
  gmailReconnectDayKey,
} from "../notify/reconnect-notification.js";
import { pushNotification } from "../websocket.js";

const USER = "user-1";
const RECONNECT_TITLE = "Gmail disconnected — 1 click to reconnect";

beforeEach(() => {
  state.notificationCreateP2002 = false;
  state.wsCalls = 0;
  state.webPushCalls = 0;
  vi.clearAllMocks();
});

describe("ensureGmailReconnectNotification — primary account", () => {
  it("winner: creates the alert with dedupeKey reconnect:google:<dayKey> and link /settings", async () => {
    const result = await ensureGmailReconnectNotification(USER);
    expect(result).not.toBeNull();
    expect(vi.mocked(prisma.notification.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER,
          type: "email",
          dedupeKey: `reconnect:google:${gmailReconnectDayKey()}`,
          title: RECONNECT_TITLE,
          link: "/settings",
        }),
      }),
    );
  });

  it("winner: sends BOTH the in-app bell broadcast and a web push pointing at /settings", async () => {
    await ensureGmailReconnectNotification(USER);
    expect(state.wsCalls).toBe(1);
    expect(state.webPushCalls).toBe(1);
    expect(vi.mocked(sendPushNotification)).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        title: RECONNECT_TITLE,
        url: "/settings",
        notificationId: "notif-reconnect",
      }),
      "system",
    );
    expect(vi.mocked(pushNotification)).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ type: "email", title: RECONNECT_TITLE, link: "/settings" }),
    );
  });

  it("loser (P2002, already alerted today): returns null and does NOT push on any channel", async () => {
    state.notificationCreateP2002 = true;
    const result = await ensureGmailReconnectNotification(USER);
    expect(result).toBeNull();
    expect(state.wsCalls).toBe(0);
    expect(state.webPushCalls).toBe(0);
  });

  it("surfaces non-P2002 create failures to the caller (never silently swallowed)", async () => {
    vi.mocked(prisma.notification.create).mockRejectedValueOnce(new MockPrismaError("P1001"));
    await expect(ensureGmailReconnectNotification(USER)).rejects.toThrow();
  });
});

describe("ensureGmailReconnectNotification — linked inbox", () => {
  it("scopes the dedupe key per linked account: reconnect:google:<accountId>:<dayKey>", async () => {
    const result = await ensureGmailReconnectNotification(USER, {
      linkedInboxAccountId: "linked-1",
    });
    expect(result).not.toBeNull();
    expect(vi.mocked(prisma.notification.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupeKey: `reconnect:google:linked-1:${gmailReconnectDayKey()}`,
        }),
      }),
    );
    expect(state.wsCalls).toBe(1);
    expect(state.webPushCalls).toBe(1);
  });
});
