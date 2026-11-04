/**
 * Co-attendance in the relationship loader: the reader's gate (doc §3(2), "The
 * reader's gate"). A missing ContactCoAttendance row is 0 meetings only when the
 * flag is on, the watermark is fresh, every Google calendar source covers the full
 * 30-day window, none awaits a reconnect, the user has no calendar the store does
 * not count, and the sender is an address the store counts. Otherwise every
 * co-attendance field is null (unknown), even when a row exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CoAttendanceCoverage,
  type CoAttendanceRow,
  coAttendanceWindow,
} from "../judge/v3/relationship-coattendance.js";
import {
  loadRelationshipSnapshot,
  type RelationshipLoaderDeps,
} from "../judge/v3/relationship-loader.js";
import type { CoverageSource } from "../pim/coattendance/coattendance-sources.js";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
// Today is 2026-11-04 (UTC): the watermark may be as old as 11-02, and a source
// covers the full window when it was observed on or before 10-05.
const NOW = new Date("2026-11-04T10:00:00Z");
const FRESH_PASS = new Date("2026-11-04T04:00:00Z");

const source = (over: Partial<CoverageSource> = {}): CoverageSource => ({
  kind: "linked",
  id: "lc1",
  needsReconnect: false,
  observedSince: day("2026-10-01"),
  lastPassAt: FRESH_PASS,
  ...over,
});

const coverage = (over: Partial<CoAttendanceCoverage> = {}): CoAttendanceCoverage => ({
  countedThrough: day("2026-11-03"),
  sources: [source({ kind: "primary", id: "tok1", observedSince: day("2026-09-20") }), source()],
  hasNonGoogleSource: false,
  ...over,
});

const ROW: CoAttendanceRow = {
  meetingCount: 3,
  smallMeetingCount: 2,
  lastMetAt: day("2026-10-30"),
};

function deps(over: Partial<RelationshipLoaderDeps> = {}): RelationshipLoaderDeps {
  return {
    hasAnySent: vi.fn(async () => true),
    sentRowsMentioning: vi.fn(async () => []),
    inboundFrom: vi.fn(async () => []),
    sentInThreads: vi.fn(async () => []),
    dismissCount: vi.fn(async () => 0),
    pinnedTier: vi.fn(async () => null),
    senderCategory: vi.fn(async () => null),
    coAttendanceCoverage: vi.fn(async () => coverage()),
    coAttendanceRow: vi.fn(async () => null),
    ...over,
  };
}

const load = (
  d: RelationshipLoaderDeps,
  senderAddress = "Kim <Kim@Partner.io>",
  userAddresses = ["me@acme.com"],
) => loadRelationshipSnapshot({ userId: "u1", senderAddress, userAddresses }, d);

const UNKNOWN = {
  meetingCount: null,
  smallMeetingCount: null,
  lastMetAt: null,
  coAttendanceObservedSince: null,
  coAttendanceCountedThrough: null,
  coAttendanceNext14d: null,
};

beforeEach(() => {
  vi.stubEnv("CALENDAR_COATTENDANCE_ENABLED", "true");
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("co-attendance gate passes", () => {
  it("no row: 0 meetings, 0 small, no last day; window [latest marker, watermark]", async () => {
    const d = deps();
    expect(await load(d)).toMatchObject({
      meetingCount: 0,
      smallMeetingCount: 0,
      lastMetAt: null,
      coAttendanceObservedSince: "2026-10-01T00:00:00.000Z",
      coAttendanceCountedThrough: "2026-11-03T00:00:00.000Z",
      coAttendanceNext14d: null,
    });
    expect(d.coAttendanceCoverage).toHaveBeenCalledWith("u1");
    expect(d.coAttendanceRow).toHaveBeenCalledWith("u1", "kim@partner.io");
  });

  it("a row: its raw values", async () => {
    const d = deps({ coAttendanceRow: vi.fn(async () => ROW) });
    expect(await load(d)).toMatchObject({
      meetingCount: 3,
      smallMeetingCount: 2,
      lastMetAt: "2026-10-30T00:00:00.000Z",
      coAttendanceObservedSince: "2026-10-01T00:00:00.000Z",
      coAttendanceCountedThrough: "2026-11-03T00:00:00.000Z",
      coAttendanceNext14d: null,
    });
  });

  it("at the edges: watermark exactly today − 2, a source observed exactly today − 30", async () => {
    const edge = coverage({
      countedThrough: day("2026-11-02"),
      sources: [source({ kind: "primary", id: "tok1", observedSince: day("2026-10-05") })],
    });
    const s = await load(deps({ coAttendanceCoverage: vi.fn(async () => edge) }));
    expect(s).toMatchObject({
      meetingCount: 0,
      coAttendanceObservedSince: "2026-10-05T00:00:00.000Z",
    });
  });
});

describe("co-attendance gate fails: every field null, even with a row", () => {
  const failing = async (cov: CoAttendanceCoverage) => {
    const d = deps({
      coAttendanceCoverage: vi.fn(async () => cov),
      coAttendanceRow: vi.fn(async () => ROW),
    });
    const s = await load(d);
    expect(s).toMatchObject(UNKNOWN);
    // The counts may be incomplete, so the row is never read.
    expect(d.coAttendanceRow).not.toHaveBeenCalled();
  };

  it("1. the flag is off: nothing is read", async () => {
    vi.stubEnv("CALENDAR_COATTENDANCE_ENABLED", "");
    const d = deps({ coAttendanceRow: vi.fn(async () => ROW) });
    expect(await load(d)).toMatchObject(UNKNOWN);
    expect(d.coAttendanceCoverage).not.toHaveBeenCalled();
    expect(d.coAttendanceRow).not.toHaveBeenCalled();
  });

  it("2. no watermark yet", async () => {
    await failing(coverage({ countedThrough: null }));
  });

  it("2. probe C: a watermark 3 days old, though every source's last pass is fresh", async () => {
    await failing(coverage({ countedThrough: day("2026-11-01") }));
  });

  it("3. a Google source never observed", async () => {
    await failing(
      coverage({
        sources: [source({ kind: "primary", id: "tok1" }), source({ observedSince: null })],
      }),
    );
  });

  it("3. a Google source observed for less than the full window (today − 29)", async () => {
    await failing(coverage({ sources: [source({ observedSince: day("2026-10-06") })] }));
  });

  it("3. probe A: a source that joined later (observed since yesterday)", async () => {
    await failing(
      coverage({
        sources: [
          source({ kind: "primary", id: "tok1", observedSince: day("2026-09-20") }),
          source({ id: "lc2", observedSince: day("2026-11-03") }),
        ],
      }),
    );
  });

  it("3. the user has no Google calendar source at all", async () => {
    await failing(coverage({ sources: [] }));
  });

  it("4. a Google source awaiting reconnect, though its marker covers the window", async () => {
    await failing(coverage({ sources: [source({ needsReconnect: true })] }));
  });

  it("5. the user has a calendar the store does not count (Outlook, CalDAV, device)", async () => {
    await failing(coverage({ hasNonGoogleSource: true }));
  });

  it("6. the sender is one of the user's own addresses: nothing is read", async () => {
    const d = deps({ coAttendanceRow: vi.fn(async () => ROW) });
    expect(await load(d, "Me <ME@acme.com>", [" Me@Acme.com "])).toMatchObject(UNKNOWN);
    expect(d.coAttendanceCoverage).not.toHaveBeenCalled();
    expect(d.coAttendanceRow).not.toHaveBeenCalled();
  });

  it("6. the sender's address cannot be normalised by the store: nothing is read", async () => {
    const d = deps({ coAttendanceRow: vi.fn(async () => ROW) });
    expect(await load(d, "josé@exemplo.com.br")).toMatchObject(UNKNOWN);
    expect(d.coAttendanceCoverage).not.toHaveBeenCalled();
  });

  it("a failed lookup is unknown, not a throw", async () => {
    const coverageDown = deps({
      coAttendanceCoverage: vi.fn(async () => Promise.reject(new Error("db"))),
    });
    expect(await load(coverageDown)).toMatchObject(UNKNOWN);
    const rowDown = deps({ coAttendanceRow: vi.fn(async () => Promise.reject(new Error("db"))) });
    expect(await load(rowDown)).toMatchObject(UNKNOWN);
  });
});

describe("coAttendanceWindow (the pure gate, conditions 2-5)", () => {
  it("is [latest marker, watermark], whatever the source order", () => {
    const a = source({ kind: "primary", id: "tok1", observedSince: day("2026-09-01") });
    const b = source({ observedSince: day("2026-10-02") });
    const expected = { observedSince: day("2026-10-02"), countedThrough: day("2026-11-03") };
    expect(coAttendanceWindow(coverage({ sources: [a, b] }), NOW)).toEqual(expected);
    expect(coAttendanceWindow(coverage({ sources: [b, a] }), NOW)).toEqual(expected);
  });

  it("is null when any condition fails", () => {
    expect(coAttendanceWindow(coverage({ countedThrough: day("2026-11-01") }), NOW)).toBeNull();
    expect(
      coAttendanceWindow(
        coverage({ sources: [source({ observedSince: day("2026-11-03") })] }),
        NOW,
      ),
    ).toBeNull();
    expect(
      coAttendanceWindow(coverage({ sources: [source({ needsReconnect: true })] }), NOW),
    ).toBeNull();
    expect(coAttendanceWindow(coverage({ hasNonGoogleSource: true }), NOW)).toBeNull();
    expect(coAttendanceWindow(coverage({ sources: [] }), NOW)).toBeNull();
  });

  it("does not use a source's last pass time: a stale one does not fail the gate", () => {
    // Freshness is the watermark's job (probe C); lastPassAt is the job's interval.
    const stale = source({ lastPassAt: new Date("2026-09-01T00:00:00Z") });
    expect(coAttendanceWindow(coverage({ sources: [stale] }), NOW)).not.toBeNull();
  });
});
