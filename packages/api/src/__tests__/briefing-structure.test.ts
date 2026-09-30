/**
 * Briefing v2 structure — localized labels/headline templates, timezone-true
 * segmentation, measured-only summaries, attention capped at 3.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  timezone: "Asia/Seoul",
  language: "ko" as string | null,
  events: [] as Array<{
    title: string;
    startTime: Date;
    endTime: Date;
    provider?: string;
    externalId?: string | null;
    sourceAccountId?: string | null;
  }>,
  pushItems: [] as Array<{ title: string; tierReason: string | null }>,
}));

vi.mock("../db.js", () => {
  const prisma = {
    automationConfig: {
      findUnique: vi.fn(async () => ({ notificationLanguage: state.language })),
    },
    calendarEvent: { findMany: vi.fn(async () => state.events) },
    attentionItem: { findMany: vi.fn(async () => state.pushItems) },
  };
  return { prisma, db: prisma };
});
vi.mock("../user-timezone.js", () => ({
  getUserTimeZone: vi.fn(async () => state.timezone),
}));

import { prisma } from "../db.js";
import { buildBriefingStructure } from "../pim/briefing-structure.js";

// Saturday 2026-08-22, 07:00 KST.
const NOW = new Date("2026-08-21T22:00:00Z");

function kstEvent(title: string, hour: number, endHour: number) {
  // hour is KST; KST = UTC+9.
  return {
    title,
    startTime: new Date(Date.UTC(2026, 7, 22, hour - 9, 0)),
    endTime: new Date(Date.UTC(2026, 7, 22, endHour - 9, 0)),
  };
}

beforeEach(() => {
  state.timezone = "Asia/Seoul";
  state.language = "ko";
  state.events = [];
  state.pushItems = [];
});

describe("buildBriefingStructure", () => {
  it("renders the screenshot shape in Korean: front-loaded morning, open rest", async () => {
    state.events = [
      kstEvent("싱크", 9, 10),
      kstEvent("주간 회의", 9, 10),
      kstEvent("벤더 체크인", 9, 10),
    ];
    state.pushItems = [
      { title: "회고 생각 두세 가지 준비", tierReason: "오후 2시 디자인 회고" },
      { title: "계약서 서명", tierReason: null },
    ];
    const s = await buildBriefingStructure("u1", NOW);

    expect(s.dateLabel).toBe("2026년 8월 22일 토요일");
    expect(s.headline).toBe("오전 10시 전에 회의 3건. 나머지는 비어 있습니다.");
    expect(s.segments).toHaveLength(2);
    expect(s.segments[0]).toMatchObject({ label: "오전 10시 이전", kind: "busy" });
    expect(s.segments[0].summary).toContain("3건");
    expect(s.segments[1]).toMatchObject({ label: "오전 10시 이후", kind: "free" });
    expect(s.segments[1].summary).toBe("10시간 비어 있습니다.");
    expect(s.curve[1]).toBe(3); // 09:00 local
    expect(s.attention).toEqual([
      { rank: 1, action: "회고 생각 두세 가지 준비", reason: "오후 2시 디자인 회고" },
      { rank: 2, action: "계약서 서명", reason: "" },
    ]);
  });

  it("marks an empty weekend as a day off, localized in English", async () => {
    state.language = "en";
    const s = await buildBriefingStructure("u1", NOW);
    expect(s.headline).toBe("Nothing on the calendar. It's a day off.");
    expect(s.segments).toEqual([
      { label: "Today", summary: "Nothing scheduled. It's a day off.", kind: "off" },
    ]);
  });

  it("segments hours in the user's timezone, not UTC", async () => {
    state.timezone = "America/New_York";
    state.language = "en";
    // 14:00Z on Aug 22 = 10:00 EDT.
    state.events = [
      {
        title: "Standup",
        startTime: new Date("2026-08-22T14:00:00Z"),
        endTime: new Date("2026-08-22T15:00:00Z"),
      },
    ];
    // 08:00 EDT
    const s = await buildBriefingStructure("u1", new Date("2026-08-22T12:00:00Z"));
    const busy = s.segments.find((seg) => seg.kind === "busy");
    expect(busy?.label).toBe("10 AM – 11 AM");
    expect(s.curve[2]).toBe(1); // index 2 = 10:00 local
  });

  it("clamps events crossing midnight to today's window edges", async () => {
    state.language = "en";
    // 23:00 KST yesterday → 09:00 KST today: only 8-9h of today is busy.
    state.events = [
      {
        title: "Overnight deploy",
        startTime: new Date("2026-08-21T14:00:00Z"),
        endTime: new Date("2026-08-22T00:00:00Z"),
      },
    ];
    const s = await buildBriefingStructure("u1", NOW);
    expect(s.curve[0]).toBe(1); // 08h
    expect(s.curve[1]).toBe(0); // 09h onward free
    expect(s.headline).toContain("1 meeting");
  });
});

describe("buildBriefingStructure — linked calendar copies (C2)", () => {
  const copy = (sourceAccountId: string | null) => ({
    ...kstEvent("Design review", 10, 11),
    provider: "GOOGLE",
    externalId: "g-invite",
    sourceAccountId,
  });

  it("counts an invite that sits in the primary and a linked calendar as one meeting", async () => {
    state.events = [copy(null)];
    const single = await buildBriefingStructure("u1", NOW);

    state.events = [copy("acct-1"), copy(null)];
    const both = await buildBriefingStructure("u1", NOW);

    expect(both).toEqual(single);
    // The overlap curve would read 2 at 10:00 if the copy were counted.
    expect(Math.max(...both.curve)).toBe(1);
  });

  it("still counts two different meetings at the same time as two", async () => {
    state.events = [
      { ...copy(null), externalId: "g-a" },
      { ...copy("acct-1"), externalId: "g-b" },
    ];
    expect(Math.max(...(await buildBriefingStructure("u1", NOW)).curve)).toBe(2);
  });
});

describe("buildBriefingStructure — kill switch (C2)", () => {
  const eventQueryWhere = () => {
    const call = vi.mocked(prisma.calendarEvent.findMany).mock.calls.at(-1);
    return (call?.[0] as { where: Record<string, unknown> }).where;
  };

  afterEach(() => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
  });

  it("reads primary and LOCAL rows only while LINKED_CALENDAR_SYNC_ENABLED is off", async () => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
    await buildBriefingStructure("u1", NOW);
    expect(eventQueryWhere().sourceAccountId).toBeNull();
  });

  it("does not narrow the query once the flag is on", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    await buildBriefingStructure("u1", NOW);
    expect(eventQueryWhere()).not.toHaveProperty("sourceAccountId");
  });
});

describe("buildBriefingStructure — the cap applies after the dedupe (C7)", () => {
  const DAY_SHAPE_CAP = 50;
  const queryArg = () => {
    const call = vi.mocked(prisma.calendarEvent.findMany).mock.calls.at(-1);
    return call?.[0] as { take?: number };
  };

  afterEach(() => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
  });

  it("does not cap the query while copies can exist, so copies never spend the cap", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    await buildBriefingStructure("u1", NOW);
    expect(queryArg().take).toBeUndefined();
  });

  it("still lets the database cap the query while no linked row is visible (identical to main)", async () => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
    await buildBriefingStructure("u1", NOW);
    expect(queryArg().take).toBe(DAY_SHAPE_CAP);
  });

  it("reads at most 50 distinct meetings even when more rows come back", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    state.language = "en";
    state.events = Array.from({ length: 60 }, (_, i) => ({
      ...kstEvent(`Meeting ${i}`, 10, 11),
      provider: "GOOGLE",
      externalId: `g-${i}`,
      sourceAccountId: null,
    }));
    const s = await buildBriefingStructure("u1", NOW);
    expect(s.headline).toContain("50 meetings");
  });
});
