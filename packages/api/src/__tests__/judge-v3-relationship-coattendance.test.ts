import { describe, expect, it } from "vitest";
import {
  buildRelationshipSnapshot,
  parseRelationshipSnapshot,
  type RelationshipInput,
} from "../judge/v3/relationship.js";

const base = (over: Partial<RelationshipInput> = {}): RelationshipInput => ({
  senderAddress: "kim@partner.io",
  userAddresses: ["me@acme.com"],
  sent: [],
  inbound: [],
  userSentInSenderThreads: [],
  firstInboundAt: null,
  firstSentAt: null,
  senderAuthenticated: null,
  dismissCount: 0,
  pinnedTier: null,
  senderCategory: null,
  coAttendance: undefined,
  ...over,
});

const since = new Date("2026-10-02T00:00:00Z");

describe("relationship snapshot: past calendar co-attendance", () => {
  it("is unknown (null) unless every calendar source has been observed", () => {
    const s = buildRelationshipSnapshot(base({ coAttendance: undefined }));
    expect(s).toMatchObject({
      meetingCount: null,
      smallMeetingCount: null,
      lastMetAt: null,
      coAttendanceObservedSince: null,
    });
  });

  it("observed with no row means never met in the window: 0, not null", () => {
    const s = buildRelationshipSnapshot(
      base({ coAttendance: { observedSince: since, row: null } }),
    );
    expect(s).toMatchObject({
      meetingCount: 0,
      smallMeetingCount: 0,
      lastMetAt: null,
      coAttendanceObservedSince: "2026-10-02T00:00:00.000Z",
    });
  });

  it("passes the stored counts and last day through as raw values", () => {
    const s = buildRelationshipSnapshot(
      base({
        coAttendance: {
          observedSince: since,
          row: {
            meetingCount: 4,
            smallMeetingCount: 1,
            lastMetAt: new Date("2026-10-28T00:00:00Z"),
          },
        },
      }),
    );
    expect(s).toMatchObject({
      meetingCount: 4,
      smallMeetingCount: 1,
      lastMetAt: "2026-10-28T00:00:00.000Z",
      coAttendanceObservedSince: "2026-10-02T00:00:00.000Z",
    });
  });

  it("keeps the deprecated upcoming field null", () => {
    const s = buildRelationshipSnapshot(
      base({ coAttendance: { observedSince: since, row: null } }),
    );
    expect(s.coAttendanceNext14d).toBeNull();
  });

  it("round-trips through storage, and older rows read the new fields as null", () => {
    const s = buildRelationshipSnapshot(
      base({ coAttendance: { observedSince: since, row: null } }),
    );
    expect(parseRelationshipSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
    const old = {
      sentCount: 1,
      lastSentAt: null,
      medianReplyLatencyMs: null,
      sameOrgDomain: false,
      coAttendanceNext14d: null,
      pinned: false,
      vip: null,
      dismissCount: 0,
    };
    expect(parseRelationshipSnapshot(old)).toMatchObject({
      meetingCount: null,
      coAttendanceObservedSince: null,
    });
    expect(parseRelationshipSnapshot({ ...old, meetingCount: "3" })).toBeNull();
  });
});
