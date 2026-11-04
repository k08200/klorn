/**
 * The Google listing the co-attendance pass reads: its own events.list over a
 * PAST window (the row sync lists only upcoming events), asking for nothing but
 * identity, status, times and the attendees' address, self, resource and answer
 * flags. Attendee data lives only in the returned objects, in memory.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ eventsList: vi.fn() }));

vi.mock("googleapis", () => ({
  google: { calendar: () => ({ events: { list: h.eventsList } }) },
}));

import { googleSessionFromClient } from "../pim/calendar-providers/google.js";
import {
  MEETINGS_MAX_PAGES,
  MEETINGS_PAGE_SIZE,
  MEETINGS_TIMEOUT_MS,
} from "../pim/calendar-providers/google-meetings.js";
import { MAX_COUNTED_ATTENDEES } from "../pim/coattendance/coattendance-rules.js";

const WINDOW = { timeMin: "2026-10-02T12:00:00.000Z", timeMax: "2026-11-01T12:00:00.000Z" };

function session() {
  return googleSessionFromClient({} as never);
}

beforeEach(() => {
  h.eventsList.mockReset();
});

describe("Google listMeetingAttendees", () => {
  it("lists the window's expanded default events with only the fields counting needs", async () => {
    h.eventsList.mockResolvedValue({ data: { items: [] } });
    await session().listMeetingAttendees?.(WINDOW);

    expect(h.eventsList).toHaveBeenCalledTimes(1);
    const [params, options] = h.eventsList.mock.calls[0] ?? [];
    expect(params).toEqual({
      calendarId: "primary",
      timeMin: WINDOW.timeMin,
      timeMax: WINDOW.timeMax,
      singleEvents: true,
      orderBy: "startTime",
      eventTypes: ["default"],
      maxAttendees: MAX_COUNTED_ATTENDEES,
      maxResults: MEETINGS_PAGE_SIZE,
      fields:
        "nextPageToken,items(id,iCalUID,status,start,end,originalStartTime,attendeesOmitted,organizer(self),attendees(email,self,organizer,resource,responseStatus))",
    });
    // No summary, description, location or conference data is asked for.
    expect(String(params.fields)).not.toMatch(/summary|description|location|conference/);
    expect(options).toEqual({ timeout: MEETINGS_TIMEOUT_MS, retry: false });
  });

  it("maps an event to identity, status, times and attendee flags", async () => {
    h.eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "evt1",
            iCalUID: "uid-1@google.com",
            status: "confirmed",
            organizer: { self: true },
            start: { dateTime: "2026-10-20T10:00:00+09:00" },
            end: { dateTime: "2026-10-20T11:00:00+09:00" },
            attendees: [
              { email: "me@example.com", self: true, organizer: true, responseStatus: "accepted" },
              { email: "Ana@Client.Example", responseStatus: "tentative" },
              { email: "room@resource.calendar.google.com", resource: true },
            ],
          },
        ],
      },
    });
    const listing = await session().listMeetingAttendees?.(WINDOW);
    expect(listing).toEqual({
      truncated: false,
      lastStart: new Date("2026-10-20T01:00:00.000Z"),
      meetings: [
        {
          identity: "ical:uid-1@google.com|",
          cancelled: false,
          allDay: false,
          startTime: new Date("2026-10-20T01:00:00.000Z"),
          endTime: new Date("2026-10-20T02:00:00.000Z"),
          attendeesOmitted: false,
          organizedBySelf: true,
          attendees: [
            {
              email: "me@example.com",
              self: true,
              organizer: true,
              resource: false,
              responseStatus: "accepted",
            },
            {
              email: "Ana@Client.Example",
              self: false,
              organizer: false,
              resource: false,
              responseStatus: "tentative",
            },
            {
              email: "room@resource.calendar.google.com",
              self: false,
              organizer: false,
              resource: true,
              responseStatus: null,
            },
          ],
        },
      ],
    });
  });

  it("keys a recurring instance by its series iCalUID and original start, as an instant", async () => {
    const instance = (offset: string) => ({
      id: "series_20261020T010000Z",
      iCalUID: "series@google.com",
      start: { dateTime: `2026-10-20T10:00:00${offset}` },
      end: { dateTime: `2026-10-20T11:00:00${offset}` },
      originalStartTime: {
        dateTime: offset === "+09:00" ? "2026-10-20T10:00:00+09:00" : "2026-10-20T01:00:00Z",
      },
    });
    h.eventsList.mockResolvedValueOnce({ data: { items: [instance("+09:00")] } });
    h.eventsList.mockResolvedValueOnce({ data: { items: [instance("Z")] } });
    const seoul = await session().listMeetingAttendees?.(WINDOW);
    const utc = await session().listMeetingAttendees?.(WINDOW);
    // Rendered in two zones (two accounts, or a changed user zone), it is one instance.
    expect(seoul?.meetings[0]?.identity).toBe("ical:series@google.com|2026-10-20T01:00:00.000Z");
    expect(utc?.meetings[0]?.identity).toBe(seoul?.meetings[0]?.identity);
  });

  it("falls back to the event id without an iCalUID, and to no identity without either", async () => {
    h.eventsList.mockResolvedValue({
      data: {
        items: [
          { id: "evt2", start: { dateTime: "2026-10-20T10:00:00Z" } },
          { start: { dateTime: "2026-10-20T10:00:00Z" } },
        ],
      },
    });
    const listing = await session().listMeetingAttendees?.(WINDOW);
    expect(listing?.meetings.map((m) => m.identity)).toEqual(["id:evt2", ""]);
  });

  it("reports cancelled, all-day, omitted-guest and unparseable events as such", async () => {
    h.eventsList.mockResolvedValue({
      data: {
        items: [
          { id: "a", status: "cancelled", start: { dateTime: "2026-10-20T10:00:00Z" } },
          { id: "b", start: { date: "2026-10-20" }, end: { date: "2026-10-21" } },
          { id: "c", attendeesOmitted: true, start: { dateTime: "nope" }, end: {} },
        ],
      },
    });
    const listing = await session().listMeetingAttendees?.(WINDOW);
    expect(listing?.meetings.map((m) => [m.cancelled, m.allDay, m.attendeesOmitted])).toEqual([
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ]);
    expect(listing?.meetings[2]?.startTime).toBeNull();
    expect(listing?.meetings[2]?.endTime).toBeNull();
    expect(listing?.meetings[2]?.attendees).toEqual([]);
    // No organizer, or one that is not the calendar owner: not organised by the user.
    expect(listing?.meetings.map((m) => m.organizedBySelf)).toEqual([false, false, false]);
  });

  it("follows page tokens and reports a listing cut at the page cap as truncated", async () => {
    h.eventsList.mockResolvedValueOnce({ data: { items: [{ id: "p1" }], nextPageToken: "t1" } });
    h.eventsList.mockResolvedValueOnce({ data: { items: [{ id: "p2" }] } });
    const complete = await session().listMeetingAttendees?.(WINDOW);
    expect(complete?.truncated).toBe(false);
    expect(complete?.meetings.map((m) => m.identity)).toEqual(["id:p1", "id:p2"]);
    expect(h.eventsList.mock.calls[1]?.[0]).toMatchObject({ pageToken: "t1" });

    h.eventsList.mockReset();
    h.eventsList.mockResolvedValue({ data: { items: [{ id: "p" }], nextPageToken: "more" } });
    const cut = await session().listMeetingAttendees?.(WINDOW);
    expect(h.eventsList).toHaveBeenCalledTimes(MEETINGS_MAX_PAGES);
    expect(cut?.truncated).toBe(true);
  });

  it("reports where a cut listing stopped: the last item's start, conservatively for a date", async () => {
    h.eventsList.mockResolvedValueOnce({
      data: {
        items: [
          { id: "a", start: { dateTime: "2026-10-20T10:00:00+09:00" } },
          { id: "b", start: { date: "2026-10-21" } },
        ],
      },
    });
    // A date has no zone here: read it 14 hours early (the furthest UTC offset), so
    // the caller never treats a day as fully listed when it was not.
    expect((await session().listMeetingAttendees?.(WINDOW))?.lastStart).toEqual(
      new Date("2026-10-20T10:00:00.000Z"),
    );
    h.eventsList.mockResolvedValueOnce({ data: { items: [] } });
    expect((await session().listMeetingAttendees?.(WINDOW))?.lastStart).toBeNull();
  });

  it("throws a listing failure to the caller", async () => {
    h.eventsList.mockRejectedValue(new Error("403 insufficient permissions"));
    await expect(session().listMeetingAttendees?.(WINDOW)).rejects.toThrow("403");
  });
});
