import { describe, expect, it } from "vitest";
import { parseEvents, parseLine, unescapeText, unfold } from "../pim/caldav/ical.js";

describe("iCalendar parsing", () => {
  describe("unfold", () => {
    it("joins a folded line and eats exactly the one whitespace octet", () => {
      expect(unfold("SUMMARY:Quarterly plan\r\n ning review")).toBe(
        "SUMMARY:Quarterly planning review",
      );
    });

    it("accepts bare LF folding, which real servers send", () => {
      expect(unfold("SUMMARY:one\n two")).toBe("SUMMARY:onetwo");
    });

    it("leaves a genuine line break alone", () => {
      expect(unfold("A:1\r\nB:2")).toBe("A:1\r\nB:2");
    });
  });

  describe("parseLine", () => {
    it("splits name, params and value", () => {
      const line = parseLine("DTSTART;TZID=America/Los_Angeles:20260929T140000");
      expect(line?.name).toBe("DTSTART");
      expect(line?.params.TZID).toBe("America/Los_Angeles");
      expect(line?.value).toBe("20260929T140000");
    });

    it("does not split on a colon inside a quoted parameter", () => {
      // The classic break: a display name containing a colon turns one
      // property into three if the scanner ignores quoting.
      const line = parseLine('ATTENDEE;CN="Doe, John:Jr":mailto:john@example.com');
      expect(line?.name).toBe("ATTENDEE");
      expect(line?.params.CN).toBe("Doe, John:Jr");
      expect(line?.value).toBe("mailto:john@example.com");
    });

    it("returns null for a line with no value separator", () => {
      expect(parseLine("NOT A PROPERTY")).toBeNull();
    });
  });

  describe("unescapeText", () => {
    it("decodes the escapes RFC 5545 defines", () => {
      expect(unescapeText("line1\\nline2\\, and\\; more")).toBe("line1\nline2, and; more");
    });

    it("does not turn an escaped backslash followed by n into a newline", () => {
      // "\\n" is backslash-then-n, not a line break. A chain of .replace()
      // calls gets this wrong; consuming pairs in one pass does not.
      expect(unescapeText("C:\\\\nope")).toBe("C:\\nope");
    });
  });

  describe("parseEvents", () => {
    const ICS = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:evt-1@example.com",
      "SUMMARY:Design review",
      "DTSTART:20260929T140000Z",
      "DTEND:20260929T150000Z",
      "LOCATION:Room 4\\, second floor",
      "ORGANIZER;CN=Ada:mailto:ada@example.com",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com",
      "ATTENDEE:mailto:cy@example.com",
      "STATUS:CONFIRMED",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "SUMMARY:Reminder that must not win",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    it("reads the fields we act on", () => {
      const [event] = parseEvents(ICS);
      expect(event?.uid).toBe("evt-1@example.com");
      expect(event?.summary).toBe("Design review");
      expect(event?.location).toBe("Room 4, second floor");
      expect(event?.organizer).toBe("ada@example.com");
      expect(event?.attendees).toEqual(["bob@example.com", "cy@example.com"]);
      expect(event?.status).toBe("CONFIRMED");
    });

    it("does not let a VALARM's SUMMARY overwrite the event's", () => {
      // The classic bug in a line-by-line reader that ignores nesting.
      expect(parseEvents(ICS)[0]?.summary).toBe("Design review");
    });

    it("converts a UTC stamp to an ISO instant", () => {
      expect(parseEvents(ICS)[0]?.start?.iso).toBe("2026-09-29T14:00:00.000Z");
      expect(parseEvents(ICS)[0]?.start?.isAllDay).toBe(false);
    });

    it("marks an all-day event and keeps its exclusive end", () => {
      const allDay = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:holiday-1",
        "SUMMARY:Public holiday",
        "DTSTART;VALUE=DATE:20261003",
        "DTEND;VALUE=DATE:20261004",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
      const [event] = parseEvents(allDay);
      expect(event?.start?.isAllDay).toBe(true);
      expect(event?.start?.iso).toBe("2026-10-03");
      expect(event?.end?.iso).toBe("2026-10-04");
    });

    it("keeps a TZID local time as local and refuses to invent an instant", () => {
      // Converting this without a tz database would be a guess, and a wrong
      // guess here moves a meeting by hours. The caller decides.
      const local = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:local-1",
        "DTSTART;TZID=Asia/Seoul:20260929T090000",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
      const [event] = parseEvents(local);
      expect(event?.start?.tzid).toBe("Asia/Seoul");
      expect(event?.start?.raw).toBe("20260929T090000");
      expect(event?.start?.iso).toBeUndefined();
    });

    it("carries RRULE through verbatim without expanding it", () => {
      const recurring = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:standup",
        "DTSTART:20260929T090000Z",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
      expect(parseEvents(recurring)[0]?.rrule).toBe("FREQ=WEEKLY;BYDAY=MO,WE,FR");
    });

    it("reads several events from one document", () => {
      const two = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:a",
        "SUMMARY:First",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:b",
        "SUMMARY:Second",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
      expect(parseEvents(two).map((e) => e.summary)).toEqual(["First", "Second"]);
    });

    it("drops an event with no UID rather than inventing one", () => {
      const noUid = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "SUMMARY:Ghost", "END:VEVENT"].join("\r\n");
      expect(parseEvents(noUid)).toHaveLength(0);
    });

    it("survives an empty document", () => {
      expect(parseEvents("")).toEqual([]);
    });

    it("unfolds before parsing, so a folded SUMMARY is not truncated", () => {
      const folded = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:folded-1",
        "SUMMARY:A rather long meeting title that the server ha",
        " s wrapped across lines",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
      expect(parseEvents(folded)[0]?.summary).toBe(
        "A rather long meeting title that the server has wrapped across lines",
      );
    });
  });
});
