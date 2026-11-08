import { describe, expect, it } from "vitest";
import {
  buildRelationshipSnapshot,
  parseRelationshipSnapshot,
  type RelationshipInput,
  UNKNOWN_RELATIONSHIP,
} from "../judge/v3/relationship.js";
import {
  medianReplyLatencyMs,
  replyThreadCounts,
  userInitiatedThreadCount,
} from "../judge/v3/relationship-threads.js";

const H = 3_600_000;
const t = (iso: string) => new Date(iso);

const base = (over: Partial<RelationshipInput> = {}): RelationshipInput => ({
  senderAddress: "Sarah Kim <Sarah@Partner.io>",
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
  ...over,
});

describe("buildRelationshipSnapshot", () => {
  it("counts only mail written exactly to the sender (no substring collisions)", () => {
    const s = buildRelationshipSnapshot(
      base({
        sent: [
          { sentAt: t("2026-10-01T00:00:00Z"), to: "sarah@partner.io", threadId: "a" },
          {
            sentAt: t("2026-10-20T00:00:00Z"),
            to: "Bob <bob@x.com>, SARAH@partner.io",
            threadId: "b",
          },
          { sentAt: t("2026-10-25T00:00:00Z"), to: "jimsarah@partner.io", threadId: "c" },
        ],
      }),
    );
    expect(s.sentCount).toBe(2);
    expect(s.lastSentAt).toBe("2026-10-20T00:00:00.000Z");
  });

  it("distinguishes unknown (no sent-mail sync) from never written", () => {
    const unknown = buildRelationshipSnapshot(base({ sent: null, userSentInSenderThreads: null }));
    expect(unknown.sentCount).toBeNull();
    expect(unknown.medianReplyLatencyMs).toBeNull();
    expect(unknown.userInitiatedThreadCount).toBeNull();
    expect(unknown.repliedThreadCount).toBeNull();
    const never = buildRelationshipSnapshot(base({ sent: [] }));
    expect(never.sentCount).toBe(0);
    expect(never.lastSentAt).toBeNull();
  });

  it("lifts same organisation only for an authenticated mail; unauthenticated is unknown", () => {
    const same = { senderAddress: "kim@acme.com" };
    expect(
      buildRelationshipSnapshot(base({ ...same, senderAuthenticated: true })).sameOrgDomain,
    ).toBe(true);
    expect(
      buildRelationshipSnapshot(base({ ...same, senderAuthenticated: null })).sameOrgDomain,
    ).toBeNull();
    expect(
      buildRelationshipSnapshot(base({ ...same, senderAuthenticated: false })).sameOrgDomain,
    ).toBeNull();
    expect(buildRelationshipSnapshot(base()).sameOrgDomain).toBe(false);
    expect(
      buildRelationshipSnapshot(
        base({
          senderAddress: "a@gmail.com",
          userAddresses: ["me@gmail.com"],
          senderAuthenticated: true,
        }),
      ).sameOrgDomain,
    ).toBe(false);
    expect(buildRelationshipSnapshot(base({ userAddresses: [] })).sameOrgDomain).toBeNull();
  });

  it("returns all-unknown for a From with no parseable mailbox (no garbage keys)", () => {
    for (const from of [
      'x" ceo@acme.com',
      "<a@b.com> <c@d.com> ceo@acme.com",
      "",
      "not an address",
    ]) {
      expect(
        buildRelationshipSnapshot(base({ senderAddress: from, senderAuthenticated: true })),
      ).toEqual(UNKNOWN_RELATIONSHIP);
    }
  });

  it("reports calendar co-attendance as unknown: stored events carry no attendees", () => {
    expect(buildRelationshipSnapshot(base()).coAttendanceNext14d).toBeNull();
  });

  it("pinned and vip from pins and sender labels; unknown stays null", () => {
    expect(buildRelationshipSnapshot(base({ pinnedTier: "QUEUE" })).pinned).toBe(true);
    expect(buildRelationshipSnapshot(base({ pinnedTier: null })).pinned).toBe(false);
    expect(buildRelationshipSnapshot(base({ pinnedTier: undefined })).pinned).toBeNull();
    expect(buildRelationshipSnapshot(base({ senderCategory: "investor" })).vip).toBe(true);
    expect(buildRelationshipSnapshot(base({ senderCategory: "customer" })).vip).toBe(true);
    expect(buildRelationshipSnapshot(base({ senderCategory: "promotions" })).vip).toBe(false);
    expect(buildRelationshipSnapshot(base({ pinnedTier: "PUSH" })).vip).toBe(true);
    expect(
      buildRelationshipSnapshot(base({ senderCategory: undefined, pinnedTier: undefined })).vip,
    ).toBeNull();
  });

  it("inbound reciprocity: raw counts, never a rate", () => {
    const s = buildRelationshipSnapshot(
      base({
        inbound: [
          { receivedAt: t("2026-10-01T00:00:00Z"), threadId: "a" },
          { receivedAt: t("2026-10-02T00:00:00Z"), threadId: "a" },
          { receivedAt: t("2026-10-03T00:00:00Z"), threadId: "b" },
        ],
        userSentInSenderThreads: [{ sentAt: t("2026-10-01T05:00:00Z"), threadId: "a" }],
      }),
    );
    expect(s.inboundCount).toBe(3);
    expect(s.inboundThreadCount).toBe(2);
    expect(s.repliedThreadCount).toBe(1);
    expect(buildRelationshipSnapshot(base({ inbound: null })).inboundCount).toBeNull();
  });

  it("first seen is the earliest contact either way", () => {
    const s = buildRelationshipSnapshot(
      base({ firstInboundAt: t("2026-06-01T00:00:00Z"), firstSentAt: t("2026-05-01T00:00:00Z") }),
    );
    expect(s.firstSeenAt).toBe("2026-05-01T00:00:00.000Z");
    expect(
      buildRelationshipSnapshot(base({ firstInboundAt: undefined, firstSentAt: undefined }))
        .firstSeenAt,
    ).toBeNull();
  });

  it("is pure", () => {
    const input = base({
      sent: [{ sentAt: t("2026-10-01T00:00:00Z"), to: "sarah@partner.io", threadId: "a" }],
    });
    const before = structuredClone(input);
    expect(buildRelationshipSnapshot(input)).toEqual(buildRelationshipSnapshot(input));
    expect(input).toEqual(before);
  });
});

describe("relationship thread math", () => {
  const sent = (iso: string, threadId: string | null) => ({ at: t(iso), threadId });
  const got = (iso: string, threadId: string | null) => ({ at: t(iso), threadId });

  it("latency: first unanswered inbound to the user's reply, per thread; median", () => {
    const ms = medianReplyLatencyMs(
      [
        sent("2026-10-01T02:00:00Z", "a"),
        sent("2026-10-05T10:00:00Z", "b"),
        sent("2026-10-06T00:00:00Z", "b"),
      ],
      [
        got("2026-10-01T00:00:00Z", "a"),
        got("2026-10-01T01:00:00Z", "a"),
        got("2026-10-05T04:00:00Z", "b"),
        got("2026-10-05T20:00:00Z", "b"),
      ],
    );
    expect(ms).toBe(4 * H);
  });

  it("latency ignores replies with no preceding inbound, stale gaps and thread-less rows", () => {
    expect(
      medianReplyLatencyMs(
        [
          sent("2026-10-01T00:00:00Z", "a"),
          sent("2026-12-01T00:00:00Z", "b"),
          sent("2026-10-03T03:00:00Z", null),
        ],
        [got("2026-10-01T00:00:00Z", "b"), got("2026-10-03T00:00:00Z", null)],
      ),
    ).toBeNull();
  });

  it("reply rate counts threads, not mails", () => {
    expect(
      replyThreadCounts(
        [got("2026-10-01T00:00:00Z", "a"), got("2026-10-02T00:00:00Z", "b")],
        [sent("2026-09-30T00:00:00Z", "b"), sent("2026-10-01T03:00:00Z", "a")],
      ),
    ).toEqual({ inboundThreadCount: 2, repliedThreadCount: 1 });
  });

  it("user-initiated: the user's mail opens the thread", () => {
    expect(
      userInitiatedThreadCount(
        [sent("2026-10-01T00:00:00Z", "a"), sent("2026-10-03T00:00:00Z", "b")],
        [got("2026-10-01T05:00:00Z", "a"), got("2026-10-02T00:00:00Z", "b")],
      ),
    ).toBe(1);
  });
});

describe("parseRelationshipSnapshot", () => {
  it("reads rows written before newer fields existed as null for those fields", () => {
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
    const r = parseRelationshipSnapshot(old);
    expect(r?.sentCount).toBe(1);
    expect(r?.inboundCount).toBeNull();
    expect(r?.firstSeenAt).toBeNull();
  });
});
