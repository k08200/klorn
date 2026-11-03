/**
 * Co-attendance in the relationship loader (#1604 store): a missing contact row
 * is 0 meetings only when the flag is on and every Google calendar source is
 * observed and still being counted; otherwise the fields are unknown (null).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tokenFind = vi.hoisted(() => vi.fn());
const linkedFind = vi.hoisted(() => vi.fn());
const coFind = vi.hoisted(() => vi.fn());
const enabled = vi.hoisted(() => vi.fn(() => true));

vi.mock("../db.js", () => ({
  db: {
    sentMessage: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    emailMessage: { findMany: vi.fn(async () => []) },
    contactEngagementScore: { findUnique: vi.fn(async () => null) },
    userToken: { findUnique: tokenFind },
    linkedCalendarAccount: { findMany: linkedFind },
    contactCoAttendance: { findUnique: coFind },
  },
  prisma: {},
}));
vi.mock("../config.js", async (orig) => ({
  ...(await orig<typeof import("../config.js")>()),
  calendarCoattendanceEnabled: enabled,
}));
vi.mock("../judge/judge-context.js", () => ({
  lookupPinnedTier: vi.fn(async () => null),
  isSenderAddressIndexEnabled: () => false,
}));
vi.mock("../mail/sender-labels.js", () => ({ senderLabelsFor: vi.fn(async () => new Map()) }));

import { latestObservedSince, loadRelationshipSnapshot } from "../judge/v3/relationship-loader.js";

const d = (iso: string) => new Date(iso);
const recent = d("2026-11-02T06:00:00Z");
const load = (senderAddress = "Kim <Kim@Partner.io>", userAddresses = ["me@acme.com"]) =>
  loadRelationshipSnapshot({ userId: "u1", senderAddress, userAddresses });
const source = (since: string | null, lastPass: Date | null = recent, needsReconnect = false) => ({
  coAttendanceObservedSince: since ? d(since) : null,
  coAttendanceLastPassAt: lastPass,
  needsReconnect,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: d("2026-11-03T00:00:00Z"), toFake: ["Date"] });
  enabled.mockReturnValue(true);
  tokenFind.mockResolvedValue(source("2026-10-02T00:00:00Z"));
  linkedFind.mockResolvedValue([source("2026-10-05T00:00:00Z")]);
  coFind.mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("latestObservedSince", () => {
  it("is the latest marker when every source has one, in any order; else null", () => {
    const later = d("2026-10-05T00:00:00Z");
    expect(latestObservedSince([d("2026-10-02T00:00:00Z"), later])).toEqual(later);
    expect(latestObservedSince([later, d("2026-10-02T00:00:00Z")])).toEqual(later);
    expect(latestObservedSince([d("2026-10-02T00:00:00Z"), null])).toBeNull();
    expect(latestObservedSince([])).toBeNull();
  });
});

describe("co-attendance in the relationship snapshot", () => {
  it("every source observed and no row: 0 meetings, window from the latest marker", async () => {
    expect(await load()).toMatchObject({
      meetingCount: 0,
      smallMeetingCount: 0,
      lastMetAt: null,
      coAttendanceObservedSince: "2026-10-05T00:00:00.000Z",
    });
    const where = (m: typeof coFind) =>
      (m.mock.calls[0] as unknown as [{ where: unknown }])[0].where;
    expect(where(coFind)).toEqual({
      userId_contactEmail: { userId: "u1", contactEmail: "kim@partner.io" },
    });
    expect(where(tokenFind)).toEqual({ userId_provider: { userId: "u1", provider: "google" } });
    expect(where(linkedFind)).toMatchObject({ userId: "u1", provider: "GOOGLE" });
  });

  it("passes stored counts through", async () => {
    coFind.mockResolvedValue({
      meetingCount: 3,
      smallMeetingCount: 2,
      lastMetAt: d("2026-10-30T00:00:00Z"),
    });
    expect(await load()).toMatchObject({
      meetingCount: 3,
      smallMeetingCount: 2,
      lastMetAt: "2026-10-30T00:00:00.000Z",
    });
  });

  it("unknown when the flag is off, without reading anything", async () => {
    enabled.mockReturnValue(false);
    expect((await load()).meetingCount).toBeNull();
    expect(tokenFind).not.toHaveBeenCalled();
    expect(linkedFind).not.toHaveBeenCalled();
    expect(coFind).not.toHaveBeenCalled();
  });

  it("unknown when any source is unobserved, awaiting reconnect, or stopped being counted", async () => {
    linkedFind.mockResolvedValueOnce([source(null)]);
    expect((await load()).meetingCount).toBeNull();
    linkedFind.mockResolvedValueOnce([source("2026-10-05T00:00:00Z", recent, true)]);
    expect((await load()).meetingCount).toBeNull();
    tokenFind.mockResolvedValueOnce(source(null, null));
    expect((await load()).meetingCount).toBeNull();
    // Last pass older than the 30-day lookback: there is a hole the marker can't show.
    tokenFind.mockResolvedValueOnce(source("2026-09-01T00:00:00Z", d("2026-09-20T00:00:00Z")));
    expect((await load()).meetingCount).toBeNull();
  });

  it("unknown when the user has no Google calendar at all", async () => {
    tokenFind.mockResolvedValue(null);
    linkedFind.mockResolvedValue([]);
    expect((await load()).meetingCount).toBeNull();
  });

  it("unknown for addresses the store never counts: the user's own, or non-ASCII", async () => {
    expect((await load("Me <ME@acme.com>")).meetingCount).toBeNull();
    expect((await load("josé@exemplo.com.br")).meetingCount).toBeNull();
    expect(coFind).not.toHaveBeenCalled();
  });

  it("unknown, not a throw, when the lookup fails", async () => {
    coFind.mockRejectedValue(new Error("db down"));
    const s = await load();
    expect(s.meetingCount).toBeNull();
    expect(s.coAttendanceObservedSince).toBeNull();
  });
});
