import { describe, expect, it } from "vitest";
import {
  buildRelationshipSnapshot,
  medianReplyLatencyMs,
  type RelationshipInput,
} from "../judge/v3/relationship.js";

const H = 3_600_000;
const t = (iso: string) => new Date(iso);

const base = (over: Partial<RelationshipInput> = {}): RelationshipInput => ({
  senderAddress: "Sarah Kim <Sarah@Partner.io>",
  userAddresses: ["me@acme.com"],
  sent: [],
  inbound: [],
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
    const unknown = buildRelationshipSnapshot(base({ sent: null }));
    expect(unknown.sentCount).toBeNull();
    expect(unknown.lastSentAt).toBeNull();
    expect(unknown.medianReplyLatencyMs).toBeNull();
    const never = buildRelationshipSnapshot(base({ sent: [] }));
    expect(never.sentCount).toBe(0);
    expect(never.lastSentAt).toBeNull();
  });

  it("same organisation only for a shared non-public domain", () => {
    expect(buildRelationshipSnapshot(base({ senderAddress: "kim@acme.com" })).sameOrgDomain).toBe(
      true,
    );
    expect(buildRelationshipSnapshot(base()).sameOrgDomain).toBe(false);
    expect(
      buildRelationshipSnapshot(
        base({ senderAddress: "a@gmail.com", userAddresses: ["me@gmail.com"] }),
      ).sameOrgDomain,
    ).toBe(false);
    expect(buildRelationshipSnapshot(base({ userAddresses: [] })).sameOrgDomain).toBeNull();
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

  it("passes the dismiss count through, null when unknown", () => {
    expect(buildRelationshipSnapshot(base({ dismissCount: 4 })).dismissCount).toBe(4);
    expect(buildRelationshipSnapshot(base({ dismissCount: null })).dismissCount).toBeNull();
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

describe("medianReplyLatencyMs", () => {
  it("measures from the first unanswered inbound to the user's reply, per thread", () => {
    const ms = medianReplyLatencyMs(
      [
        { sentAt: t("2026-10-01T02:00:00Z"), threadId: "a" },
        { sentAt: t("2026-10-05T10:00:00Z"), threadId: "b" },
        { sentAt: t("2026-10-06T00:00:00Z"), threadId: "b" },
      ],
      [
        { receivedAt: t("2026-10-01T00:00:00Z"), threadId: "a" },
        { receivedAt: t("2026-10-01T01:00:00Z"), threadId: "a" },
        { receivedAt: t("2026-10-05T04:00:00Z"), threadId: "b" },
        // after the first reply in b: the second reply answers this one
        { receivedAt: t("2026-10-05T20:00:00Z"), threadId: "b" },
      ],
    );
    // a: 2h; b: 6h, then 4h → median of [2h, 4h, 6h] = 4h
    expect(ms).toBe(4 * H);
  });

  it("ignores replies with no preceding inbound and stale gaps over 30 days", () => {
    expect(
      medianReplyLatencyMs(
        [
          { sentAt: t("2026-10-01T00:00:00Z"), threadId: "a" },
          { sentAt: t("2026-12-01T00:00:00Z"), threadId: "b" },
        ],
        [{ receivedAt: t("2026-10-01T00:00:00Z"), threadId: "b" }],
      ),
    ).toBeNull();
  });

  it("averages the two middle values for an even count and skips thread-less rows", () => {
    expect(
      medianReplyLatencyMs(
        [
          { sentAt: t("2026-10-01T01:00:00Z"), threadId: "a" },
          { sentAt: t("2026-10-02T03:00:00Z"), threadId: "b" },
          { sentAt: t("2026-10-03T03:00:00Z"), threadId: null },
        ],
        [
          { receivedAt: t("2026-10-01T00:00:00Z"), threadId: "a" },
          { receivedAt: t("2026-10-02T00:00:00Z"), threadId: "b" },
          { receivedAt: t("2026-10-03T00:00:00Z"), threadId: null },
        ],
      ),
    ).toBe(2 * H);
  });
});
