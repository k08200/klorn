import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import { mockWeekEvents } from "../../api/mock/fixtures-hub";
import {
  addDays,
  agendaTime,
  busyDays,
  conflictsOf,
  dayKeyOf,
  defaultFormFor,
  draftFromForm,
  eventsOnDay,
  formFromDraft,
  isDayKey,
  isPast,
  legendOf,
  monthTitle,
  nowLineIndex,
  overlapOf,
  parseAttendees,
  saveStateAfterFailure,
  slotLabel,
  weekOf,
  weekRange,
  weekStartsOn,
  zonedInstant,
} from "./model";

const ZONE = "Asia/Seoul";
const NOW = new Date("2026-10-16T10:28:00+09:00");
const EVENTS = mockWeekEvents(NOW.getTime());
const TODAY = "2026-10-16";

describe("day keys and weeks", () => {
  it("validates and moves day keys", () => {
    expect(isDayKey("2026-10-16")).toBe(true);
    expect(isDayKey("2026-02-30")).toBe(false);
    expect(isDayKey("16/10/2026")).toBe(false);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(dayKeyOf(NOW, ZONE)).toBe(TODAY);
    expect(dayKeyOf(NOW, "America/Los_Angeles")).toBe("2026-10-15");
  });

  it("builds Monday-first weeks (Sunday-first in English) and their range", () => {
    expect(weekStartsOn("ko-KR")).toBe(1);
    expect(weekStartsOn("en")).toBe(0);
    const week = weekOf(TODAY, 1);
    // 2026-10-16 is a Friday.
    expect(week[0]).toBe("2026-10-12");
    expect(week[6]).toBe("2026-10-18");
    expect(weekOf(TODAY, 0)[0]).toBe("2026-10-11");
    const range = weekRange(week, ZONE);
    expect(range.start.toISOString()).toBe("2026-10-11T15:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-10-18T15:00:00.000Z");
  });

  it("converts wall-clock times in a zone, across DST", () => {
    expect(zonedInstant(TODAY, "09:30", ZONE).toISOString()).toBe("2026-10-16T00:30:00.000Z");
    // 2026-11-01 is the US fall-back day: 01:30 happens in EST after the change? Pin 12:00.
    expect(zonedInstant("2026-11-01", "12:00", "America/New_York").toISOString()).toBe(
      "2026-11-01T17:00:00.000Z",
    );
  });
});

describe("agenda", () => {
  const day = eventsOnDay(EVENTS, TODAY, ZONE);

  it("lists the day's events across every calendar, by start", () => {
    expect(day.map((e) => e.id)).toEqual([
      "evt-standup",
      "evt-review",
      "evt-lunch",
      "evt-investor",
      "evt-1on1",
    ]);
    expect(eventsOnDay(EVENTS, "2026-10-15", ZONE)).toEqual([]);
    expect(eventsOnDay(EVENTS, "2026-10-17", ZONE).map((e) => e.id)).toEqual([
      "evt-doctor",
      "evt-dinner",
    ]);
  });

  it("marks busy days for the strip (the artboard: 13, 14, 16, 17)", () => {
    const busy = busyDays(EVENTS, weekOf(TODAY, 1), ZONE);
    expect([...busy].sort()).toEqual(["2026-10-13", "2026-10-14", "2026-10-16", "2026-10-17"]);
  });

  it("dims past events and puts the now line before the next one", () => {
    expect(day.filter((e) => isPast(e, NOW)).map((e) => e.id)).toEqual(["evt-standup"]);
    expect(nowLineIndex(day, TODAY, NOW, ZONE)).toBe(1);
    expect(nowLineIndex(day, "2026-10-17", NOW, ZONE)).toBe(-1);
    expect(nowLineIndex(day, TODAY, new Date("2026-10-16T23:00:00+09:00"), ZONE)).toBe(5);
  });

  it("finds conflicts and puts them on the earlier event", () => {
    const conflicts = conflictsOf(day);
    expect([...conflicts.keys()]).toEqual(["evt-investor"]);
    expect(conflicts.get("evt-investor")?.with.id).toBe("evt-1on1");
    expect(overlapOf(day, "evt-1on1")?.id).toBe("evt-investor");
    expect(overlapOf(day, "evt-review")).toBeNull();
    const back2back = conflictsOf(eventsOnDay(EVENTS, "2026-10-13", ZONE));
    expect(back2back.size).toBe(0);
  });

  it("builds the source legend once per calendar", () => {
    const legend = legendOf(day, "personal");
    expect(legend.map((s) => s.key)).toEqual(["cal-work", "cal-icloud", "cal-partners"]);
    const week = legendOf(EVENTS, "personal");
    expect(week.find((s) => s.key === "primary")?.purpose).toBe("personal");
  });

  it("formats times and titles per locale", () => {
    expect(agendaTime(new Date("2026-10-16T09:30:00+09:00"), "ko-KR", ZONE)).toBe("9:30");
    expect(agendaTime(new Date("2026-10-16T14:00:00+09:00"), "ko-KR", ZONE)).toBe("14:00");
    expect(agendaTime(new Date("2026-10-16T14:00:00+09:00"), "en", ZONE)).toBe("2:00 PM");
    expect(monthTitle(TODAY, "ko-KR")).toEqual({ month: "10월", year: "2026" });
    expect(monthTitle(TODAY, "en").month).toBe("October");
    expect(slotLabel("2026-10-21T01:00:00.000Z", "2026-10-21T02:00:00.000Z", "ko-KR", ZONE)).toBe(
      "10월 21일 (수) · 10:00–11:00",
    );
  });
});

describe("new event draft", () => {
  const base = defaultFormFor(TODAY, NOW, ZONE);

  it("starts at the next whole hour today, 10:00 on other days", () => {
    expect(base.start).toBe("11:00");
    expect(base.end).toBe("12:00");
    expect(defaultFormFor("2026-10-20", NOW, ZONE).start).toBe("10:00");
  });

  it("refuses a missing title, a reversed time or a bad address", () => {
    expect(draftFromForm({ ...base, title: " " }, ZONE).problem).toBe("title");
    expect(draftFromForm({ ...base, title: "x", start: "12:00", end: "11:00" }, ZONE).problem).toBe(
      "time",
    );
    expect(draftFromForm({ ...base, title: "x", attendees: "a@b.co, nope" }, ZONE).problem).toBe(
      "attendees",
    );
  });

  it("builds exactly what POST /api/calendar receives", () => {
    const { draft } = draftFromForm(
      { ...base, title: " 점심 ", location: " 성수동 ", attendees: "A@x.io b@y.io a@x.io" },
      ZONE,
    );
    expect(draft).toEqual({
      title: "점심",
      startTime: "2026-10-16T02:00:00.000Z",
      endTime: "2026-10-16T03:00:00.000Z",
      location: "성수동",
      attendees: ["a@x.io", "b@y.io"],
    });
    const allDay = draftFromForm({ ...base, title: "휴가", allDay: true }, ZONE).draft;
    expect(allDay?.startTime).toBe("2026-10-15T15:00:00.000Z");
    expect(allDay?.allDay).toBe(true);
    expect(parseAttendees("x@y.z;;w@v.u").valid).toEqual(["x@y.z", "w@v.u"]);
  });

  it("turns a draft back into the form", () => {
    const form = formFromDraft(
      {
        title: "디자인팀 회의",
        startTime: "2026-10-21T01:00:00.000Z",
        endTime: "2026-10-21T02:00:00.000Z",
        attendees: ["a@x.io"],
      },
      base,
      ZONE,
    );
    expect(form).toMatchObject({
      day: "2026-10-21",
      start: "10:00",
      end: "11:00",
      attendees: "a@x.io",
    });
  });
});

describe("saveStateAfterFailure", () => {
  const http = (status: number, code: string | null = null) =>
    new ApiError("http", status, `HTTP ${status}`, null, code);

  it("shows the plans prompt only for the entitlement refusal", () => {
    expect(saveStateAfterFailure(http(403, "ENTITLEMENT_REQUIRED"))).toBe("paywalled");
  });

  it("shows the plain error for every other failure", () => {
    expect(saveStateAfterFailure(http(403))).toBe("error"); // "Forbidden": not your event
    expect(saveStateAfterFailure(http(402))).toBe("error");
    expect(saveStateAfterFailure(http(500))).toBe("error");
    expect(saveStateAfterFailure(new ApiError("network", 0, "offline", null))).toBe("error");
    expect(saveStateAfterFailure(new Error("boom"))).toBe("error");
  });
});
