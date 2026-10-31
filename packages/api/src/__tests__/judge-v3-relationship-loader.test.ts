import { describe, expect, it, vi } from "vitest";
import {
  loadRelationshipSnapshot,
  type RelationshipLoaderDeps,
} from "../judge/v3/relationship-loader.js";

const t = (iso: string) => new Date(iso);

function deps(over: Partial<RelationshipLoaderDeps> = {}): RelationshipLoaderDeps {
  return {
    hasAnySent: vi.fn(async () => true),
    sentRowsMentioning: vi.fn(async () => [
      { sentAt: t("2026-10-01T03:00:00Z"), to: "sarah@partner.io", threadId: "th1" },
      { sentAt: t("2026-10-02T00:00:00Z"), to: "sarahb@partner.io", threadId: "th2" },
    ]),
    inboundInThreads: vi.fn(async () => [
      {
        threadId: "th1",
        receivedAt: t("2026-10-01T00:00:00Z"),
        from: "Sarah <sarah@partner.io>",
        fromAddress: null,
      },
      {
        threadId: "th1",
        receivedAt: t("2026-09-30T00:00:00Z"),
        from: "x",
        fromAddress: "other@partner.io",
      },
    ]),
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
    });
    expect(d.sentRowsMentioning).toHaveBeenCalledWith("u1", "sarah@partner.io");
    // Only threads the user actually wrote to the sender in.
    expect(d.inboundInThreads).toHaveBeenCalledWith("u1", ["th1"]);
  });

  it("reports sent-mail fields as unknown when the user has no sent mail synced", async () => {
    const d = deps({ hasAnySent: vi.fn(async () => false) });
    const s = await loadRelationshipSnapshot(
      { userId: "u1", senderAddress: "sarah@partner.io", userAddresses: [] },
      d,
    );
    expect(s.sentCount).toBeNull();
    expect(s.medianReplyLatencyMs).toBeNull();
    expect(d.sentRowsMentioning).not.toHaveBeenCalled();
  });

  it("degrades a failed lookup to unknown (null) instead of throwing", async () => {
    const boom = async () => {
      throw new Error("db down");
    };
    const s = await loadRelationshipSnapshot(
      { userId: "u1", senderAddress: "sarah@partner.io", userAddresses: ["me@acme.com"] },
      deps({
        sentRowsMentioning: vi.fn(boom),
        dismissCount: vi.fn(boom),
        senderCategory: vi.fn(boom),
        pinnedTier: vi.fn(boom),
      }),
    );
    expect(s.sentCount).toBeNull();
    expect(s.dismissCount).toBeNull();
    expect(s.pinned).toBeNull();
    expect(s.vip).toBeNull();
  });

  it("returns an all-unknown snapshot for an unparseable sender without querying", async () => {
    const d = deps();
    const s = await loadRelationshipSnapshot(
      { userId: "u1", senderAddress: "", userAddresses: [] },
      d,
    );
    expect(s.sentCount).toBeNull();
    expect(s.pinned).toBeNull();
    expect(d.hasAnySent).not.toHaveBeenCalled();
  });
});
