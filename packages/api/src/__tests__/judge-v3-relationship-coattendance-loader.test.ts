/**
 * Co-attendance in the relationship loader (#1604 store): a missing contact row
 * is 0 meetings only when the flag is on and every Google calendar source has
 * been observed; otherwise the fields are unknown (null).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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
const load = () =>
  loadRelationshipSnapshot({
    userId: "u1",
    senderAddress: "Kim <Kim@Partner.io>",
    userAddresses: [],
  });

beforeEach(() => {
  vi.clearAllMocks();
  enabled.mockReturnValue(true);
  tokenFind.mockResolvedValue({ coAttendanceObservedSince: d("2026-10-02T00:00:00Z") });
  linkedFind.mockResolvedValue([
    { coAttendanceObservedSince: d("2026-10-05T00:00:00Z"), needsReconnect: false },
  ]);
  coFind.mockResolvedValue(null);
});

describe("latestObservedSince", () => {
  it("is the latest marker when every source has one, else null", () => {
    expect(latestObservedSince([d("2026-10-02T00:00:00Z"), d("2026-10-05T00:00:00Z")])).toEqual(
      d("2026-10-05T00:00:00Z"),
    );
    expect(latestObservedSince([d("2026-10-02T00:00:00Z"), null])).toBeNull();
    expect(latestObservedSince([])).toBeNull();
  });
});

describe("co-attendance in the relationship snapshot", () => {
  it("every source observed and no row: 0 meetings, window from the latest marker", async () => {
    const s = await load();
    expect(s).toMatchObject({
      meetingCount: 0,
      smallMeetingCount: 0,
      lastMetAt: null,
      coAttendanceObservedSince: "2026-10-05T00:00:00.000Z",
    });
    const [arg] = coFind.mock.calls[0] as unknown as [{ where: unknown }];
    expect(arg.where).toEqual({
      userId_contactEmail: { userId: "u1", contactEmail: "kim@partner.io" },
    });
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

  it("unknown (null) when the flag is off, without reading the store", async () => {
    enabled.mockReturnValue(false);
    expect((await load()).meetingCount).toBeNull();
    expect(tokenFind).not.toHaveBeenCalled();
    expect(coFind).not.toHaveBeenCalled();
  });

  it("unknown when any Google source has not been observed, or needs a reconnect", async () => {
    linkedFind.mockResolvedValueOnce([{ coAttendanceObservedSince: null, needsReconnect: false }]);
    expect((await load()).meetingCount).toBeNull();
    linkedFind.mockResolvedValueOnce([
      { coAttendanceObservedSince: d("2026-10-05T00:00:00Z"), needsReconnect: true },
    ]);
    expect((await load()).meetingCount).toBeNull();
  });

  it("unknown when the user has no Google calendar at all", async () => {
    tokenFind.mockResolvedValue(null);
    linkedFind.mockResolvedValue([]);
    expect((await load()).meetingCount).toBeNull();
  });

  it("unknown, not a throw, when the lookup fails", async () => {
    coFind.mockRejectedValue(new Error("db down"));
    const s = await load();
    expect(s.meetingCount).toBeNull();
    expect(s.coAttendanceObservedSince).toBeNull();
  });
});
