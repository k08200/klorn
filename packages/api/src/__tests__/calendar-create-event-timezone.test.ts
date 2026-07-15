import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * createEvent hardcoded "Asia/Seoul" as the Google event timeZone regardless
 * of the user's configured timezone. For a naive (offset-less) dateTime,
 * Google interprets it in whatever timeZone field is sent — so a non-KST
 * user's event landed at the wrong absolute time (#676).
 */

const m = vi.hoisted(() => ({
  eventsInsertMock: vi.fn(),
  automationConfigFindUnique: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    calendar: vi.fn(() => ({
      events: { insert: m.eventsInsertMock },
    })),
  },
}));

vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  isGoogleAuthError: () => false,
  markGoogleTokenForReconnect: vi.fn(async () => {}),
}));

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: { findUnique: m.automationConfigFindUnique },
  },
}));

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { createEvent } from "../pim/calendar.js";

beforeEach(() => {
  vi.clearAllMocks();
  m.eventsInsertMock.mockResolvedValue({
    data: { id: "evt-1", htmlLink: "https://x", start: {}, end: {} },
  });
});

describe("createEvent — uses the user's configured timezone (#676)", () => {
  it("sends the user's configured IANA timezone, not a hardcoded default", async () => {
    m.automationConfigFindUnique.mockResolvedValue({ timezone: "America/New_York" });
    await createEvent("user-1", "Standup", "2026-08-01T09:00:00", "2026-08-01T09:30:00");
    const body = m.eventsInsertMock.mock.calls[0][0].requestBody;
    expect(body.start.timeZone).toBe("America/New_York");
    expect(body.end.timeZone).toBe("America/New_York");
  });

  it("falls back to the product default when the user has no configured timezone", async () => {
    m.automationConfigFindUnique.mockResolvedValue({ timezone: null });
    await createEvent("user-1", "Standup", "2026-08-01T09:00:00", "2026-08-01T09:30:00");
    const body = m.eventsInsertMock.mock.calls[0][0].requestBody;
    expect(body.start.timeZone).toBe("Asia/Seoul");
    expect(body.end.timeZone).toBe("Asia/Seoul");
  });

  it("rejects a garbage stored timezone and falls back to the default instead of sending it to Google", async () => {
    m.automationConfigFindUnique.mockResolvedValue({ timezone: "Not/AZone" });
    await createEvent("user-1", "Standup", "2026-08-01T09:00:00", "2026-08-01T09:30:00");
    const body = m.eventsInsertMock.mock.calls[0][0].requestBody;
    expect(body.start.timeZone).toBe("Asia/Seoul");
  });
});
