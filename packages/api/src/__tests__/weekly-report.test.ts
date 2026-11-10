/**
 * Weekly signal report — measured-only stats, ISO week keying, idempotent
 * delivery (Note unique key + Notification dedupe), silent skip for users
 * with an empty week.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  activeUsers: [] as Array<{ userId: string; _count: { _all: number } }>,
  tierRows: [] as Array<{ shownTier: string; _count: { _all: number } }>,
  corrections: 0,
  autoActions: 0,
  notes: [] as unknown[],
  noteDupe: false,
  notifications: [] as unknown[],
  pushes: [] as unknown[],
}));

class P2002 extends Error {
  code = "P2002";
}

vi.mock("../db.js", () => {
  const prisma = {
    decisionLabel: {
      groupBy: vi.fn(async (args: { by: string[] }) =>
        args.by.includes("userId") ? state.activeUsers : state.tierRows,
      ),
      count: vi.fn(async () => state.corrections),
    },
    agentLog: { count: vi.fn(async () => state.autoActions) },
    note: {
      create: vi.fn(async (args: unknown) => {
        if (state.noteDupe) throw new P2002("dup");
        state.notes.push(args);
        return { id: "n1" };
      }),
    },
    notification: {
      create: vi.fn(async (args: unknown) => {
        state.notifications.push(args);
        return { id: "nt1" };
      }),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../notify/push.js", () => ({
  sendPushNotification: vi.fn(async (...args: unknown[]) => {
    state.pushes.push(args);
    return {};
  }),
}));

import {
  collectWeeklyStats,
  formatWeeklyReport,
  isoWeekKey,
  sendWeeklySignalReports,
} from "../pim/weekly-report.js";

const NOW = new Date("2026-08-24T09:00:00Z"); // a Monday

beforeEach(() => {
  state.activeUsers = [];
  state.tierRows = [];
  state.corrections = 0;
  state.autoActions = 0;
  state.notes = [];
  state.noteDupe = false;
  state.notifications = [];
  state.pushes = [];
});

describe("isoWeekKey", () => {
  it("computes ISO week keys across year boundaries", () => {
    expect(isoWeekKey(new Date("2026-08-24T09:00:00Z"))).toBe("2026-W35");
    expect(isoWeekKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
    // 2027-01-01 is a Friday → still ISO week 53 of 2026.
    expect(isoWeekKey(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });
});

describe("collectWeeklyStats + formatWeeklyReport", () => {
  it("aggregates measured counts and never invents numbers", async () => {
    state.tierRows = [
      { shownTier: "PUSH", _count: { _all: 12 } },
      { shownTier: "SILENT", _count: { _all: 33 } },
      { shownTier: "INFO", _count: { _all: 39 } },
      { shownTier: "QUEUE", _count: { _all: 47 } },
      { shownTier: "CALL", _count: { _all: 2 } }, // legacy → PUSH
    ];
    state.corrections = 4;
    state.autoActions = 3;

    const stats = await collectWeeklyStats("u1", NOW);
    expect(stats.total).toBe(133);
    expect(stats.byTier.PUSH).toBe(14); // 12 + 2 legacy CALL
    expect(stats.filtered).toBe(72);
    expect(stats.filteredPct).toBe(54);

    const text = formatWeeklyReport(stats);
    expect(text).toContain("133 emails triaged");
    expect(text).toContain("72 filtered out of your way (54% SILENT+INFO)");
    expect(text).toContain("4 correction(s)");
    expect(text).toContain("3 handled automatically");
    // No unmeasured claims.
    expect(text).not.toMatch(/hour|minute|saved/i);
  });

  it("omits correction/auto lines when their counts are zero", async () => {
    state.tierRows = [{ shownTier: "QUEUE", _count: { _all: 5 } }];
    const stats = await collectWeeklyStats("u1", NOW);
    const text = formatWeeklyReport(stats);
    expect(text).not.toContain("correction");
    expect(text).not.toContain("automatically");
  });
});

describe("sendWeeklySignalReports", () => {
  it("delivers note + notification + push once per active user", async () => {
    state.activeUsers = [{ userId: "u1", _count: { _all: 10 } }];
    state.tierRows = [{ shownTier: "QUEUE", _count: { _all: 10 } }];

    const sent = await sendWeeklySignalReports(NOW);
    expect(sent).toBe(1);
    const note = state.notes[0] as { data: { dayKey: string; title: string } };
    expect(note.data.dayKey).toBe("2026-W35");
    const notif = state.notifications[0] as { data: { dedupeKey: string } };
    expect(notif.data.dedupeKey).toBe("weekly:2026-W35");
    expect(state.pushes).toHaveLength(1);
    const [, , category] = state.pushes[0] as [string, unknown, string];
    expect(category).toBe("daily_briefing");
  });

  it("skips users already delivered this week (note P2002) without pushing", async () => {
    state.activeUsers = [{ userId: "u1", _count: { _all: 10 } }];
    state.tierRows = [{ shownTier: "QUEUE", _count: { _all: 10 } }];
    state.noteDupe = true;

    const sent = await sendWeeklySignalReports(NOW);
    expect(sent).toBe(0);
    expect(state.pushes).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
  });

  it("skips users whose window has no triaged mail", async () => {
    state.activeUsers = [{ userId: "u1", _count: { _all: 1 } }];
    state.tierRows = [];

    const sent = await sendWeeklySignalReports(NOW);
    expect(sent).toBe(0);
    expect(state.notes).toHaveLength(0);
  });
});
