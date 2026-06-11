import { describe, expect, it, vi } from "vitest";

// db / providers must be mocked before importing push.ts so the module
// graph doesn't try to open a real DB connection during tests.
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
vi.mock("../notification-prefs.js", () => ({
  evaluateNotificationGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../push-rate-limit.js", () => ({
  recordPushAttempt: vi.fn(() => ({ allowed: true })),
}));
vi.mock("../is-safe-push-endpoint.js", () => ({
  isSafePushEndpoint: vi.fn(() => true),
}));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}));

import { shouldRetryPushError } from "../push.js";

describe("shouldRetryPushError", () => {
  it("retries on missing status (network error)", () => {
    expect(shouldRetryPushError(undefined)).toBe(true);
  });

  it("retries 5xx and 429", () => {
    expect(shouldRetryPushError(500)).toBe(true);
    expect(shouldRetryPushError(502)).toBe(true);
    expect(shouldRetryPushError(503)).toBe(true);
    expect(shouldRetryPushError(429)).toBe(true);
  });

  it("does not retry permanent failures", () => {
    expect(shouldRetryPushError(410)).toBe(false); // subscription gone
    expect(shouldRetryPushError(404)).toBe(false); // endpoint missing
    expect(shouldRetryPushError(400)).toBe(false); // bad payload
    expect(shouldRetryPushError(401)).toBe(false); // VAPID auth
    expect(shouldRetryPushError(403)).toBe(false); // forbidden
  });

  it("does not retry 2xx (delivered) — shouldn't be called here, but defensive", () => {
    expect(shouldRetryPushError(200)).toBe(false);
    expect(shouldRetryPushError(201)).toBe(false);
  });
});
