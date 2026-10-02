/**
 * getTeamAvailability — common free slots for the user + every VISIBLE
 * member. Focus: honesty about invisible calendars (unknown ≠ free), the
 * intersection actually excluding both my events and member busy blocks,
 * and input guards (bad window, junk members) returning {error} not throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  memberBusy: [] as Array<{ email: string; blocks: Array<{ start: string; end: string }> | null }>,
  myEvents: [] as Array<{ startTime: Date; endTime: Date }>,
}));

vi.mock("../pim/calendar.js", () => ({
  getAttendeeBusyByMember: vi.fn(async () => state.memberBusy),
}));
vi.mock("../db.js", () => {
  const prisma = {
    automationConfig: { findUnique: vi.fn(async () => ({ timezone: "Asia/Seoul" })) },
    calendarEvent: { findMany: vi.fn(async () => state.myEvents) },
  };
  return { prisma, db: prisma };
});

import { prisma } from "../db.js";
import { getTeamAvailability } from "../pim/team-availability.js";

// Tue 2026-08-25 09:00–18:00 KST = 00:00–09:00Z.
const WINDOW = { start: "2026-08-25T00:00:00Z", end: "2026-08-25T09:00:00Z" };

beforeEach(() => {
  state.memberBusy = [];
  state.myEvents = [];
});

describe("getTeamAvailability", () => {
  it("intersects my events with every member's busy blocks", async () => {
    state.myEvents = [
      // I'm busy 09:00–10:00 KST.
      { startTime: new Date("2026-08-25T00:00:00Z"), endTime: new Date("2026-08-25T01:00:00Z") },
    ];
    state.memberBusy = [
      // Alice busy 10:00–11:00 KST.
      {
        email: "alice@corp.com",
        blocks: [{ start: "2026-08-25T01:00:00Z", end: "2026-08-25T02:00:00Z" }],
      },
    ];
    const out = await getTeamAvailability(
      "user-1",
      ["alice@corp.com"],
      WINDOW.start,
      WINDOW.end,
      60,
    );
    if ("error" in out) throw new Error(out.error);
    // First hour clear of BOTH: 11:00 KST (02:00Z).
    expect(out.slots[0]?.startTime).toBe("2026-08-25T02:00:00.000Z");
    expect(out.checkedMembers).toEqual(["alice@corp.com"]);
    expect(out.unknownMembers).toEqual([]);
  });

  it("reports invisible calendars as unknown — never assumes free", async () => {
    state.memberBusy = [
      { email: "alice@corp.com", blocks: [] },
      { email: "outsider@gmail.com", blocks: null },
    ];
    const out = await getTeamAvailability(
      "user-1",
      ["alice@corp.com", "outsider@gmail.com"],
      WINDOW.start,
      WINDOW.end,
    );
    if ("error" in out) throw new Error(out.error);
    expect(out.unknownMembers).toEqual(["outsider@gmail.com"]);
    expect(out.checkedMembers).toEqual(["alice@corp.com"]);
    expect(out.slots.length).toBeGreaterThan(0);
  });

  it("guards inputs with {error} results, never throws", async () => {
    expect(await getTeamAvailability("user-1", [], WINDOW.start, WINDOW.end)).toHaveProperty(
      "error",
    );
    expect(
      await getTeamAvailability("user-1", ["not-an-email"], WINDOW.start, WINDOW.end),
    ).toHaveProperty("error");
    expect(await getTeamAvailability("user-1", ["a@b.co"], "junk", WINDOW.end)).toHaveProperty(
      "error",
    );
    expect(
      // 20-day window exceeds the 14-day cap.
      await getTeamAvailability(
        "user-1",
        ["a@b.co"],
        "2026-08-01T00:00:00Z",
        "2026-08-21T00:00:00Z",
      ),
    ).toHaveProperty("error");
  });
});

describe("getTeamAvailability — linked calendar copies (C2)", () => {
  it("duplicate rows of one invite (primary + linked) busy the same time once and change no slot", async () => {
    const invite = {
      startTime: new Date("2026-08-25T00:00:00Z"),
      endTime: new Date("2026-08-25T01:00:00Z"),
    };
    state.myEvents = [invite];
    const single = await getTeamAvailability(
      "user-1",
      ["alice@corp.com"],
      WINDOW.start,
      WINDOW.end,
      60,
    );

    state.myEvents = [invite, { ...invite }];
    const duplicated = await getTeamAvailability(
      "user-1",
      ["alice@corp.com"],
      WINDOW.start,
      WINDOW.end,
      60,
    );

    expect(duplicated).toEqual(single);
    if ("error" in duplicated) throw new Error(duplicated.error);
    expect(duplicated.slots[0]?.startTime).toBe("2026-08-25T01:00:00.000Z");
  });

  it("a linked calendar's event blocks the slot too: that is what syncing it is for", async () => {
    state.myEvents = [
      { startTime: new Date("2026-08-25T01:00:00Z"), endTime: new Date("2026-08-25T02:00:00Z") },
    ];
    const out = await getTeamAvailability(
      "user-1",
      ["alice@corp.com"],
      WINDOW.start,
      WINDOW.end,
      60,
    );
    if ("error" in out) throw new Error(out.error);
    expect(out.slots.map((x) => x.startTime)).not.toContain("2026-08-25T01:00:00.000Z");
  });
});

describe("getTeamAvailability — kill switch (C2)", () => {
  const whereOfLastQuery = () =>
    (
      vi.mocked(prisma.calendarEvent.findMany).mock.calls.at(-1)?.[0] as {
        where: Record<string, unknown>;
      }
    ).where;

  afterEach(() => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
  });

  it("counts primary and LOCAL events only as busy while the flag is off", async () => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
    await getTeamAvailability("user-1", ["alice@corp.com"], WINDOW.start, WINDOW.end, 60);
    expect(whereOfLastQuery().sourceAccountId).toBeNull();
  });

  it("counts linked calendars' events too once the flag is on", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    await getTeamAvailability("user-1", ["alice@corp.com"], WINDOW.start, WINDOW.end, 60);
    expect(whereOfLastQuery()).not.toHaveProperty("sourceAccountId");
  });
});
