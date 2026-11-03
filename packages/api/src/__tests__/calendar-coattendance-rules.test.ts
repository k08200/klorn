/**
 * Which ended meetings count toward per-contact co-attendance, and for whom
 * (founder decision 2026-11-01: counts only, never attendee lists). Pure rules:
 * the store and the sync are tested in calendar-coattendance-sync.test.ts.
 */

import { describe, expect, it } from "vitest";
import type { MeetingAttendee, ProviderMeeting } from "../pim/calendar-providers/types.js";
import {
  countMeeting,
  MAX_COUNTED_ATTENDEES,
  normalizeAttendeeEmail,
  SMALL_MEETING_MAX_PEOPLE,
} from "../pim/coattendance/coattendance-rules.js";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const OWN = new Set(["me@example.com", "me@work.example"]);

function person(email: string, responseStatus = "accepted", extra = {}): MeetingAttendee {
  return { email, self: false, organizer: false, resource: false, responseStatus, ...extra };
}

const me = (responseStatus = "accepted"): MeetingAttendee =>
  person("me@example.com", responseStatus, { self: true });

function meeting(overrides: Partial<ProviderMeeting> = {}): ProviderMeeting {
  return {
    identity: "ical:abc@google.com|",
    cancelled: false,
    allDay: false,
    startTime: new Date("2026-11-01T09:00:00.000Z"),
    endTime: new Date("2026-11-01T10:00:00.000Z"),
    attendeesOmitted: false,
    organizedBySelf: false,
    attendees: [me(), person("ana@client.example")],
    ...overrides,
  };
}

describe("countMeeting: what counts", () => {
  it("counts an ended meeting for the other attendees, as a small meeting", () => {
    expect(countMeeting(meeting(), OWN, NOW)).toEqual({
      identity: "ical:abc@google.com|",
      startTime: new Date("2026-11-01T09:00:00.000Z"),
      endTime: new Date("2026-11-01T10:00:00.000Z"),
      contacts: ["ana@client.example"],
      small: true,
    });
  });

  it("counts a meeting that ended exactly now, and not one still running", () => {
    expect(countMeeting(meeting({ endTime: NOW }), OWN, NOW)).not.toBeNull();
    const running = meeting({ endTime: new Date(NOW.getTime() + 1) });
    expect(countMeeting(running, OWN, NOW)).toBeNull();
  });

  it("does not count a cancelled meeting", () => {
    expect(countMeeting(meeting({ cancelled: true }), OWN, NOW)).toBeNull();
  });

  it("does not count an all-day event", () => {
    expect(countMeeting(meeting({ allDay: true }), OWN, NOW)).toBeNull();
  });

  it("does not count an event without usable times or identity", () => {
    expect(countMeeting(meeting({ startTime: null }), OWN, NOW)).toBeNull();
    expect(countMeeting(meeting({ endTime: null }), OWN, NOW)).toBeNull();
    expect(countMeeting(meeting({ identity: "" }), OWN, NOW)).toBeNull();
  });

  it("does not count a meeting the user declined", () => {
    const declined = meeting({ attendees: [me("declined"), person("ana@client.example")] });
    expect(countMeeting(declined, OWN, NOW)).toBeNull();
  });

  it("counts when the user declined on one address but not on another", () => {
    const attendees = [
      me("declined"),
      person("ME@work.example", "accepted"),
      person("ana@client.example"),
    ];
    expect(countMeeting(meeting({ attendees }), OWN, NOW)?.contacts).toEqual([
      "ana@client.example",
    ]);
  });

  it("counts a contact's tentative or unanswered invitation: few guests answer", () => {
    const attendees = [
      me(),
      person("ana@client.example", "tentative"),
      person("bo@client.example", "needsAction"),
    ];
    expect(countMeeting(meeting({ attendees }), OWN, NOW)?.contacts).toEqual([
      "ana@client.example",
      "bo@client.example",
    ]);
  });

  it("counts only a meeting the user accepted, held tentatively, or organised", () => {
    const withMe = (entry: MeetingAttendee) =>
      meeting({ attendees: [entry, person("ana@x.example")] });
    expect(countMeeting(withMe(me("tentative")), OWN, NOW)).not.toBeNull();
    expect(
      countMeeting(withMe({ ...me("needsAction"), organizer: true }), OWN, NOW),
    ).not.toBeNull();
    // An invitation the user never answered: anyone can put one on a calendar
    // (Google adds invitations from anyone by default), so it is no evidence of a
    // meeting and must not let a stranger raise a count.
    expect(countMeeting(withMe(me("needsAction")), OWN, NOW)).toBeNull();
    expect(countMeeting(withMe(me("")), OWN, NOW)).toBeNull();
    expect(countMeeting(withMe({ ...me(), responseStatus: null }), OWN, NOW)).toBeNull();
  });

  it("leaves out a contact who declined", () => {
    const attendees = [me(), person("ana@client.example", "declined"), person("bo@client.example")];
    expect(countMeeting(meeting({ attendees }), OWN, NOW)?.contacts).toEqual(["bo@client.example"]);
  });

  it("counts nothing when every other attendee declined", () => {
    const attendees = [me(), person("ana@client.example", "declined")];
    expect(countMeeting(meeting({ attendees }), OWN, NOW)).toBeNull();
  });

  it("never counts a room or other resource", () => {
    const room = person("room-4f@resource.calendar.google.com", "accepted", { resource: true });
    const attendees = [me(), room, person("ana@client.example")];
    expect(countMeeting(meeting({ attendees }), OWN, NOW)?.contacts).toEqual([
      "ana@client.example",
    ]);
    expect(countMeeting(meeting({ attendees: [me(), room] }), OWN, NOW)).toBeNull();
  });

  it("never counts the user's own entry or any of the user's addresses", () => {
    const attendees = [me(), person(" Me@Work.Example "), person("ana@client.example")];
    expect(countMeeting(meeting({ attendees }), OWN, NOW)?.contacts).toEqual([
      "ana@client.example",
    ]);
    // The calendar owner's entry is the user's, even under an address Klorn does not know.
    const other = [
      person("alias@else.example", "accepted", { self: true }),
      person("bo@x.example"),
    ];
    expect(countMeeting(meeting({ attendees: other }), OWN, NOW)?.contacts).toEqual([
      "bo@x.example",
    ]);
  });

  it("counts a meeting the user organised without adding themselves", () => {
    const attendees = [person("ana@client.example"), person("bo@client.example")];
    expect(countMeeting(meeting({ attendees, organizedBySelf: true }), OWN, NOW)?.contacts).toEqual(
      ["ana@client.example", "bo@client.example"],
    );
  });

  it("counts nothing from an event without the user's entry that they did not organise", () => {
    // An imported .ics or an event a stranger put on the calendar: no evidence the
    // user took part, whoever it lists.
    const attendees = [person("ana@client.example"), person("bo@client.example")];
    expect(countMeeting(meeting({ attendees, organizedBySelf: false }), OWN, NOW)).toBeNull();
  });

  it("never lists one of the user's aliases as a contact, whatever it answered", () => {
    const attendees = [
      person("ME@work.example", "accepted"),
      person("me@example.com", "needsAction"),
      person("ana@client.example"),
    ];
    // No `self` entry: the alias that accepted is the user's entry, not a contact.
    expect(countMeeting(meeting({ attendees }), OWN, NOW)?.contacts).toEqual([
      "ana@client.example",
    ]);
  });

  it("normalises contact addresses and counts each one once", () => {
    const attendees = [me(), person(" Ana@Client.Example "), person("ana@client.example")];
    expect(countMeeting(meeting({ attendees }), OWN, NOW)?.contacts).toEqual([
      "ana@client.example",
    ]);
  });

  it("drops an attendee with no usable address", () => {
    const attendees = [me(), person(""), person("not an address"), person("ana@client.example")];
    expect(countMeeting(meeting({ attendees }), OWN, NOW)?.contacts).toEqual([
      "ana@client.example",
    ]);
  });
});

describe("countMeeting: audience size", () => {
  const others = (n: number) => Array.from({ length: n }, (_, i) => person(`p${i}@x.example`));

  it("calls a meeting small when the user and at most four others attended", () => {
    expect(SMALL_MEETING_MAX_PEOPLE).toBe(5);
    expect(countMeeting(meeting({ attendees: [me(), ...others(4)] }), OWN, NOW)?.small).toBe(true);
    expect(countMeeting(meeting({ attendees: [me(), ...others(5)] }), OWN, NOW)?.small).toBe(false);
  });

  it("sizes the audience by who did not decline, not by who was invited", () => {
    const attendees = [me(), ...others(4), person("gone@x.example", "declined")];
    expect(countMeeting(meeting({ attendees }), OWN, NOW)?.small).toBe(true);
  });

  it("does not let rooms make a meeting large", () => {
    const rooms = [1, 2, 3].map((i) =>
      person(`room${i}@resource.calendar.google.com`, "accepted", { resource: true }),
    );
    const attendees = [me(), ...others(2), ...rooms];
    expect(countMeeting(meeting({ attendees }), OWN, NOW)?.small).toBe(true);
  });

  it("counts a large meeting, but never a small one, up to the cap", () => {
    const attendees = [me(), ...others(MAX_COUNTED_ATTENDEES - 1)];
    const counted = countMeeting(meeting({ attendees }), OWN, NOW);
    expect(counted?.contacts).toHaveLength(MAX_COUNTED_ATTENDEES - 1);
    expect(counted?.small).toBe(false);
  });

  it("counts nothing for a meeting past the cap, or one whose guest list was left out", () => {
    const attendees = [me(), ...others(MAX_COUNTED_ATTENDEES)];
    expect(countMeeting(meeting({ attendees }), OWN, NOW)).toBeNull();
    const omitted = meeting({ attendeesOmitted: true, attendees: [me()] });
    expect(countMeeting(omitted, OWN, NOW)).toBeNull();
    const partial = meeting({ attendeesOmitted: true });
    expect(countMeeting(partial, OWN, NOW)).toBeNull();
  });
});

describe("normalizeAttendeeEmail", () => {
  it("trims and lower-cases a plain address", () => {
    expect(normalizeAttendeeEmail("  Ana@Client.Example ")).toBe("ana@client.example");
  });

  it("refuses anything that is not one plain address", () => {
    for (const raw of [
      "",
      "ana",
      "Ana <ana@x.example>",
      "a@b@c",
      "a b@x.example",
      "device:3f9a1c",
      // Non-ASCII: JavaScript's and Postgres's lower() may disagree on it, and the
      // table's CHECK compares the two.
      "İnci@örnek.example",
    ]) {
      expect(normalizeAttendeeEmail(raw), raw).toBeNull();
    }
    expect(normalizeAttendeeEmail(`${"a".repeat(250)}@x.example`)).toBeNull();
  });
});
