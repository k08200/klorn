/**
 * C2b, the Google half: the events.list call carries showDeleted ONLY when the
 * caller asks for cancelled events (the sync does, the readers never do), and an
 * item Google marks status "cancelled" comes back flagged, even when it carries
 * nothing but its id. Semantics: developers.google.com/workspace/calendar/api/v3/reference/events/list
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ eventsList: vi.fn(), googleCalendar: vi.fn() }));

vi.mock("googleapis", () => ({
  google: {
    calendar: m.googleCalendar.mockImplementation(() => ({ events: { list: m.eventsList } })),
  },
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  buildLinkedCalendarClient: vi.fn(),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { googleSessionFromClient } from "../pim/calendar-providers/google.js";

const AUTH = { tag: "auth" } as unknown as Parameters<typeof googleSessionFromClient>[0];
const QUERY = {
  timeMin: "2026-09-30T05:00:00.000Z",
  timeMax: "2026-10-30T05:00:00.000Z",
  maxResults: 100,
  timeZone: "Asia/Seoul",
};

beforeEach(() => {
  vi.clearAllMocks();
  m.eventsList.mockResolvedValue({ data: { items: [] } });
});

describe("GOOGLE listEvents and cancelled events", () => {
  it("sends showDeleted: true with the otherwise unchanged sync request when asked for cancelled events", async () => {
    await googleSessionFromClient(AUTH).listEvents({ ...QUERY, includeCancelled: true });

    expect(m.eventsList).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: "2026-09-30T05:00:00.000Z",
      timeMax: "2026-10-30T05:00:00.000Z",
      singleEvents: true,
      showDeleted: true,
      orderBy: "startTime",
      maxResults: 100,
      timeZone: "Asia/Seoul",
    });
  });

  it("sends no showDeleted at all for a reader that did not ask", async () => {
    await googleSessionFromClient(AUTH).listEvents(QUERY);

    expect(m.eventsList).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: "2026-09-30T05:00:00.000Z",
      timeMax: "2026-10-30T05:00:00.000Z",
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 100,
      timeZone: "Asia/Seoul",
    });
  });

  it("does not send showDeleted when includeCancelled is explicitly false", async () => {
    await googleSessionFromClient(AUTH).listEvents({ ...QUERY, includeCancelled: false });

    expect(m.eventsList.mock.calls[0]?.[0]).not.toHaveProperty("showDeleted");
  });

  it("flags a status-cancelled item, even one that carries only its id", async () => {
    m.eventsList.mockResolvedValue({
      data: {
        items: [
          { id: "g-gone", status: "cancelled" },
          {
            id: "standup_20261005T000000Z",
            status: "cancelled",
            recurringEventId: "standup",
            originalStartTime: { dateTime: "2026-10-05T09:00:00+09:00" },
          },
        ],
      },
    });

    const events = await googleSessionFromClient(AUTH).listEvents({
      ...QUERY,
      includeCancelled: true,
    });

    expect(events.map((e) => [e.externalId, e.cancelled])).toEqual([
      ["g-gone", true],
      ["standup_20261005T000000Z", true],
    ]);
  });

  it("leaves confirmed and tentative items unflagged", async () => {
    m.eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "g-ok",
            status: "confirmed",
            summary: "Planning",
            start: { dateTime: "2026-10-02T09:00:00+09:00" },
            end: { dateTime: "2026-10-02T10:00:00+09:00" },
          },
          { id: "g-maybe", status: "tentative" },
        ],
      },
    });

    const events = await googleSessionFromClient(AUTH).listEvents({
      ...QUERY,
      includeCancelled: true,
    });

    expect(events.map((e) => e.cancelled)).toEqual([undefined, undefined]);
  });
});
