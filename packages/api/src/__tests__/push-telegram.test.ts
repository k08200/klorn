import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirror push-retry.test.ts: every collaborator of push.ts is mocked so the
// module graph never opens a real DB connection.
vi.mock("../db.js", () => ({
  prisma: {
    pushSubscription: {
      findMany: vi.fn(async () => []),
      delete: vi.fn(async () => ({})),
    },
    pushDeliveryLog: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("../push-delivery.js", () => ({
  createPushDeliveryAttempt: vi.fn(async () => "delivery-id"),
  createSkippedPushDelivery: vi.fn(async () => {}),
  markPushAccepted: vi.fn(async () => {}),
  markPushFailed: vi.fn(async () => {}),
}));
vi.mock("../notification-policy.js", () => ({
  notificationSuppressionReason: vi.fn(() => null),
}));
vi.mock("../notification-prefs.js", () => ({
  evaluateNotificationGate: vi.fn(async () => ({ allowed: true as const })),
}));
vi.mock("../push-rate-limit.js", () => ({
  recordPushAttempt: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../is-safe-push-endpoint.js", () => ({
  isSafePushEndpoint: vi.fn(() => true),
}));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("../telegram-notify.js", () => ({
  sendTelegramForPush: vi.fn(async () => "sent"),
}));

import { evaluateNotificationGate } from "../notification-prefs.js";
import { sendPushNotification } from "../push.js";
import { recordPushAttempt } from "../push-rate-limit.js";
import { sendTelegramForPush } from "../telegram-notify.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(evaluateNotificationGate).mockResolvedValue({ allowed: true });
  vi.mocked(recordPushAttempt).mockResolvedValue({ allowed: true });
  vi.mocked(sendTelegramForPush).mockResolvedValue("sent");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("sendPushNotification — Telegram secondary channel", () => {
  it("sends a Telegram message for a gated-through push, even without VAPID keys", async () => {
    // VAPID env is unset in tests — a Telegram-only self-hoster. Web push is
    // skipped but the Telegram channel must still fire.
    const result = await sendPushNotification(
      "user-1",
      { title: "Urgent mail", body: "Reply needed", url: "/briefing" },
      "email_urgent",
    );
    expect(result.status).toBe("skipped"); // web push: no VAPID keys
    expect(sendTelegramForPush).toHaveBeenCalledTimes(1);
    expect(sendTelegramForPush).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ title: "Urgent mail", body: "Reply needed", url: "/briefing" }),
      "email_urgent",
    );
  });

  it("passes the attention item id through for tier-override buttons", async () => {
    await sendPushNotification(
      "user-1",
      { title: "T", body: "B", attentionItemId: "item-1" },
      "email_urgent",
    );
    expect(sendTelegramForPush).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ attentionItemId: "item-1" }),
      "email_urgent",
    );
  });

  it("does NOT send Telegram when user prefs / quiet hours suppress (same gate result)", async () => {
    vi.mocked(evaluateNotificationGate).mockResolvedValueOnce({
      allowed: false,
      reason: "quiet_hours",
    });
    const result = await sendPushNotification("user-1", { title: "T", body: "B" }, "email_urgent");
    expect(result.reason).toBe("quiet_hours");
    expect(sendTelegramForPush).not.toHaveBeenCalled();
  });

  it("does NOT send Telegram when the global push rate limit trips", async () => {
    vi.mocked(recordPushAttempt).mockResolvedValueOnce({ allowed: false, reason: "hourly_cap" });
    const result = await sendPushNotification("user-1", { title: "T", body: "B" }, "email_urgent");
    expect(result.reason).toBe("rate_limited");
    expect(sendTelegramForPush).not.toHaveBeenCalled();
  });

  it("a Telegram failure never breaks the push path", async () => {
    vi.mocked(sendTelegramForPush).mockRejectedValueOnce(new Error("telegram exploded"));
    await expect(
      sendPushNotification("user-1", { title: "T", body: "B" }, "email_urgent"),
    ).resolves.toMatchObject({ status: "skipped" });
  });
});
