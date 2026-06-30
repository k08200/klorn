import { beforeEach, describe, expect, it, vi } from "vitest";

// getUpcomingMeetings must source its Google client from getAuthedClient so an
// expired access token is refreshed AND persisted. These tests pin that
// contract and prove the calendar-fetch failure path is no longer silent.

vi.mock("../gmail.js", () => ({ getAuthedClient: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
// Keep the unit isolated from heavy top-level imports in meeting.ts.
vi.mock("../openai.js", () => ({ createCompletion: vi.fn(), MODEL: {} }));
vi.mock("../db.js", () => ({ prisma: {} }));

const eventsList = vi.fn();
vi.mock("googleapis", () => ({
  google: { calendar: vi.fn(() => ({ events: { list: eventsList } })) },
}));

import { getAuthedClient } from "../gmail.js";
import { getUpcomingMeetings } from "../meeting.js";
import { captureError } from "../sentry.js";

const mockedGetAuthedClient = vi.mocked(getAuthedClient);
const mockedCaptureError = vi.mocked(captureError);
// Minimal stand-in for an OAuth2 client instance.
const fakeAuth = {} as Awaited<ReturnType<typeof getAuthedClient>>;

describe("getUpcomingMeetings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] without hitting the calendar when there is no authed client", async () => {
    mockedGetAuthedClient.mockResolvedValue(null);

    const result = await getUpcomingMeetings("user-1");

    expect(result).toEqual([]);
    expect(mockedGetAuthedClient).toHaveBeenCalledWith("user-1");
    expect(eventsList).not.toHaveBeenCalled();
  });

  it("sources credentials from getAuthedClient (refreshing + persisting client)", async () => {
    mockedGetAuthedClient.mockResolvedValue(fakeAuth);
    eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "evt-1",
            summary: "Standup",
            start: { dateTime: "2026-07-01T09:00:00Z" },
            end: { dateTime: "2026-07-01T09:15:00Z" },
            hangoutLink: "https://meet.google.com/abc-defg-hij",
            attendees: [{ email: "a@b.com" }],
          },
        ],
      },
    });

    const result = await getUpcomingMeetings("user-1");

    expect(mockedGetAuthedClient).toHaveBeenCalledWith("user-1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "evt-1",
      meetingLink: "https://meet.google.com/abc-defg-hij",
    });
  });

  it("filters out events that have no meeting link", async () => {
    mockedGetAuthedClient.mockResolvedValue(fakeAuth);
    eventsList.mockResolvedValue({
      data: { items: [{ id: "evt-2", summary: "No link", start: {}, end: {}, attendees: [] }] },
    });

    const result = await getUpcomingMeetings("user-1");

    expect(result).toEqual([]);
  });

  it("records calendar errors instead of swallowing them silently", async () => {
    mockedGetAuthedClient.mockResolvedValue(fakeAuth);
    eventsList.mockRejectedValue(new Error("calendar down"));

    const result = await getUpcomingMeetings("user-1");

    expect(result).toEqual([]);
    expect(mockedCaptureError).toHaveBeenCalledTimes(1);
  });
});
