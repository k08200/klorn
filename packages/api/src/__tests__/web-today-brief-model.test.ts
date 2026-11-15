/**
 * Today on a phone (mobile redesign PR2, MB1 "Editorial Brief", LOCKED
 * 2026-11-14) — the pure rules in packages/web/src/app/today/brief-model.ts:
 * why a PUSH card rang (verified quote vs Klorn's call), the next events on
 * the strip, the day's meeting count and the quiet lanes in the footer.
 */

import type { EmailLaneCounts, EmailListItem, V3Reason } from "@klorn/contract";
import { describe, expect, it } from "vitest";
import {
  BRIEF_NEXT_EVENTS,
  briefHeadlineKey,
  meetingCount,
  nextEvents,
  pushWhy,
  quietLanes,
} from "../../../web/src/app/today/brief-model";
import type { CalendarEventWire } from "../../../web/src/app/today/model";

const NOW = new Date("2026-11-14T05:30:00.000Z");

function reason(fields: Partial<V3Reason>): V3Reason {
  return { code: "ask", fact: null, evidence: null, evidenceIn: null, params: {}, ...fields };
}

function mail(fields: Partial<EmailListItem>): Pick<EmailListItem, "tierReason" | "v3"> {
  return { tierReason: null, v3: undefined, ...fields };
}

function event(id: string, start: string, end: string, allDay = false): CalendarEventWire {
  return { id, title: id, startTime: start, endTime: end, location: null, allDay };
}

describe("pushWhy", () => {
  it("shows verified evidence as a curly-quoted quote", () => {
    const email = mail({
      tierReason: "Deadline today",
      v3: {
        policyVersion: "v3.1",
        rank: null,
        held: false,
        due: null,
        threadTurn: null,
        reasons: [reason({ evidence: '"Please sign by 5pm today"', evidenceIn: "body" })],
      },
    });
    expect(pushWhy(email)).toEqual({ kind: "quote", text: "“Please sign by 5pm today”" });
  });

  it("falls back to the judge's free text as Klorn's call", () => {
    expect(pushWhy(mail({ tierReason: "  Your manager  asked\nfor a reply " }))).toEqual({
      kind: "judgment",
      text: "Your manager asked for a reply",
    });
  });

  it("keeps the judge's text plain, markup and all", () => {
    expect(pushWhy(mail({ tierReason: "<b>urgent</b>" }))).toEqual({
      kind: "judgment",
      text: "<b>urgent</b>",
    });
  });

  it("gives nothing when there is neither evidence nor a reason", () => {
    expect(pushWhy(mail({}))).toBeNull();
    expect(pushWhy(mail({ tierReason: "   " }))).toBeNull();
  });
});

describe("nextEvents", () => {
  const events = [
    event("done", "2026-11-14T01:00:00Z", "2026-11-14T02:00:00Z"),
    event("allday", "2026-11-14T00:00:00Z", "2026-11-15T00:00:00Z", true),
    event("later", "2026-11-14T07:30:00Z", "2026-11-14T08:00:00Z"),
    event("running", "2026-11-14T05:00:00Z", "2026-11-14T06:00:00Z"),
    event("soon", "2026-11-14T06:00:00Z", "2026-11-14T06:30:00Z"),
    event("last", "2026-11-14T09:00:00Z", "2026-11-14T10:00:00Z"),
  ];

  it("lists running then upcoming timed events, in order, up to the strip's limit", () => {
    const next = nextEvents(events, NOW);
    expect(next.map((e) => [e.event.id, e.now])).toEqual([
      ["running", true],
      ["soon", false],
      ["later", false],
    ]);
    expect(next).toHaveLength(BRIEF_NEXT_EVENTS);
  });

  it("is empty once the day's timed events are over", () => {
    expect(nextEvents(events, new Date("2026-11-14T11:00:00Z"))).toEqual([]);
  });
});

describe("meetingCount", () => {
  it("counts the day's timed events, not all-day ones", () => {
    expect(
      meetingCount([
        event("a", "2026-11-14T01:00:00Z", "2026-11-14T02:00:00Z"),
        event("b", "2026-11-14T00:00:00Z", "2026-11-15T00:00:00Z", true),
        event("c", "2026-11-14T06:00:00Z", "2026-11-14T07:00:00Z"),
      ]),
    ).toBe(2);
  });
});

describe("quietLanes", () => {
  const counts = (queue: number, info: number, silent: number): EmailLaneCounts => ({
    PUSH: { total: 9, unread: 0, threads: 9 },
    MEETING: { total: 2, unread: 0, threads: 2 },
    QUEUE: { total: queue + 3, unread: 0, threads: queue },
    INFO: { total: info, unread: 0, threads: info },
    SILENT: { total: silent, unread: 0, threads: silent },
  });

  it("lists Queue, Info and Silent by threads, only the lanes that hold mail", () => {
    expect(quietLanes(counts(14, 0, 30))).toEqual([
      { lane: "QUEUE", count: 14 },
      { lane: "SILENT", count: 30 },
    ]);
  });

  it("never lists PUSH or MEETING, and nothing before the counts arrive", () => {
    expect(quietLanes(counts(0, 0, 0))).toEqual([]);
    expect(quietLanes(null)).toEqual([]);
  });
});

describe("briefHeadlineKey", () => {
  it("is calm at zero, singular at one and plural above", () => {
    expect(briefHeadlineKey(0)).toBe("today.brief.headline.none");
    expect(briefHeadlineKey(1)).toBe("today.brief.headline.one");
    expect(briefHeadlineKey(4)).toBe("today.brief.headline.many");
  });
});
