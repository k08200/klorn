/**
 * C2b, the Google half. The sync's own events.list call is exactly what it was
 * (no showDeleted: cancelled events would spend its 100-event cap and push live
 * events out of the window). Cancellations come from a SEPARATE events.list
 * with showDeleted + updatedMin, paged up to a cap, that keeps only items Google
 * marks status "cancelled" and needs nothing but their id.
 *
 * Semantics: developers.google.com/workspace/calendar/api/v3/reference/events/list
 * (showDeleted; updatedMin: "entries deleted since this time will always be
 * included regardless of showDeleted") and .../reference/events (status).
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

import {
  CANCELLED_SCAN_MAX_PAGES,
  CANCELLED_SCAN_PAGE_SIZE,
  googleSessionFromClient,
} from "../pim/calendar-providers/google.js";

const AUTH = { tag: "auth" } as unknown as Parameters<typeof googleSessionFromClient>[0];
const QUERY = {
  timeMin: "2026-09-30T05:00:00.000Z",
  timeMax: "2026-10-30T05:00:00.000Z",
  maxResults: 100,
  timeZone: "Asia/Seoul",
};
const SCAN = {
  timeMin: "2026-09-30T05:00:00.000Z",
  timeMax: "2026-10-30T05:00:00.000Z",
  updatedMin: "2026-09-23T05:00:00.000Z",
};

function session() {
  const s = googleSessionFromClient(AUTH);
  if (!s.listCancelledEvents) throw new Error("the Google session must expose listCancelledEvents");
  return { ...s, listCancelledEvents: s.listCancelledEvents };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.eventsList.mockResolvedValue({ data: { items: [] } });
});

describe("GOOGLE listEvents (the sync's upsert call)", () => {
  it("sends the same request as before C2b: no showDeleted, no updatedMin", async () => {
    await googleSessionFromClient(AUTH).listEvents(QUERY);

    expect(m.eventsList).toHaveBeenCalledTimes(1);
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

  it("does not add a cancelled flag to an event's shape", async () => {
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
        ],
      },
    });

    const [event] = await googleSessionFromClient(AUTH).listEvents(QUERY);

    expect(event).not.toHaveProperty("cancelled");
  });
});

describe("GOOGLE listCancelledEvents (the separate cancellation call)", () => {
  it("asks for deleted events changed since updatedMin, in the sync window, and nothing more", async () => {
    await session().listCancelledEvents(SCAN);

    expect(m.eventsList).toHaveBeenCalledTimes(1);
    expect(m.eventsList).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: "2026-09-30T05:00:00.000Z",
      timeMax: "2026-10-30T05:00:00.000Z",
      updatedMin: "2026-09-23T05:00:00.000Z",
      singleEvents: true,
      showDeleted: true,
      maxResults: CANCELLED_SCAN_PAGE_SIZE,
      fields: "nextPageToken,items(id,status)",
    });
  });

  it("keeps only status-cancelled items, and needs nothing but their id", async () => {
    m.eventsList.mockResolvedValue({
      data: {
        items: [
          { id: "g-gone", status: "cancelled" },
          { id: "standup_20261005T000000Z", status: "cancelled" },
          { id: "g-live", status: "confirmed" },
          { id: "g-maybe", status: "tentative" },
          { id: "g-no-status" },
          { status: "cancelled" },
        ],
      },
    });

    const result = await session().listCancelledEvents(SCAN);

    expect(result).toEqual({
      externalIds: ["g-gone", "standup_20261005T000000Z"],
      truncated: false,
    });
  });

  it("follows nextPageToken and joins the pages", async () => {
    m.eventsList
      .mockResolvedValueOnce({
        data: { items: [{ id: "a", status: "cancelled" }], nextPageToken: "tok-2" },
      })
      .mockResolvedValueOnce({ data: { items: [{ id: "b", status: "cancelled" }] } });

    const result = await session().listCancelledEvents(SCAN);

    expect(m.eventsList).toHaveBeenCalledTimes(2);
    expect(m.eventsList.mock.calls[0]?.[0]).not.toHaveProperty("pageToken");
    expect(m.eventsList.mock.calls[1]?.[0]).toMatchObject({
      pageToken: "tok-2",
      showDeleted: true,
    });
    expect(result).toEqual({ externalIds: ["a", "b"], truncated: false });
  });

  it("stops at the page cap and reports truncation", async () => {
    m.eventsList.mockImplementation(async () => ({
      data: { items: [{ id: "x", status: "cancelled" }], nextPageToken: "more" },
    }));

    const result = await session().listCancelledEvents(SCAN);

    expect(m.eventsList).toHaveBeenCalledTimes(CANCELLED_SCAN_MAX_PAGES);
    expect(result.truncated).toBe(true);
    expect(result.externalIds).toHaveLength(CANCELLED_SCAN_MAX_PAGES);
  });

  it("is not truncated when the last allowed page is also the last page", async () => {
    let page = 0;
    m.eventsList.mockImplementation(async () => {
      page += 1;
      return {
        data: {
          items: [{ id: `p${page}`, status: "cancelled" }],
          ...(page < CANCELLED_SCAN_MAX_PAGES ? { nextPageToken: `t${page}` } : {}),
        },
      };
    });

    const result = await session().listCancelledEvents(SCAN);

    expect(m.eventsList).toHaveBeenCalledTimes(CANCELLED_SCAN_MAX_PAGES);
    expect(result.truncated).toBe(false);
  });

  it("lets a Google failure reach the caller, which owns the policy", async () => {
    m.eventsList.mockRejectedValue(new Error("quota"));

    await expect(session().listCancelledEvents(SCAN)).rejects.toThrow("quota");
  });
});
