/**
 * A reminder the user set themselves (the mail "Later") quotes the subject of
 * the mail they chose to be reminded of. The inbound-mail noise heuristic must
 * not veto it ("Follow up: Big deal" is not a promotion), while every other
 * gate — quiet hours, the category preference, the rate-cap buckets — still
 * applies, and the flag never reaches a channel payload.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  prisma: {
    pushSubscription: { findMany: vi.fn(async () => []), delete: vi.fn(async () => ({})) },
    pushDeliveryLog: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("../notify/push-delivery.js", () => ({
  createPushDeliveryAttempt: vi.fn(async () => "delivery-id"),
  createSkippedPushDelivery: vi.fn(async () => {}),
  markPushAccepted: vi.fn(async () => {}),
  markPushFailed: vi.fn(async () => {}),
}));
vi.mock("../notify/notification-prefs.js", () => ({
  evaluateNotificationGate: vi.fn(async () => ({ allowed: true as const })),
}));
vi.mock("../notify/push-rate-limit.js", () => ({
  recordPushAttempt: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../notify/push-device.js", () => ({ sendDevicePush: vi.fn(async () => ({})) }));
vi.mock("../notify/push-apns.js", () => ({ sendApnsPush: vi.fn(async () => ({})) }));
vi.mock("../notify/telegram-notify.js", () => ({
  sendTelegramForPush: vi.fn(async () => "sent"),
}));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}));

import { evaluateNotificationGate } from "../notify/notification-prefs.js";
import { sendPushNotification } from "../notify/push.js";
import { sendApnsPush } from "../notify/push-apns.js";
import { sendDevicePush } from "../notify/push-device.js";
import { recordPushAttempt } from "../notify/push-rate-limit.js";
import { sendTelegramForPush } from "../notify/telegram-notify.js";

const REMINDER = {
  title: "Follow up: Big deal — newsletter digest",
  body: "From: Alice <a@x.io>\nOpen: /email/email-1",
  url: "/email/email-1",
};

beforeEach(() => vi.clearAllMocks());

describe("sendPushNotification and a user-set reminder", () => {
  it("is not vetoed by the noise heuristic", async () => {
    const result = await sendPushNotification("user-1", { ...REMINDER, userSet: true });
    expect(result.reason).not.toBe("policy_noise");
    // It reached the rate cap, in the ambient bucket ("system").
    expect(recordPushAttempt).toHaveBeenCalledWith("user-1", "ambient");
  });

  it("the same text without the flag is still treated as noise", async () => {
    const result = await sendPushNotification("user-1", REMINDER);
    expect(result).toMatchObject({ status: "skipped", reason: "policy_noise" });
  });

  it("still respects quiet hours", async () => {
    vi.mocked(evaluateNotificationGate).mockResolvedValueOnce({
      allowed: false,
      reason: "quiet_hours",
    });
    const result = await sendPushNotification("user-1", { ...REMINDER, userSet: true });
    expect(result).toMatchObject({ status: "skipped", reason: "quiet_hours" });
    expect(recordPushAttempt).not.toHaveBeenCalled();
  });

  it("never puts the flag on a channel payload", async () => {
    await sendPushNotification("user-1", { ...REMINDER, userSet: true });
    await vi.waitFor(() => expect(sendApnsPush).toHaveBeenCalled());
    for (const fn of [sendTelegramForPush, sendDevicePush, sendApnsPush]) {
      const payload = vi.mocked(fn).mock.calls[0]?.[1] as Record<string, unknown>;
      expect(payload).toBeDefined();
      expect(payload).not.toHaveProperty("userSet");
    }
  });
});
