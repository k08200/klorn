import { describe, expect, it } from "vitest";
import { mockEvents, mockFirewall } from "../../api/mock/fixtures";
import {
  approvalKind,
  briefItems,
  dayRangeInZone,
  initialsOf,
  meetingService,
  nextEvent,
  remainingEvents,
  repliesOwed,
} from "./model";

const NOW = new Date("2026-10-16T01:28:00Z"); // 10:28 KST

describe("Today model", () => {
  it("brief = PUSH then MEETING, with the recorded reason", () => {
    const items = briefItems(mockFirewall(NOW.getTime()));
    expect(items.map((i) => i.lane)).toEqual(["PUSH", "MEETING"]);
    expect(items[0]?.why).toBe("오늘 18시 마감 · 두 번 언급");
    expect(items[0]?.emailId).toBe("email-att-push-1");
  });

  it("caps the brief and never includes QUEUE/INFO/SILENT", () => {
    const fw = mockFirewall(NOW.getTime());
    const extra = fw.tiers.PUSH[0];
    if (!extra) throw new Error("fixture");
    fw.tiers.PUSH.push({ ...extra, id: "p2" }, { ...extra, id: "p3" }, { ...extra, id: "p4" });
    const items = briefItems(fw);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.lane === "PUSH")).toBe(true);
  });

  it("counts replies owed as a recorded fact", () => {
    expect(repliesOwed(mockFirewall(NOW.getTime()))).toBe(2);
    expect(repliesOwed(mockFirewall(NOW.getTime(), true))).toBe(0);
  });

  it("next event skips ended events; remaining counts timed ones", () => {
    const events = mockEvents(NOW.getTime());
    expect(nextEvent(events, NOW)?.id).toBe("evt-review");
    expect(remainingEvents(events, NOW)).toHaveLength(3);
    expect(nextEvent([], NOW)).toBeNull();
  });

  it("day range follows the user's zone, across a DST change too", () => {
    const { start, end } = dayRangeInZone(NOW, "Asia/Seoul");
    expect(start.toISOString()).toBe("2026-10-15T15:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-16T15:00:00.000Z");
    const dst = dayRangeInZone(new Date("2026-11-01T12:00:00Z"), "America/New_York");
    expect((dst.end.getTime() - dst.start.getTime()) / 3_600_000).toBe(25);
    expect(dayRangeInZone(NOW, "Not/AZone").start.toISOString()).toBe("2026-10-16T00:00:00.000Z");
  });

  it("names the meeting service from a link, only for known hosts", () => {
    expect(meetingService("https://meet.google.com/abc")).toBe("Google Meet");
    expect(meetingService("https://acme.zoom.us/j/1")).toBe("Zoom");
    expect(meetingService("https://evil.example/meet.google.com")).toBeNull();
    expect(meetingService("not a url")).toBeNull();
  });

  it("classifies approvals and builds initials", () => {
    expect(approvalKind("send_email")).toBe("email");
    expect(approvalKind("update_calendar_event")).toBe("calendar");
    expect(approvalKind("create_task")).toBe("other");
    expect(initialsOf("Jisu Shin", null)).toBe("JS");
    expect(initialsOf("신지수", null)).toBe("지수");
    expect(initialsOf(null, "kim@x.com")).toBe("K");
  });
});
