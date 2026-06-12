import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// db / collaborators must be mocked before importing push.ts so the module
// graph doesn't try to open a real DB connection during tests (same pattern
// as push-retry.test.ts).
const mocks = vi.hoisted(() => ({
  automationConfigFindUnique: vi.fn(),
  pushSubscriptionFindMany: vi.fn(),
  createSkippedPushDelivery: vi.fn(async () => {}),
  createPushDeliveryAttempt: vi.fn(async () => "delivery-id"),
  markPushAccepted: vi.fn(async () => {}),
  markPushFailed: vi.fn(async () => {}),
  webPushSend: vi.fn(async () => ({})),
}));

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: { findUnique: mocks.automationConfigFindUnique },
    pushSubscription: {
      findMany: mocks.pushSubscriptionFindMany,
      delete: vi.fn(async () => ({})),
    },
    pushDeliveryLog: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("../push-delivery.js", () => ({
  createPushDeliveryAttempt: mocks.createPushDeliveryAttempt,
  createSkippedPushDelivery: mocks.createSkippedPushDelivery,
  markPushAccepted: mocks.markPushAccepted,
  markPushFailed: mocks.markPushFailed,
}));
vi.mock("../push-rate-limit.js", () => ({
  recordPushAttempt: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../is-safe-push-endpoint.js", () => ({
  isSafePushEndpoint: vi.fn(() => true),
}));
vi.mock("../push-origin-allowlist.js", () => ({
  isAllowedPushOrigin: vi.fn(() => true),
}));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: mocks.webPushSend },
  setVapidDetails: vi.fn(),
  sendNotification: mocks.webPushSend,
}));

import { isWithinQuietHours } from "../quiet-hours.js";

const WINDOW_OVERNIGHT = { quietHoursStart: "22:00", quietHoursEnd: "08:00" };
const WINDOW_SAME_DAY = { quietHoursStart: "13:00", quietHoursEnd: "17:00" };

describe("isWithinQuietHours", () => {
  it("returns false when config is disabled (null start/end)", () => {
    const now = new Date("2026-01-01T23:00:00Z");
    expect(isWithinQuietHours(now, { quietHoursStart: null, quietHoursEnd: null }, "UTC")).toBe(
      false,
    );
    expect(isWithinQuietHours(now, { quietHoursStart: "22:00", quietHoursEnd: null }, "UTC")).toBe(
      false,
    );
    expect(isWithinQuietHours(now, { quietHoursStart: null, quietHoursEnd: "08:00" }, "UTC")).toBe(
      false,
    );
  });

  it("returns false for malformed or out-of-range time strings", () => {
    const now = new Date("2026-01-01T23:00:00Z");
    expect(isWithinQuietHours(now, { quietHoursStart: "abc", quietHoursEnd: "08:00" }, "UTC")).toBe(
      false,
    );
    expect(
      isWithinQuietHours(now, { quietHoursStart: "22:00", quietHoursEnd: "xx:yy" }, "UTC"),
    ).toBe(false);
    expect(
      isWithinQuietHours(now, { quietHoursStart: "25:00", quietHoursEnd: "08:00" }, "UTC"),
    ).toBe(false);
    expect(
      isWithinQuietHours(now, { quietHoursStart: "22:00", quietHoursEnd: "08:99" }, "UTC"),
    ).toBe(false);
  });

  it("returns false for a zero-length window (start === end)", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    expect(
      isWithinQuietHours(now, { quietHoursStart: "12:00", quietHoursEnd: "12:00" }, "UTC"),
    ).toBe(false);
  });

  it("handles a same-day window", () => {
    expect(isWithinQuietHours(new Date("2026-01-01T14:00:00Z"), WINDOW_SAME_DAY, "UTC")).toBe(true);
    expect(isWithinQuietHours(new Date("2026-01-01T10:00:00Z"), WINDOW_SAME_DAY, "UTC")).toBe(
      false,
    );
    expect(isWithinQuietHours(new Date("2026-01-01T17:30:00Z"), WINDOW_SAME_DAY, "UTC")).toBe(
      false,
    );
  });

  it("handles a window crossing midnight", () => {
    expect(isWithinQuietHours(new Date("2026-01-01T23:30:00Z"), WINDOW_OVERNIGHT, "UTC")).toBe(
      true,
    );
    expect(isWithinQuietHours(new Date("2026-01-01T03:00:00Z"), WINDOW_OVERNIGHT, "UTC")).toBe(
      true,
    );
    expect(isWithinQuietHours(new Date("2026-01-01T07:59:00Z"), WINDOW_OVERNIGHT, "UTC")).toBe(
      true,
    );
    expect(isWithinQuietHours(new Date("2026-01-01T12:00:00Z"), WINDOW_OVERNIGHT, "UTC")).toBe(
      false,
    );
    expect(isWithinQuietHours(new Date("2026-01-01T21:59:00Z"), WINDOW_OVERNIGHT, "UTC")).toBe(
      false,
    );
  });

  it("includes the start minute and excludes the end minute", () => {
    expect(isWithinQuietHours(new Date("2026-01-01T22:00:00Z"), WINDOW_OVERNIGHT, "UTC")).toBe(
      true,
    );
    expect(isWithinQuietHours(new Date("2026-01-01T08:00:00Z"), WINDOW_OVERNIGHT, "UTC")).toBe(
      false,
    );
  });

  it("evaluates the window in the user's timezone, not server UTC", () => {
    // 2026-01-01T14:30:00Z is 23:30 in Asia/Seoul (inside 22:00–08:00)
    // but 14:30 in UTC (outside).
    const now = new Date("2026-01-01T14:30:00Z");
    expect(isWithinQuietHours(now, WINDOW_OVERNIGHT, "Asia/Seoul")).toBe(true);
    expect(isWithinQuietHours(now, WINDOW_OVERNIGHT, "UTC")).toBe(false);
  });

  it("handles the timezone boundary at local midnight", () => {
    // 2026-01-01T15:00:00Z is exactly 00:00 on 2026-01-02 in Asia/Seoul.
    const now = new Date("2026-01-01T15:00:00Z");
    expect(isWithinQuietHours(now, WINDOW_OVERNIGHT, "Asia/Seoul")).toBe(true);
  });

  it("falls back to the default timezone for an invalid timezone string", () => {
    // normalizeTimeZone falls back to Asia/Seoul: 14:30Z → 23:30 local.
    const now = new Date("2026-01-01T14:30:00Z");
    expect(isWithinQuietHours(now, WINDOW_OVERNIGHT, "Not/AZone")).toBe(true);
  });
});

describe("sendPushNotification quiet-hours enforcement", () => {
  const USER_ID = "user-1";
  const PAYLOAD = { title: "Urgent reply needed", body: "A client is waiting on you." };
  const SUBSCRIPTION = {
    id: "sub-1",
    endpoint: "https://push.example.com/endpoint",
    p256dh: "p256dh-key",
    auth: "auth-key",
    origin: "http://localhost:8001",
  };

  // biome-ignore lint/suspicious/noExplicitAny: late-bound dynamic import
  let sendPushNotification: any;

  beforeAll(async () => {
    // push.ts reads VAPID env at module load — set before importing.
    process.env.VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";
    ({ sendPushNotification } = await import("../push.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pushSubscriptionFindMany.mockResolvedValue([SUBSCRIPTION]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function configWithQuietHours(overrides: Record<string, unknown> = {}) {
    return {
      timezone: "UTC",
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
      ...overrides,
    };
  }

  it("suppresses browser push during quiet hours and logs skipReason quiet_hours", async () => {
    vi.setSystemTime(new Date("2026-01-02T02:00:00Z")); // 02:00 UTC — inside 22:00–08:00
    mocks.automationConfigFindUnique.mockResolvedValue(configWithQuietHours());

    const result = await sendPushNotification(USER_ID, PAYLOAD, "system");

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("quiet_hours");
    expect(mocks.webPushSend).not.toHaveBeenCalled();
    expect(mocks.createSkippedPushDelivery).toHaveBeenCalledWith({
      userId: USER_ID,
      category: "system",
      title: PAYLOAD.title,
      skipReason: "quiet_hours",
    });
  });

  it("respects the user's timezone when deciding quiet hours", async () => {
    // 14:30 UTC = 23:30 Asia/Seoul → quiet there, not in UTC.
    vi.setSystemTime(new Date("2026-01-02T14:30:00Z"));
    mocks.automationConfigFindUnique.mockResolvedValue(
      configWithQuietHours({ timezone: "Asia/Seoul" }),
    );

    const result = await sendPushNotification(USER_ID, PAYLOAD, "system");

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("quiet_hours");
    expect(mocks.webPushSend).not.toHaveBeenCalled();
  });

  it("sends the push outside quiet hours", async () => {
    vi.setSystemTime(new Date("2026-01-02T12:00:00Z")); // 12:00 UTC — outside window
    mocks.automationConfigFindUnique.mockResolvedValue(configWithQuietHours());

    const result = await sendPushNotification(USER_ID, PAYLOAD, "system");

    expect(result.status).toBe("sent");
    expect(result.accepted).toBe(1);
    expect(mocks.webPushSend).toHaveBeenCalledTimes(1);
    expect(mocks.createSkippedPushDelivery).not.toHaveBeenCalled();
  });

  it("sends when quiet hours are not configured", async () => {
    vi.setSystemTime(new Date("2026-01-02T02:00:00Z"));
    mocks.automationConfigFindUnique.mockResolvedValue(
      configWithQuietHours({ quietHoursStart: null, quietHoursEnd: null }),
    );

    const result = await sendPushNotification(USER_ID, PAYLOAD, "system");

    expect(result.status).toBe("sent");
    expect(mocks.webPushSend).toHaveBeenCalledTimes(1);
  });

  it("keeps category opt-out distinct from quiet hours in the skip reason", async () => {
    vi.setSystemTime(new Date("2026-01-02T12:00:00Z")); // outside quiet window
    mocks.automationConfigFindUnique.mockResolvedValue(
      configWithQuietHours({ notifyMeeting: false }),
    );

    const result = await sendPushNotification(USER_ID, PAYLOAD, "meeting");

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("user_preferences");
    expect(mocks.webPushSend).not.toHaveBeenCalled();
    expect(mocks.createSkippedPushDelivery).toHaveBeenCalledWith({
      userId: USER_ID,
      category: "meeting",
      title: PAYLOAD.title,
      skipReason: "user_preferences",
    });
  });
});
