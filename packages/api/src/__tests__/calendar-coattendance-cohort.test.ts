/**
 * CALENDAR_COATTENDANCE_ENABLED accepts the rollout cohort like the other
 * per-user features (config.ts flagMode / featureOpenTo, decision L23):
 *   - unset or false: no one — nothing is listed, read or written;
 *   - true: every user;
 *   - cohort: only the users in ROLLOUT_COHORT_USER_IDS.
 * The check runs per user wherever the per-user work happens: the scheduler's
 * queue, the pass itself, and the judge's reader gate (a user outside the
 * cohort has no counts, so co-attendance must read unknown, never 0).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const h = vi.hoisted(() => ({
  db: null as unknown,
  captureError: vi.fn(),
  connectLinkedCalendars: vi.fn(),
  connectPrimaryCalendar: vi.fn(),
}));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => h.db as FakeDb, { rollbackOnError: true });
  return {
    prisma,
    db: prisma,
    INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 },
  };
});
vi.mock("../sentry.js", () => ({ captureError: h.captureError }));
vi.mock("../pim/calendar-providers/dispatch.js", () => ({
  connectLinkedCalendars: h.connectLinkedCalendars,
  connectPrimaryCalendar: h.connectPrimaryCalendar,
}));

import { CALENDAR_COATTENDANCE_FLAG, calendarCoattendanceOpenTo } from "../config.js";
import { type CoAttendanceDeps, loadCoAttendance } from "../judge/v3/relationship-coattendance.js";
import {
  _drainCoAttendanceQueueForTests,
  enqueueCoAttendance,
} from "../pim/coattendance/coattendance-job.js";
import {
  _resetCoAttendancePassesForTests,
  runCoAttendancePass,
} from "../pim/coattendance/coattendance-sync.js";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const MEMBER = "u-member";
const OUTSIDER = "u-outsider";

function seed() {
  h.db = createFakeDb({
    user: [
      { id: MEMBER, email: "member@example.com" },
      { id: OUTSIDER, email: "outsider@example.com" },
    ],
    userToken: [
      { id: "t1", userId: MEMBER, provider: "google", accessToken: "x" },
      { id: "t2", userId: OUTSIDER, provider: "google", accessToken: "y" },
    ],
  });
}

/** Which users the scheduler's queue ran a pass for. */
async function queuedPasses(): Promise<string[]> {
  enqueueCoAttendance(MEMBER, { includeLinked: false });
  enqueueCoAttendance(OUTSIDER, { includeLinked: false });
  await _drainCoAttendanceQueueForTests();
  return h.connectPrimaryCalendar.mock.calls.map((c) => c[0] as string);
}

function readerDeps() {
  return {
    coAttendanceCoverage: vi.fn(async () => ({
      countedThrough: null,
      sources: [],
      hasNonGoogleSource: false,
    })),
    coAttendanceOwnAddresses: vi.fn(async () => new Set<string>()),
    coAttendanceRow: vi.fn(async () => null),
  } satisfies CoAttendanceDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetCoAttendancePassesForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // A failing connect stops the pass right after the gate: being called at all
  // is the proof the user got through it.
  h.connectPrimaryCalendar.mockRejectedValue(new Error("token refresh failed"));
  h.connectLinkedCalendars.mockResolvedValue([]);
  vi.stubEnv("ROLLOUT_COHORT_USER_IDS", MEMBER);
  seed();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("calendarCoattendanceOpenTo", () => {
  it("is the CALENDAR_COATTENDANCE_ENABLED flag", () => {
    expect(CALENDAR_COATTENDANCE_FLAG).toBe("CALENDAR_COATTENDANCE_ENABLED");
  });

  it.each(["", "false", "0", "off"])("%j: open to no one", (value) => {
    vi.stubEnv(CALENDAR_COATTENDANCE_FLAG, value);
    expect(calendarCoattendanceOpenTo(MEMBER)).toBe(false);
    expect(calendarCoattendanceOpenTo(OUTSIDER)).toBe(false);
  });

  it.each(["true", "1", "yes", "on", " TRUE "])("%j: open to every user", (value) => {
    vi.stubEnv(CALENDAR_COATTENDANCE_FLAG, value);
    expect(calendarCoattendanceOpenTo(MEMBER)).toBe(true);
    expect(calendarCoattendanceOpenTo(OUTSIDER)).toBe(true);
  });

  it("cohort: open to the cohort's users only", () => {
    vi.stubEnv(CALENDAR_COATTENDANCE_FLAG, "cohort");
    expect(calendarCoattendanceOpenTo(MEMBER)).toBe(true);
    expect(calendarCoattendanceOpenTo(OUTSIDER)).toBe(false);
  });

  it("cohort with an empty cohort: open to no one", () => {
    vi.stubEnv(CALENDAR_COATTENDANCE_FLAG, "cohort");
    vi.stubEnv("ROLLOUT_COHORT_USER_IDS", "");
    expect(calendarCoattendanceOpenTo(MEMBER)).toBe(false);
  });
});

describe("the pass and the scheduler's queue", () => {
  it("cohort: a cohort member is collected, a user outside it is skipped before any read", async () => {
    vi.stubEnv(CALENDAR_COATTENDANCE_FLAG, "cohort");

    expect(await runCoAttendancePass(OUTSIDER, { includeLinked: true }, NOW)).toBeNull();
    expect(h.connectPrimaryCalendar).not.toHaveBeenCalled();
    expect((h.db as FakeDb).reads).toEqual([]);

    await runCoAttendancePass(MEMBER, { includeLinked: true }, NOW);
    expect(h.connectPrimaryCalendar).toHaveBeenCalledWith(MEMBER);
  });

  it("cohort: the queue runs the member's pass only", async () => {
    vi.stubEnv(CALENDAR_COATTENDANCE_FLAG, "cohort");
    expect(await queuedPasses()).toEqual([MEMBER]);
  });

  it("true: the queue runs every user's pass", async () => {
    vi.stubEnv(CALENDAR_COATTENDANCE_FLAG, "true");
    expect(await queuedPasses()).toEqual([MEMBER, OUTSIDER]);
  });

  it("off: the queue runs no pass, and nothing is read", async () => {
    vi.stubEnv(CALENDAR_COATTENDANCE_FLAG, "");
    expect(await queuedPasses()).toEqual([]);
    expect((h.db as FakeDb).reads).toEqual([]);
  });
});

describe("the judge's reader gate", () => {
  it("cohort: a user outside it reads unknown, without a read; a member reaches the store", async () => {
    vi.stubEnv(CALENDAR_COATTENDANCE_FLAG, "cohort");
    const outsider = readerDeps();
    expect(await loadCoAttendance(outsider, OUTSIDER, "ana@client.example", NOW)).toBeUndefined();
    expect(outsider.coAttendanceCoverage).not.toHaveBeenCalled();

    const member = readerDeps();
    await loadCoAttendance(member, MEMBER, "ana@client.example", NOW);
    expect(member.coAttendanceCoverage).toHaveBeenCalledWith(MEMBER);
  });

  it("off: unknown for everyone", async () => {
    vi.stubEnv(CALENDAR_COATTENDANCE_FLAG, "false");
    const deps = readerDeps();
    expect(await loadCoAttendance(deps, MEMBER, "ana@client.example", NOW)).toBeUndefined();
    expect(deps.coAttendanceCoverage).not.toHaveBeenCalled();
  });
});
