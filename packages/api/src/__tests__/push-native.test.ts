import { describe, expect, it, vi } from "vitest";

// Native push must degrade to a clean, logged skip when its credentials are
// absent (dev / self-host without FCM or APNs) — never crash, never silently
// vanish. These guard the unconfigured paths without any network.
vi.mock("../db.js", () => {
  const prisma = {
    devicePushToken: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { isApnsConfigured, sendApnsPush } from "../push-apns.js";
import { isDevicePushConfigured, sendDevicePush } from "../push-device.js";

describe("native push guards (unconfigured)", () => {
  it("APNs reports not-configured without keys", () => {
    expect(isApnsConfigured()).toBe(false);
  });

  it("sendApnsPush skips cleanly when APNs is unconfigured", async () => {
    const result = await sendApnsPush("user-1", { title: "t", body: "b" });
    expect(result).toMatchObject({ status: "skipped", reason: "missing_apns_credentials" });
  });

  it("FCM reports not-configured without a service account", () => {
    expect(isDevicePushConfigured()).toBe(false);
  });

  it("sendDevicePush skips cleanly when FCM is unconfigured", async () => {
    const result = await sendDevicePush("user-1", { title: "t", body: "b" });
    expect(result).toMatchObject({ status: "skipped", reason: "missing_firebase_credentials" });
  });
});
