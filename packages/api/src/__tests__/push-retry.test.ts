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

import {
  authoredSurface,
  decidePushFailureAction,
  MAX_CONSECUTIVE_PUSH_FAILURES,
  shouldRetryPushError,
} from "../push.js";

describe("authoredSurface — which push categories bypass the noise heuristic", () => {
  it("maps the firewall-judged email push to the 'firewall' authored surface", () => {
    // Closes the bug where a judge=PUSH email whose subject collided with a
    // noise keyword ("confirm your…") was silently dropped at the push gate.
    expect(authoredSurface("email_urgent")).toBe("firewall");
  });

  it("maps the daily briefing to the 'briefing' authored surface", () => {
    expect(authoredSurface("daily_briefing")).toBe("briefing");
  });

  it("maps the firewall-decided email_candidate push to the 'firewall' surface", () => {
    // candidate materials are an explicit firewall interrupt, not inbound noise.
    expect(authoredSurface("email_candidate")).toBe("firewall");
  });

  it("leaves all other categories subject to the noise + housekeeping filters", () => {
    expect(authoredSurface("system")).toBeNull();
    expect(authoredSurface("agent_proposal")).toBeNull();
  });
});

describe("decidePushFailureAction — budgeted eviction", () => {
  it("deletes a definitively-dead subscription (410/404)", () => {
    expect(decidePushFailureAction(0, 410)).toEqual({ kind: "delete", reason: "expired" });
    expect(decidePushFailureAction(3, 404)).toEqual({ kind: "delete", reason: "expired" });
  });

  it("increments the consecutive-failure count on an ambiguous failure below threshold", () => {
    expect(decidePushFailureAction(0, 503)).toEqual({ kind: "increment", failureCount: 1 });
    expect(decidePushFailureAction(2, undefined)).toEqual({ kind: "increment", failureCount: 3 });
  });

  it("evicts a sub that has failed MAX consecutive times (stops burning retry budget)", () => {
    expect(decidePushFailureAction(MAX_CONSECUTIVE_PUSH_FAILURES - 1, 500)).toEqual({
      kind: "delete",
      reason: "evicted",
    });
  });
});

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
