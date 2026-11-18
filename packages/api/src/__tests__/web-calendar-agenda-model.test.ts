// Pins packages/web/src/app/calendar/agenda-model.ts — the phone calendar's
// day agenda (mobile redesign PR5). The web package has no unit-test runner,
// so its import-free model is exercised from here.
import { describe, expect, it } from "vitest";
import {
  dateForKey,
  dayAgenda,
  meetingProviderName,
  monthStartForKey,
  shiftDayKey,
  timedCount,
} from "../../../web/src/app/calendar/agenda-model";

describe("shiftDayKey", () => {
  it("moves by calendar days across month and year ends", () => {
    expect(shiftDayKey("2026-11-18", 1)).toBe("2026-11-19");
    expect(shiftDayKey("2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftDayKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDayKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDayKey("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("leaves a malformed key alone", () => {
    expect(shiftDayKey("not-a-day", 1)).toBe("not-a-day");
  });
});

describe("monthStartForKey / dateForKey", () => {
  it("reads the month off the key, day 1 at noon UTC", () => {
    expect(monthStartForKey("2026-11-30")?.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(monthStartForKey("2027-01-01")?.toISOString()).toBe("2027-01-01T12:00:00.000Z");
    expect(monthStartForKey("bad")).toBeNull();
  });

  it("formats in UTC to the same calendar day", () => {
    const date = dateForKey("2026-11-18");
    expect(date?.toISOString()).toBe("2026-11-18T12:00:00.000Z");
    expect(
      new Intl.DateTimeFormat("en", { timeZone: "UTC", day: "numeric" }).format(date as Date),
    ).toBe("18");
    expect(dateForKey("2026-1-1")).toBeNull();
  });
});

describe("dayAgenda", () => {
  const events = [
    { id: "late", startTime: "2026-11-18T15:00:00+09:00", allDay: false },
    { id: "all-day", startTime: "2026-11-18T00:00:00+09:00", allDay: true },
    { id: "early", startTime: "2026-11-18T10:00:00+09:00", allDay: false },
    { id: "broken", startTime: "nope", allDay: false },
  ];

  it("puts all-day events first, then timed ones by start, unparseable last", () => {
    expect(dayAgenda(events).map((e) => e.id)).toEqual(["all-day", "early", "late", "broken"]);
  });

  it("does not reorder its input", () => {
    dayAgenda(events);
    expect(events.map((e) => e.id)).toEqual(["late", "all-day", "early", "broken"]);
  });

  it("counts timed events as meetings", () => {
    expect(timedCount(events)).toBe(3);
    expect(timedCount([])).toBe(0);
  });
});

describe("meetingProviderName", () => {
  it.each([
    ["https://meet.google.com/abc-defg-hij", "Google Meet"],
    ["https://us02web.zoom.us/j/123", "Zoom"],
    ["https://teams.microsoft.com/l/meetup-join/x", "Microsoft Teams"],
    ["https://acme.webex.com/meet/x", "Webex"],
    ["https://www.example.org/room", "example.org"],
  ])("names %s", (href, name) => {
    expect(meetingProviderName(href)).toBe(name);
  });

  it("does not match a host that only ends with a provider's name", () => {
    expect(meetingProviderName("https://evilzoom.us/j/1")).toBe("evilzoom.us");
  });

  it("is null without a link", () => {
    expect(meetingProviderName(null)).toBeNull();
    expect(meetingProviderName("::")).toBeNull();
  });
});
