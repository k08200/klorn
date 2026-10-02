import { beforeEach, describe, expect, it, vi } from "vitest";

// getUpcomingMeetings must source its Google client from getAuthedClient so an
// expired access token is refreshed AND persisted. These tests pin that
// contract and prove the calendar-fetch failure path is no longer silent.

vi.mock("../mail/gmail.js", () => ({ getAuthedClient: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
// Keep the unit isolated from heavy top-level imports in meeting.ts.
vi.mock("../llm/openai.js", () => ({ createCompletion: vi.fn(), MODEL: {} }));
vi.mock("../db.js", () => ({ prisma: {} }));

const eventsList = vi.fn();
vi.mock("googleapis", () => ({
  google: { calendar: vi.fn(() => ({ events: { list: eventsList } })) },
}));

import { getAuthedClient } from "../mail/gmail.js";
import { getUpcomingMeetings } from "../pim/meeting.js";
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

  describe("meetingLink is https only (#1348 server follow-up)", () => {
    async function linksOf(item: Record<string, unknown>) {
      mockedGetAuthedClient.mockResolvedValue(fakeAuth);
      eventsList.mockResolvedValue({
        data: {
          items: [
            {
              id: "evt-1",
              summary: "Sync",
              start: { dateTime: "2026-07-01T09:00:00Z" },
              end: { dateTime: "2026-07-01T09:30:00Z" },
              ...item,
            },
          ],
        },
      });
      return (await getUpcomingMeetings("user-1")).map((meeting) => meeting.meetingLink);
    }
    const video = (uri: string) => ({
      conferenceData: { entryPoints: [{ entryPointType: "video", uri }] },
    });

    it("keeps a real conferenceData link", async () => {
      expect(await linksOf(video("https://zoom.us/j/123?pwd=x"))).toEqual([
        "https://zoom.us/j/123?pwd=x",
      ]);
    });

    it("drops an unsafe conferenceData uri and hangoutLink, so the event has no link and is left out", async () => {
      expect(
        await linksOf({
          ...video("javascript:alert(1)"),
          hangoutLink: "http://meet.google.com/abc-defg-hij",
        }),
      ).toEqual([]);
    });

    it("falls back from an unsafe video uri to a valid hangoutLink", async () => {
      expect(
        await linksOf({
          ...video("file:///etc/passwd"),
          hangoutLink: "https://meet.google.com/abc-defg-hij",
        }),
      ).toEqual(["https://meet.google.com/abc-defg-hij"]);
    });

    it.each([
      ["a Zoom link", "Join: https://zoom.us/j/123?pwd=x", "https://zoom.us/j/123?pwd=x"],
      [
        "a Zoom vanity subdomain",
        "https://us02web.zoom.us/j/851?pwd=abc",
        "https://us02web.zoom.us/j/851?pwd=abc",
      ],
      [
        "a Meet link",
        "Meet at https://meet.google.com/abc-defg-hij today",
        "https://meet.google.com/abc-defg-hij",
      ],
      // main's regex runs to the next whitespace, so trailing punctuation stays part
      // of the link. That is kept: it is still an https link with no userinfo.
      [
        "trailing punctuation, kept as main does",
        "(https://zoom.us/j/123).",
        "https://zoom.us/j/123).",
      ],
      // An angle-bracketed link keeps its '>' too; URL normalising percent-encodes
      // it, which is the same URL a browser requests.
      [
        "a trailing '>', kept and encoded",
        "<https://meet.google.com/abc-defg-hij>",
        "https://meet.google.com/abc-defg-hij%3E",
      ],
    ])("lifts %s from the description", async (_label, description, expected) => {
      expect(await linksOf({ description })).toEqual([expected]);
    });

    it("lifts a link from the location too", async () => {
      expect(await linksOf({ location: "https://meet.google.com/abc-defg-hij" })).toEqual([
        "https://meet.google.com/abc-defg-hij",
      ]);
    });

    it.each([
      // The Zoom pattern allows anything between "https://" and "zoom.us/", userinfo included.
      ["a username on a Zoom link", "Join https://evil@zoom.us/j/1"],
      ["a password on a Zoom link", "https://u:p@us02web.zoom.us/j/851?pwd=abc"],
      ["a link over 2048 characters", `https://meet.google.com/${"a".repeat(2048)}`],
    ])("drops %s lifted from the description", async (_label, description) => {
      expect(await linksOf({ description })).toEqual([]);
    });

    it("falls back from an unsafe Zoom match to a valid Meet match", async () => {
      expect(
        await linksOf({
          description: "https://a:b@zoom.us/j/1 or https://meet.google.com/abc-defg-hij",
        }),
      ).toEqual(["https://meet.google.com/abc-defg-hij"]);
    });
  });

  it("records calendar errors instead of swallowing them silently", async () => {
    mockedGetAuthedClient.mockResolvedValue(fakeAuth);
    eventsList.mockRejectedValue(new Error("calendar down"));

    const result = await getUpcomingMeetings("user-1");

    expect(result).toEqual([]);
    expect(mockedCaptureError).toHaveBeenCalledTimes(1);
  });
});
