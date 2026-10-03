/**
 * C6: the boundary check of one device calendar snapshot (the body of
 * PUT /api/device-calendar/sources/:key/window). Pure: no database, no clock but
 * the one passed in. A window is bounded in length and in distance from now;
 * timed events are offset-bearing instants stored as UTC; all-day events are dates
 * stored at UTC midnight with an exclusive end (as C4 and C7 store them); a meeting
 * link reaches a row only through safeMeetingLink; cancelled, out-of-window and
 * repeated events are left out and counted.
 */

import { describe, expect, it } from "vitest";
import {
  DEVICE_EVENT_MAX_SPAN_DAYS,
  DEVICE_SNAPSHOT_CLOCK_SKEW_DAYS,
  DEVICE_SNAPSHOT_MAX_EVENTS,
  DEVICE_WINDOW_MAX_DAYS,
  DEVICE_WINDOW_MAX_LAG_DAYS,
  DEVICE_WINDOW_MAX_LEAD_DAYS,
  DEVICE_WINDOW_PAST_DAYS,
  type DeviceEventBody,
  type DeviceSnapshotBody,
  isDeviceSourceKey,
  normaliseDeviceSnapshot,
} from "../pim/device-calendar/device-snapshot.js";

const NOW = new Date("2026-10-02T03:00:00.000Z");
const DAY_MS = 86_400_000;

function event(init: Partial<DeviceEventBody> = {}): DeviceEventBody {
  return {
    externalId: "e1",
    title: "Design review",
    start: "2026-10-05T10:00:00+09:00",
    end: "2026-10-05T11:00:00+09:00",
    allDay: false,
    location: null,
    meetingLink: null,
    status: "confirmed",
    ...init,
  };
}

function body(init: Partial<DeviceSnapshotBody> = {}): DeviceSnapshotBody {
  return {
    windowStart: "2026-10-01T15:00:00.000Z",
    windowEnd: "2026-10-31T15:00:00.000Z",
    snapshotAt: "2026-10-02T02:59:00.000Z",
    calendarTitle: "Work",
    events: [event()],
    ...init,
  };
}

function ok(input: DeviceSnapshotBody) {
  const result = normaliseDeviceSnapshot(input, NOW);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.snapshot;
}

function reason(input: DeviceSnapshotBody): string | null {
  const result = normaliseDeviceSnapshot(input, NOW);
  return result.ok ? null : result.reason;
}

describe("the source key", () => {
  it("is a lowercase sha256 hex digest, never a raw EventKit identifier", () => {
    expect(isDeviceSourceKey("a".repeat(64))).toBe(true);
    expect(isDeviceSourceKey("0123456789abcdef".repeat(4))).toBe(true);
    expect(isDeviceSourceKey("A".repeat(64))).toBe(false);
    expect(isDeviceSourceKey("a".repeat(63))).toBe(false);
    expect(isDeviceSourceKey("a".repeat(65))).toBe(false);
    // An EventKit calendar identifier is a UUID: refused.
    expect(isDeviceSourceKey("5C7B3D2E-1F4A-4B6C-9D8E-0A1B2C3D4E5F")).toBe(false);
  });
});

describe("the window", () => {
  it("is kept as the two instants the device sent", () => {
    const snapshot = ok(body());
    expect(snapshot.window.start.toISOString()).toBe("2026-10-01T15:00:00.000Z");
    expect(snapshot.window.end.toISOString()).toBe("2026-10-31T15:00:00.000Z");
    expect(snapshot.calendarTitle).toBe("Work");
  });

  it("accepts an offset-bearing instant and refuses one without a zone", () => {
    expect(ok(body({ windowStart: "2026-10-02T00:00:00+09:00" })).window.start.toISOString()).toBe(
      "2026-10-01T15:00:00.000Z",
    );
    expect(reason(body({ windowStart: "2026-10-02T00:00:00" }))).toBe("window");
    expect(reason(body({ windowStart: "not a date" }))).toBe("window");
    expect(reason(body({ windowStart: "2026-13-02T00:00:00Z" }))).toBe("window");
  });

  it("must end after it starts", () => {
    expect(reason(body({ windowEnd: "2026-10-01T15:00:00.000Z" }))).toBe("window");
    expect(reason(body({ windowEnd: "2026-09-30T15:00:00.000Z" }))).toBe("window");
  });

  it(`is at most ${DEVICE_WINDOW_MAX_DAYS} days long`, () => {
    const start = new Date("2026-10-01T00:00:00.000Z");
    const atMax = new Date(start.getTime() + DEVICE_WINDOW_MAX_DAYS * DAY_MS).toISOString();
    const overMax = new Date(start.getTime() + DEVICE_WINDOW_MAX_DAYS * DAY_MS + 1).toISOString();
    expect(reason(body({ windowStart: start.toISOString(), windowEnd: atMax, events: [] }))).toBe(
      null,
    );
    expect(reason(body({ windowStart: start.toISOString(), windowEnd: overMax }))).toBe("window");
  });

  it("must sit near now: a device with a wrong clock cannot rewrite a far-off window", () => {
    const tooEarly = new Date(NOW.getTime() - DEVICE_WINDOW_MAX_LAG_DAYS * DAY_MS - 1);
    const tooLate = new Date(NOW.getTime() + DEVICE_WINDOW_MAX_LEAD_DAYS * DAY_MS + 1);
    expect(
      reason(
        body({
          windowStart: tooEarly.toISOString(),
          windowEnd: new Date(tooEarly.getTime() + DAY_MS).toISOString(),
        }),
      ),
    ).toBe("window");
    expect(
      reason(
        body({
          windowStart: new Date(tooLate.getTime() - DAY_MS).toISOString(),
          windowEnd: tooLate.toISOString(),
        }),
      ),
    ).toBe("window");
  });
});

describe("timed events", () => {
  it("are stored as the UTC instants their offsets name", () => {
    const [row] = ok(body()).events;
    expect(row?.externalId).toBe("e1");
    expect(row?.fields).toEqual({
      title: "Design review",
      description: null,
      startTime: new Date("2026-10-05T01:00:00.000Z"),
      endTime: new Date("2026-10-05T02:00:00.000Z"),
      location: null,
      meetingLink: null,
      allDay: false,
    });
  });

  it("read an instant west of UTC the same way", () => {
    const [row] = ok(
      body({
        events: [event({ start: "2026-10-04T18:00:00-07:00", end: "2026-10-04T19:30:00-07:00" })],
      }),
    ).events;
    expect(row?.fields.startTime.toISOString()).toBe("2026-10-05T01:00:00.000Z");
    expect(row?.fields.endTime.toISOString()).toBe("2026-10-05T02:30:00.000Z");
  });

  it("refuse the snapshot for a time with no zone, or an end before the start", () => {
    expect(reason(body({ events: [event({ start: "2026-10-05T10:00:00" })] }))).toBe("event");
    expect(reason(body({ events: [event({ end: "2026-10-05T09:00:00+09:00" })] }))).toBe("event");
  });

  it("keep a zero-length event (a reminder-style marker) that sits inside the window", () => {
    const [row] = ok(body({ events: [event({ end: "2026-10-05T10:00:00+09:00" })] })).events;
    expect(row?.fields.startTime.getTime()).toBe(row?.fields.endTime.getTime());
  });
});

describe("all-day events", () => {
  it("are dates stored at UTC midnight, end exclusive (as C4 and C7 store them)", () => {
    const [row] = ok(
      body({ events: [event({ allDay: true, start: "2026-10-05", end: "2026-10-07" })] }),
    ).events;
    expect(row?.fields.allDay).toBe(true);
    expect(row?.fields.startTime.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(row?.fields.endTime.toISOString()).toBe("2026-10-07T00:00:00.000Z");
  });

  it("refuse an instant, an impossible date, or an end not after the start", () => {
    expect(
      reason(
        body({
          events: [event({ allDay: true, start: "2026-10-05T00:00:00Z", end: "2026-10-06" })],
        }),
      ),
    ).toBe("event");
    expect(
      reason(body({ events: [event({ allDay: true, start: "2026-02-30", end: "2026-03-01" })] })),
    ).toBe("event");
    expect(
      reason(body({ events: [event({ allDay: true, start: "2026-10-05", end: "2026-10-05" })] })),
    ).toBe("event");
  });

  it("on the first day of a window that starts at a local midnight east of UTC is kept", () => {
    // Seoul's 2026-10-02 00:00 is 2026-10-01T15:00Z; the all-day row of 10-02 starts 9 h later.
    const [row] = ok(
      body({ events: [event({ allDay: true, start: "2026-10-02", end: "2026-10-03" })] }),
    ).events;
    expect(row?.fields.startTime.toISOString()).toBe("2026-10-02T00:00:00.000Z");
  });
});

describe("what is left out (and counted)", () => {
  it("a cancelled event", () => {
    const snapshot = ok(
      body({ events: [event({ status: "cancelled" }), event({ externalId: "e2" })] }),
    );
    expect(snapshot.events.map((e) => e.externalId)).toEqual(["e2"]);
    expect(snapshot.skipped).toBe(1);
  });

  it("an event outside the window", () => {
    const snapshot = ok(
      body({
        events: [
          event({
            externalId: "before",
            start: "2026-09-20T10:00:00Z",
            end: "2026-09-20T11:00:00Z",
          }),
          event({
            externalId: "after",
            start: "2026-11-20T10:00:00Z",
            end: "2026-11-20T11:00:00Z",
          }),
          event({
            externalId: "ends-at-start",
            start: "2026-10-01T14:00:00Z",
            end: "2026-10-01T15:00:00Z",
          }),
          event({ externalId: "inside" }),
        ],
      }),
    );
    expect(snapshot.events.map((e) => e.externalId)).toEqual(["inside"]);
    expect(snapshot.skipped).toBe(3);
  });

  it("a second event with the same external id (the first wins)", () => {
    const snapshot = ok(body({ events: [event({ title: "first" }), event({ title: "second" })] }));
    expect(snapshot.events.map((e) => e.fields.title)).toEqual(["first"]);
    expect(snapshot.skipped).toBe(1);
  });

  it(`refuses more than ${DEVICE_SNAPSHOT_MAX_EVENTS} events outright`, () => {
    const many = Array.from({ length: DEVICE_SNAPSHOT_MAX_EVENTS + 1 }, (_, i) =>
      event({ externalId: `e${i}` }),
    );
    expect(reason(body({ events: many }))).toBe("events");
    expect(reason(body({ events: many.slice(0, DEVICE_SNAPSHOT_MAX_EVENTS) }))).toBe(null);
  });
});

describe("meeting links pass safeMeetingLink", () => {
  it.each([
    ["javascript:alert(1)", null],
    ["http://meet.example.com/x", null],
    ["https://user:pw@meet.example.com/x", null],
    ["zoommtg://zoom.us/join?confno=1", null],
    ["https://meet.google.com/abc-defg-hij", "https://meet.google.com/abc-defg-hij"],
    ["https://Zoom.US/j/1", "https://zoom.us/j/1"],
  ])("%s -> %s", (link, expected) => {
    const [row] = ok(body({ events: [event({ meetingLink: link })] })).events;
    expect(row?.fields.meetingLink).toBe(expected);
  });

  it("a missing location or link is null on the row", () => {
    const { location: _l, meetingLink: _m, ...bare } = event();
    const [row] = ok(body({ events: [bare as DeviceEventBody] })).events;
    expect(row?.fields.location).toBeNull();
    expect(row?.fields.meetingLink).toBeNull();
  });
});

describe("NUL, which Postgres text cannot hold, never reaches a row", () => {
  it("is dropped from the title, location, external id and calendar title", () => {
    const snapshot = ok(
      body({
        calendarTitle: "Wo\u0000rk",
        events: [event({ externalId: "e\u00001", title: "De\u0000sign", location: "Ro\u0000om" })],
      }),
    );
    expect(snapshot.calendarTitle).toBe("Work");
    expect(snapshot.events[0]?.externalId).toBe("e1");
    expect(snapshot.events[0]?.fields.title).toBe("Design");
    expect(snapshot.events[0]?.fields.location).toBe("Room");
  });

  it("an external id of nothing but NUL is left out and counted", () => {
    const snapshot = ok(
      body({ events: [event({ externalId: "\u0000\u0000" }), event({ externalId: "e2" })] }),
    );
    expect(snapshot.events.map((e) => e.externalId)).toEqual(["e2"]);
    expect(snapshot.skipped).toBe(1);
  });
});

describe("the snapshot time (stale-overwrite guard)", () => {
  it("is kept as the instant the device sent", () => {
    expect(ok(body()).snapshotAt.toISOString()).toBe("2026-10-02T02:59:00.000Z");
  });

  it("must name its zone and sit near now, so a wrong clock cannot block later uploads", () => {
    const skewMs = DEVICE_SNAPSHOT_CLOCK_SKEW_DAYS * DAY_MS;
    expect(reason(body({ snapshotAt: "2026-10-02T02:59:00" }))).toBe("snapshotAt");
    expect(reason(body({ snapshotAt: "9999-12-31T00:00:00Z" }))).toBe("snapshotAt");
    expect(reason(body({ snapshotAt: new Date(NOW.getTime() + skewMs + 1).toISOString() }))).toBe(
      "snapshotAt",
    );
    expect(reason(body({ snapshotAt: new Date(NOW.getTime() + skewMs).toISOString() }))).toBe(null);
    const tooOld = NOW.getTime() - DEVICE_WINDOW_MAX_LAG_DAYS * DAY_MS - 1;
    expect(reason(body({ snapshotAt: new Date(tooOld).toISOString() }))).toBe("snapshotAt");
  });
});

describe("an event's span is bounded, so no row can outlive the retention prune", () => {
  it(`drops (and counts) an event longer than ${DEVICE_EVENT_MAX_SPAN_DAYS} days`, () => {
    const start = Date.parse("2026-10-05T00:00:00Z");
    const atMax = new Date(start + DEVICE_EVENT_MAX_SPAN_DAYS * DAY_MS).toISOString();
    const over = new Date(start + DEVICE_EVENT_MAX_SPAN_DAYS * DAY_MS + 1000).toISOString();
    const snapshot = ok(
      body({
        events: [
          event({ externalId: "max", start: "2026-10-05T00:00:00Z", end: atMax }),
          event({ externalId: "over", start: "2026-10-05T00:00:00Z", end: over }),
        ],
      }),
    );
    expect(snapshot.events.map((e) => e.externalId)).toEqual(["max"]);
    expect(snapshot.skipped).toBe(1);
  });

  it("drops a year-9999 end, timed or all-day", () => {
    const snapshot = ok(
      body({
        events: [
          event({
            externalId: "timed",
            start: "2026-10-05T00:00:00Z",
            end: "9999-12-31T00:00:00Z",
          }),
          event({ externalId: "allday", allDay: true, start: "2026-10-05", end: "9999-12-31" }),
        ],
      }),
    );
    expect(snapshot.events).toEqual([]);
    expect(snapshot.skipped).toBe(2);
  });

  it(`the lag a window may reach is the Mac's ${DEVICE_WINDOW_PAST_DAYS} days plus one`, () => {
    expect(DEVICE_WINDOW_MAX_LAG_DAYS).toBe(DEVICE_WINDOW_PAST_DAYS + 1);
  });
});
