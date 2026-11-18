import { describe, expect, it } from "vitest";
import { googleAttendeeCount } from "../pim/calendar-providers/google.js";
import { syncRowFields } from "../pim/calendar-sync.js";

describe("CalendarEvent.attendeeCount (NT0 meet: '· 3명')", () => {
  it("counts listed people, without resources and those who declined", () => {
    expect(
      googleAttendeeCount({
        attendees: [
          { email: "me@x.com", self: true, responseStatus: "accepted" },
          { email: "a@x.com", organizer: true, responseStatus: "accepted" },
          { email: "b@x.com", responseStatus: "needsAction" },
          { email: "room@resource.calendar.google.com", resource: true },
          { email: "c@x.com", responseStatus: "declined" },
        ],
      }),
    ).toBe(3);
  });

  it("is null for a solo event or an omitted guest list", () => {
    expect(googleAttendeeCount({})).toBeNull();
    expect(googleAttendeeCount({ attendees: [] })).toBeNull();
    expect(
      googleAttendeeCount({ attendeesOmitted: true, attendees: [{ email: "me@x.com" }] }),
    ).toBeNull();
  });

  it("reaches the synced row only when the provider reports it", () => {
    const base = {
      externalId: "e1",
      summary: "Design review",
      description: null,
      location: null,
      meetingLink: null,
      start: "2026-11-18T10:00:00+09:00",
      end: "2026-11-18T11:00:00+09:00",
      allDay: false,
      startTime: new Date("2026-11-18T01:00:00Z"),
      endTime: new Date("2026-11-18T02:00:00Z"),
    };
    expect(syncRowFields({ ...base, attendeeCount: 3 })?.attendeeCount).toBe(3);
    expect(syncRowFields({ ...base, attendeeCount: null })).toHaveProperty("attendeeCount", null);
    expect(syncRowFields(base)).not.toHaveProperty("attendeeCount");
  });
});
