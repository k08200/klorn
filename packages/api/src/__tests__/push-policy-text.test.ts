/**
 * NT0 copy (NOTIFY_PUSH_PRESENTATION) changes a push's text, never whether it
 * rings: a push whose title / body are NT0 copy carries its pre-NT0 text as
 * `policyText`, and the inbound-mail noise policy judges that. An acct title
 * naming "ideal.kim@gmail.com" ("deal") or an agent title naming a sender
 * called "Daily Digest" would otherwise be dropped as noise. The field never
 * reaches a channel payload.
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

import { sendPushNotification } from "../notify/push.js";
import { sendApnsPush } from "../notify/push-apns.js";
import { sendDevicePush } from "../notify/push-device.js";
import { recordPushAttempt } from "../notify/push-rate-limit.js";
import { sendTelegramForPush } from "../notify/telegram-notify.js";

const OLD_ACCT = {
  title: "Gmail disconnected — 1 click to reconnect",
  body: "Klorn lost access to your Gmail, so the firewall is paused. Reconnect in Settings to resume.",
};
const NT0_ACCT = {
  title: "ideal.kim@gmail.com 연결 끊김",
  body: "다시 연결하면 이 계정 메일도 분류합니다",
  url: "/settings/accounts",
};

beforeEach(() => vi.clearAllMocks());

describe("sendPushNotification and NT0 copy", () => {
  it("the NT0 acct text alone trips the noise heuristic (the address holds 'deal')", async () => {
    const result = await sendPushNotification("user-1", NT0_ACCT);
    expect(result).toMatchObject({ status: "skipped", reason: "policy_noise" });
  });

  it("with its old text as policyText it rings, as the old text did", async () => {
    const result = await sendPushNotification("user-1", { ...NT0_ACCT, policyText: OLD_ACCT });
    expect(result.reason).not.toBe("policy_noise");
    expect(recordPushAttempt).toHaveBeenCalledWith("user-1", "ambient");
  });

  it("an old text that was noise stays noise: the copy flag never rescues a push", async () => {
    const result = await sendPushNotification("user-1", {
      title: "Reply draft ready · Kim",
      body: "Review it before it is sent",
      policyText: { title: "[Klorn] Review needed", body: "Reply to the newsletter digest" },
    });
    expect(result).toMatchObject({ status: "skipped", reason: "policy_noise" });
  });

  it("never puts policyText on a channel payload, and shows the NT0 text", async () => {
    await sendPushNotification("user-1", { ...NT0_ACCT, policyText: OLD_ACCT });
    await vi.waitFor(() => expect(sendApnsPush).toHaveBeenCalled());
    for (const fn of [sendTelegramForPush, sendDevicePush, sendApnsPush]) {
      const payload = vi.mocked(fn).mock.calls[0]?.[1] as Record<string, unknown>;
      expect(payload).toBeDefined();
      expect(payload).not.toHaveProperty("policyText");
      expect(payload.title).toBe(NT0_ACCT.title);
    }
  });
});
