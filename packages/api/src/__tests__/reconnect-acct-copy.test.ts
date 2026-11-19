import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every reconnect alert (Gmail, Outlook, the IMAP presets) under
 * NOTIFY_PUSH_PRESENTATION reads the NT0 acct copy: "<address> 연결 끊김" /
 * "다시 연결하면 이 계정 메일도 분류합니다". The address is the owner's own
 * connected account, read for the push only and shown only to its owner; it
 * is never logged. The bell row, the live frame and, flag off, the push keep
 * their text.
 */

const state = vi.hoisted(() => ({
  config: { notificationLanguage: "ko" } as Record<string, unknown> | null,
  linked: null as Record<string, unknown> | null,
  token: null as Record<string, unknown> | null,
  lookupFails: false,
}));

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: { findUnique: vi.fn(async () => state.config) },
    notification: {
      create: vi.fn(async () => ({ id: "notif-reconnect", createdAt: new Date() })),
    },
    linkedInboxAccount: {
      findFirst: vi.fn(async () => {
        if (state.lookupFails) throw new Error("db down: u1 me@icloud.com");
        return state.linked;
      }),
    },
    userToken: {
      findFirst: vi.fn(async () => {
        if (state.lookupFails) throw new Error("db down");
        return state.token;
      }),
    },
  },
}));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn(async () => ({})) }));

import { prisma } from "../db.js";
import { sendPushNotification } from "../notify/push.js";
import { ensureGmailReconnectNotification } from "../notify/reconnect-notification.js";
import { pushNotification } from "../websocket.js";

type PushCall = [string, { title: string; body: string; presentation?: unknown }, string];
const push = () => (vi.mocked(sendPushNotification).mock.calls as unknown as PushCall[])[0];

let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  vi.clearAllMocks();
  state.config = { notificationLanguage: "ko" };
  state.linked = null;
  state.token = null;
  state.lookupFails = false;
  delete process.env.NOTIFY_PUSH_PRESENTATION;
  consoleSpies = (["log", "info", "warn", "error"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => {
  delete process.env.NOTIFY_PUSH_PRESENTATION;
  for (const spy of consoleSpies) spy.mockRestore();
});

const consoleText = () => consoleSpies.map((spy) => JSON.stringify(spy.mock.calls)).join("\n");

describe("reconnect alert — NT0 acct copy (NOTIFY_PUSH_PRESENTATION)", () => {
  it("a linked IMAP preset names its own address, in the user's language", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    state.linked = { email: "k08200@icloud.com" };

    await ensureGmailReconnectNotification("u1", {
      linkedInboxAccountId: "lia-1",
      provider: "ICLOUD",
    });

    expect(push()[1]).toMatchObject({
      title: "k08200@icloud.com 연결 끊김",
      body: "다시 연결하면 이 계정 메일도 분류합니다",
      url: "/settings/accounts",
      presentation: { kind: "acct" },
    });
    // Scoped to the owner: the row is read by id AND user.
    expect(vi.mocked(prisma.linkedInboxAccount.findFirst)).toHaveBeenCalledWith({
      where: { id: "lia-1", userId: "u1" },
      select: { email: true },
    });
    // The bell row and the live frame keep their text.
    expect(vi.mocked(pushNotification).mock.calls[0][1]).toMatchObject({
      title: "iCloud Mail disconnected — 1 click to reconnect",
    });
    expect(consoleText()).not.toContain("k08200@icloud.com");
  });

  it("the primary Gmail names the Google account address", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    state.config = { notificationLanguage: "en" };
    state.token = { googleEmail: "me@gmail.com" };

    await ensureGmailReconnectNotification("u1");

    expect(push()[1]).toMatchObject({
      title: "me@gmail.com disconnected",
      body: "Reconnect it to sort this account's mail again",
    });
    expect(vi.mocked(prisma.userToken.findFirst)).toHaveBeenCalledWith({
      where: { userId: "u1", provider: "google" },
      select: { googleEmail: true },
    });
  });

  it("Outlook and a stopped IMAP poll read the same way", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    state.config = { notificationLanguage: "zh" };
    state.linked = { email: "me@outlook.com" };

    await ensureGmailReconnectNotification("u1", {
      linkedInboxAccountId: "lia-2",
      provider: "OUTLOOK",
    });
    await ensureGmailReconnectNotification("u1", {
      linkedInboxAccountId: "lia-2",
      provider: "YAHOO",
      stoppedAt: new Date("2026-11-18T05:00:00Z"),
    });

    const calls = vi.mocked(sendPushNotification).mock.calls as unknown as PushCall[];
    expect(calls.map(([, p]) => p.title)).toEqual([
      "me@outlook.com 已断开连接",
      "me@outlook.com 已断开连接",
    ]);
  });

  it("an unknown address names the provider; a failed lookup does too, logged without the address", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";

    await ensureGmailReconnectNotification("u1", {
      linkedInboxAccountId: "lia-3",
      provider: "NAVER",
    });
    expect(push()[1].title).toBe("Naver Mail 연결 끊김");

    vi.mocked(sendPushNotification).mockClear();
    state.lookupFails = true;
    await ensureGmailReconnectNotification("u1", {
      linkedInboxAccountId: "lia-3",
      provider: "NAVER",
    });
    expect(push()[1].title).toBe("Naver Mail 연결 끊김");
    expect(consoleText()).not.toContain("me@icloud.com");
  });

  it("flag off: the push is exactly what it was, and no address is read", async () => {
    state.linked = { email: "k08200@icloud.com" };

    await ensureGmailReconnectNotification("u1", {
      linkedInboxAccountId: "lia-1",
      provider: "ICLOUD",
    });

    expect(push()[1]).toEqual({
      title: "iCloud Mail disconnected — 1 click to reconnect",
      body: "Klorn lost access to your iCloud Mail, so the firewall is paused. Reconnect in Settings to resume.",
      url: "/settings/accounts",
      notificationId: "notif-reconnect",
      presentation: { kind: "acct" },
    });
    expect(prisma.linkedInboxAccount.findFirst).not.toHaveBeenCalled();
    expect(prisma.userToken.findFirst).not.toHaveBeenCalled();
  });
});
