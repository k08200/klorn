import { describe, expect, it, vi } from "vitest";
import {
  loadRelationshipSnapshot,
  type RelationshipLoaderDeps,
} from "../judge/v3/relationship-loader.js";

const t = (iso: string) => new Date(iso);

function deps(over: Partial<RelationshipLoaderDeps> = {}): RelationshipLoaderDeps {
  return {
    hasAnySent: vi.fn(async () => true),
    sentRowsMentioning: vi.fn(async (_u: string, _a: string, order: "asc" | "desc") =>
      order === "desc"
        ? [
            { sentAt: t("2026-10-01T03:00:00Z"), to: "sarah@partner.io", threadId: "th1" },
            { sentAt: t("2026-10-02T00:00:00Z"), to: "sarahb@partner.io", threadId: "th2" },
          ]
        : [
            { sentAt: t("2026-06-01T00:00:00Z"), to: "jimsarah@partner.io", threadId: "old" },
            { sentAt: t("2026-07-01T00:00:00Z"), to: "Sarah <sarah@partner.io>", threadId: "th0" },
          ],
    ),
    inboundMentioning: vi.fn(async (_u: string, _a: string, order: "asc" | "desc") =>
      order === "desc"
        ? [
            {
              threadId: "th1",
              receivedAt: t("2026-10-01T00:00:00Z"),
              from: "Sarah <sarah@partner.io>",
              fromAddress: null,
            },
            {
              threadId: "th9",
              receivedAt: t("2026-09-30T00:00:00Z"),
              from: "x",
              fromAddress: "notsarah@partner.io",
            },
          ]
        : [
            {
              threadId: "th0",
              receivedAt: t("2026-08-01T00:00:00Z"),
              from: "sarah@partner.io",
              fromAddress: null,
            },
          ],
    ),
    sentInThreads: vi.fn(async () => [{ sentAt: t("2026-10-01T03:00:00Z"), threadId: "th1" }]),
    dismissCount: vi.fn(async () => 2),
    pinnedTier: vi.fn(async () => null),
    senderCategory: vi.fn(async () => "investor"),
    ...over,
  };
}

describe("loadRelationshipSnapshot", () => {
  it("assembles the snapshot from the user's own rows, sender matched exactly", async () => {
    const d = deps();
    const s = await loadRelationshipSnapshot(
      { userId: "u1", senderAddress: "Sarah <Sarah@Partner.io>", userAddresses: ["me@acme.com"] },
      d,
    );
    expect(s).toEqual({
      sentCount: 1,
      lastSentAt: "2026-10-01T03:00:00.000Z",
      medianReplyLatencyMs: 3 * 3_600_000,
      sameOrgDomain: false,
      coAttendanceNext14d: null,
      pinned: false,
      vip: true,
      dismissCount: 2,
      inboundCount: 1,
      inboundThreadCount: 1,
      repliedThreadCount: 1,
      userInitiatedThreadCount: 0,
      firstSeenAt: "2026-07-01T00:00:00.000Z",
    });
    expect(d.sentRowsMentioning).toHaveBeenCalledWith("u1", "sarah@partner.io", "desc");
    expect(d.sentInThreads).toHaveBeenCalledWith("u1", ["th1"]);
  });

  it("reports sent-mail fields as unknown when the user has no sent mail synced", async () => {
    const d = deps({ hasAnySent: vi.fn(async () => false) });
    const s = await loadRelationshipSnapshot(
      { userId: "u1", senderAddress: "sarah@partner.io", userAddresses: [] },
      d,
    );
    expect(s.sentCount).toBeNull();
    expect(s.repliedThreadCount).toBeNull();
    expect(s.inboundCount).toBe(1);
    expect(d.sentRowsMentioning).not.toHaveBeenCalled();
    expect(d.sentInThreads).not.toHaveBeenCalled();
  });

  it("degrades a failed lookup to unknown (null) instead of throwing", async () => {
    const boom = async () => {
      throw new Error("db down");
    };
    const s = await loadRelationshipSnapshot(
      { userId: "u1", senderAddress: "sarah@partner.io", userAddresses: ["me@acme.com"] },
      deps({
        sentRowsMentioning: vi.fn(boom),
        inboundMentioning: vi.fn(boom),
        dismissCount: vi.fn(boom),
        senderCategory: vi.fn(boom),
        pinnedTier: vi.fn(boom),
      }),
    );
    expect(s.sentCount).toBeNull();
    expect(s.inboundCount).toBeNull();
    expect(s.firstSeenAt).toBeNull();
    expect(s.dismissCount).toBeNull();
    expect(s.pinned).toBeNull();
    expect(s.vip).toBeNull();
  });

  it("returns an all-unknown snapshot for an unparseable sender without querying", async () => {
    const d = deps();
    for (const from of ["", 'x" ceo@acme.com']) {
      const s = await loadRelationshipSnapshot(
        { userId: "u1", senderAddress: from, userAddresses: [] },
        d,
      );
      expect(s.sentCount).toBeNull();
      expect(s.pinned).toBeNull();
    }
    expect(d.hasAnySent).not.toHaveBeenCalled();
  });

  it("passes the mail's authentication through to same-organisation", async () => {
    const s = await loadRelationshipSnapshot(
      {
        userId: "u1",
        senderAddress: "kim@acme.com",
        userAddresses: ["me@acme.com"],
        senderAuthenticated: true,
      },
      deps(),
    );
    expect(s.sameOrgDomain).toBe(true);
  });
});
