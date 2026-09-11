/**
 * Google-side calendar writes (2026-09-11): an edit in Klorn must reach the
 * Google copy (updateEvent), and all-day events must go out as DATES with
 * an exclusive end — an instant with a timeZone would make a Seoul all-day
 * event start at 09:00.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  eventsInsertMock: vi.fn(),
  eventsPatchMock: vi.fn(),
  automationConfigFindUnique: vi.fn(),
  markReconnect: vi.fn(async () => {}),
  authError: false,
}));

vi.mock("googleapis", () => ({
  google: {
    calendar: vi.fn(() => ({
      events: { insert: m.eventsInsertMock, patch: m.eventsPatchMock },
    })),
  },
}));

vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  isGoogleAuthError: () => m.authError,
  markGoogleTokenForReconnect: m.markReconnect,
}));

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: { findUnique: m.automationConfigFindUnique },
  },
}));

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { createEvent, googleEventTimes, updateEvent } from "../pim/calendar.js";

beforeEach(() => {
  vi.clearAllMocks();
  m.authError = false;
  m.automationConfigFindUnique.mockResolvedValue({ timezone: "Asia/Seoul" });
  m.eventsInsertMock.mockResolvedValue({ data: { id: "evt-1", start: {}, end: {} } });
  m.eventsPatchMock.mockResolvedValue({
    data: {
      start: { dateTime: "2026-08-01T11:00:00+09:00" },
      end: { dateTime: "2026-08-01T12:00:00+09:00" },
    },
  });
});

describe("googleEventTimes", () => {
  it("timed events carry the user's zone; all-day events are dates read off the string", () => {
    expect(
      googleEventTimes({
        startTime: "2026-08-01T09:00:00",
        endTime: "2026-08-01T10:00:00",
        allDay: false,
        timeZone: "Asia/Seoul",
      }),
    ).toEqual({
      start: { dateTime: "2026-08-01T09:00:00", timeZone: "Asia/Seoul" },
      end: { dateTime: "2026-08-01T10:00:00", timeZone: "Asia/Seoul" },
    });
    // The date is the string's date — an offset or a Z must not shift it.
    expect(
      googleEventTimes({
        startTime: "2026-08-01T00:00:00+09:00",
        endTime: "2026-08-02T00:00:00Z",
        allDay: true,
        timeZone: "Asia/Seoul",
      }),
    ).toEqual({ start: { date: "2026-08-01" }, end: { date: "2026-08-02" } });
  });
});

describe("createEvent — all-day", () => {
  it("sends date fields, no dateTime, for an all-day event", async () => {
    await createEvent(
      "user-1",
      "Offsite",
      "2026-08-01T00:00:00Z",
      "2026-08-02T00:00:00Z",
      undefined,
      undefined,
      undefined,
      true,
    );
    const body = m.eventsInsertMock.mock.calls[0][0].requestBody;
    expect(body.start).toEqual({ date: "2026-08-01" });
    expect(body.end).toEqual({ date: "2026-08-02" });
  });
});

describe("updateEvent", () => {
  it("patches exactly the changed fields on the Google event, times as a consistent pair", async () => {
    const result = await updateEvent("user-1", "goog-1", {
      summary: "Moved",
      startTime: "2026-08-01T02:00:00.000Z",
      endTime: "2026-08-01T03:00:00.000Z",
      allDay: false,
    });
    expect(m.eventsPatchMock).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "goog-1",
      requestBody: {
        summary: "Moved",
        start: { dateTime: "2026-08-01T02:00:00.000Z", timeZone: "Asia/Seoul" },
        end: { dateTime: "2026-08-01T03:00:00.000Z", timeZone: "Asia/Seoul" },
      },
    });
    expect(result).toEqual({
      success: true,
      canonicalStart: "2026-08-01T11:00:00+09:00",
      canonicalEnd: "2026-08-01T12:00:00+09:00",
    });
  });

  it("a title-only edit sends no times; a cleared location sends an empty string", async () => {
    await updateEvent("user-1", "goog-1", { summary: "T", location: null });
    const body = m.eventsPatchMock.mock.calls[0][0].requestBody;
    expect(body).toEqual({ summary: "T", location: "" });
  });

  it("an auth failure flags the token for reconnect and returns an error, never throws", async () => {
    m.authError = true;
    m.eventsPatchMock.mockRejectedValueOnce(new Error("invalid_grant"));
    const result = await updateEvent("user-1", "goog-1", { summary: "T" });
    expect("error" in result).toBe(true);
    expect(m.markReconnect).toHaveBeenCalledWith("user-1");
  });
});
