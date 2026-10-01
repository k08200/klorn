/**
 * C2b, the Google half. The sync's own events.list call is exactly what it was
 * (no showDeleted: cancelled events would spend its 100-event cap and push live
 * events out of the window). Cancellations come from a SEPARATE events.list:
 * showDeleted + updatedMin, singleEvents false and NO timeMin/timeMax (so a time
 * filter cannot drop a cancelled event that has no start, and no recurring
 * expansion fills the page cap), ordered by `updated`, paged up to a cap, with a
 * bounded wait. It keeps only items Google marks status "cancelled" and needs
 * nothing but their id.
 *
 * Semantics: developers.google.com/workspace/calendar/api/v3/reference/events/list
 * (showDeleted; singleEvents; orderBy "updated"; updatedMin: "entries deleted
 * since this time will always be included regardless of showDeleted") and
 * .../reference/events (status: a deleted event is only guaranteed to carry its id).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CANCELLED_SCAN_OPTIONS, cancelledScanRequest } from "./helpers/google-cancelled-scan.js";

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
  CANCELLED_SCAN_TIMEOUT_MS,
  googleSessionFromClient,
} from "../pim/calendar-providers/google.js";

const AUTH = { tag: "auth" } as unknown as Parameters<typeof googleSessionFromClient>[0];
const QUERY = {
  timeMin: "2026-09-30T05:00:00.000Z",
  timeMax: "2026-10-30T05:00:00.000Z",
  maxResults: 100,
  timeZone: "Asia/Seoul",
};
const UPDATED_MIN = "2026-09-23T05:00:00.000Z";

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
  it("asks for deleted events changed since updatedMin: no time window, no recurring expansion", async () => {
    await session().listCancelledEvents({ updatedMin: UPDATED_MIN });

    expect(m.eventsList).toHaveBeenCalledTimes(1);
    expect(m.eventsList.mock.calls[0]?.[0]).toStrictEqual(cancelledScanRequest(UPDATED_MIN));
    expect(m.eventsList.mock.calls[0]?.[0]).not.toHaveProperty("timeMin");
    expect(m.eventsList.mock.calls[0]?.[0]).not.toHaveProperty("timeMax");
  });

  it("bounds the wait: a named timeout and no retries on every page", async () => {
    m.eventsList
      .mockResolvedValueOnce({ data: { items: [], nextPageToken: "tok-2" } })
      .mockResolvedValueOnce({ data: { items: [] } });

    await session().listCancelledEvents({ updatedMin: UPDATED_MIN });

    expect(CANCELLED_SCAN_TIMEOUT_MS).toBe(10_000);
    expect(m.eventsList.mock.calls.map((c) => c[1])).toStrictEqual([
      CANCELLED_SCAN_OPTIONS,
      CANCELLED_SCAN_OPTIONS,
    ]);
  });

  it("keeps only status-cancelled items, and needs nothing but their id", async () => {
    m.eventsList.mockResolvedValue({
      data: {
        items: [
          { id: "g-gone", status: "cancelled" },
          { id: "g-live", status: "confirmed", updated: "2026-09-30T04:00:00.000Z" },
          { id: "g-maybe", status: "tentative" },
          { id: "g-no-status" },
          { status: "cancelled" },
        ],
      },
    });

    const result = await session().listCancelledEvents({ updatedMin: UPDATED_MIN });

    expect(result.externalIds).toEqual(["g-gone"]);
    expect(result.truncated).toBe(false);
  });

  it("tells a cancelled instance (it has a recurringEventId) from a cancelled event or series (it has none)", async () => {
    m.eventsList.mockResolvedValue({
      data: {
        items: [
          { id: "standup_20261005T000000Z", status: "cancelled", recurringEventId: "standup" },
          { id: "standup", status: "cancelled" },
          { id: "lunch", status: "cancelled" },
        ],
      },
    });

    const result = await session().listCancelledEvents({ updatedMin: UPDATED_MIN });

    expect(result.externalIds).toEqual(["standup_20261005T000000Z", "standup", "lunch"]);
    expect(result.seriesIds).toEqual(["standup", "lunch"]);
  });

  describe("the latest status of an id wins within one scan", () => {
    const onPages = (...pages: unknown[][]) => {
      pages.forEach((items, index) => {
        m.eventsList.mockResolvedValueOnce({
          data: { items, ...(index < pages.length - 1 ? { nextPageToken: `t${index}` } : {}) },
        });
      });
    };

    it("an event cancelled on one page and restored on a later one is not reported", async () => {
      onPages(
        [{ id: "g-1", status: "cancelled", updated: "2026-09-30T04:00:01.000Z" }],
        [{ id: "g-1", status: "confirmed", updated: "2026-09-30T04:00:09.000Z" }],
      );

      const result = await session().listCancelledEvents({ updatedMin: UPDATED_MIN });

      expect(result.externalIds).toEqual([]);
      expect(result.seriesIds).toEqual([]);
    });

    it("a series cancelled on one page and restored on a later one is not reported as a series", async () => {
      onPages(
        [{ id: "standup", status: "cancelled", updated: "2026-09-30T04:00:01.000Z" }],
        [{ id: "standup", status: "confirmed", updated: "2026-09-30T04:00:09.000Z" }],
      );

      const result = await session().listCancelledEvents({ updatedMin: UPDATED_MIN });

      expect(result.externalIds).toEqual([]);
      expect(result.seriesIds).toEqual([]);
    });

    it("an event restored and then cancelled again is reported", async () => {
      onPages(
        [{ id: "g-1", status: "confirmed", updated: "2026-09-30T04:00:01.000Z" }],
        [{ id: "g-1", status: "cancelled", updated: "2026-09-30T04:00:09.000Z" }],
      );

      const result = await session().listCancelledEvents({ updatedMin: UPDATED_MIN });

      expect(result.externalIds).toEqual(["g-1"]);
      expect(result.seriesIds).toEqual(["g-1"]);
    });

    it("an older item that arrives later does not override a newer status", async () => {
      onPages(
        [{ id: "g-1", status: "cancelled", updated: "2026-09-30T04:00:09.000Z" }],
        [{ id: "g-1", status: "confirmed", updated: "2026-09-30T04:00:01.000Z" }],
      );

      const result = await session().listCancelledEvents({ updatedMin: UPDATED_MIN });

      expect(result.externalIds).toEqual(["g-1"]);
    });

    it("keeps first-seen order and judges each id on its own", async () => {
      onPages(
        [
          { id: "a", status: "cancelled", updated: "2026-09-30T04:00:01.000Z" },
          { id: "b", status: "cancelled", updated: "2026-09-30T04:00:02.000Z" },
        ],
        [{ id: "a", status: "confirmed", updated: "2026-09-30T04:00:03.000Z" }],
      );

      const result = await session().listCancelledEvents({ updatedMin: UPDATED_MIN });

      expect(result.externalIds).toEqual(["b"]);
    });
  });

  it("follows nextPageToken and joins the pages", async () => {
    m.eventsList
      .mockResolvedValueOnce({
        data: { items: [{ id: "a", status: "cancelled" }], nextPageToken: "tok-2" },
      })
      .mockResolvedValueOnce({ data: { items: [{ id: "b", status: "cancelled" }] } });

    const result = await session().listCancelledEvents({ updatedMin: UPDATED_MIN });

    expect(m.eventsList).toHaveBeenCalledTimes(2);
    expect(m.eventsList.mock.calls[1]?.[0]).toStrictEqual(
      cancelledScanRequest(UPDATED_MIN, "tok-2"),
    );
    expect(result).toEqual({
      externalIds: ["a", "b"],
      seriesIds: ["a", "b"],
      truncated: false,
      resumeUpdatedMin: null,
    });
  });

  it("stops at the page cap, reports truncation, and names where to resume: the last event's updated", async () => {
    let page = 0;
    m.eventsList.mockImplementation(async () => {
      page += 1;
      return {
        data: {
          items: [
            { id: `live-${page}`, status: "confirmed", updated: `2026-09-30T04:0${page}:00.000Z` },
            { id: `gone-${page}`, status: "cancelled", updated: `2026-09-30T04:0${page}:30.000Z` },
          ],
          nextPageToken: "more",
        },
      };
    });

    const result = await session().listCancelledEvents({ updatedMin: UPDATED_MIN });

    expect(m.eventsList).toHaveBeenCalledTimes(CANCELLED_SCAN_MAX_PAGES);
    expect(result.truncated).toBe(true);
    expect(result.externalIds).toHaveLength(CANCELLED_SCAN_MAX_PAGES);
    expect(result.resumeUpdatedMin).toBe(`2026-09-30T04:0${CANCELLED_SCAN_MAX_PAGES}:30.000Z`);
  });

  it("has nothing to resume from when a truncated scan carried no updated at all", async () => {
    m.eventsList.mockImplementation(async () => ({
      data: { items: [{ id: "x", status: "cancelled" }], nextPageToken: "more" },
    }));

    const result = await session().listCancelledEvents({ updatedMin: UPDATED_MIN });

    expect(result.truncated).toBe(true);
    expect(result.resumeUpdatedMin).toBeNull();
  });

  it("is not truncated when the last allowed page is also the last page", async () => {
    let page = 0;
    m.eventsList.mockImplementation(async () => {
      page += 1;
      return {
        data: {
          items: [{ id: `p${page}`, status: "cancelled", updated: "2026-09-30T04:00:00.000Z" }],
          ...(page < CANCELLED_SCAN_MAX_PAGES ? { nextPageToken: `t${page}` } : {}),
        },
      };
    });

    const result = await session().listCancelledEvents({ updatedMin: UPDATED_MIN });

    expect(m.eventsList).toHaveBeenCalledTimes(CANCELLED_SCAN_MAX_PAGES);
    expect(result.truncated).toBe(false);
    expect(result.resumeUpdatedMin).toBeNull();
  });

  it("reads a full page size per request", () => {
    expect(CANCELLED_SCAN_PAGE_SIZE).toBe(250);
  });

  it("lets a Google failure reach the caller, which owns the policy", async () => {
    m.eventsList.mockRejectedValue(new Error("quota"));

    await expect(session().listCancelledEvents({ updatedMin: UPDATED_MIN })).rejects.toThrow(
      "quota",
    );
  });
});
