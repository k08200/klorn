import { describe, expect, it } from "vitest";
import {
  type DueBackfillRow,
  planDueBackfill,
  summarizeDueBackfill,
} from "../pim/commitment-due-backfill.js";

// Thursday 2026-11-12, 10:00 in Seoul.
const RECEIVED = new Date("2026-11-12T01:00:00.000Z");

function row(overrides: Partial<DueBackfillRow>): DueBackfillRow {
  return {
    id: "c-1",
    userId: "u-1",
    dueText: null,
    evidenceText: null,
    createdAt: new Date("2026-11-12T01:05:00.000Z"),
    sourceReceivedAt: RECEIVED,
    ...overrides,
  };
}

describe("planDueBackfill", () => {
  it("resolves stored wording against the source email's received time", () => {
    const decision = planDueBackfill(row({ dueText: "내일" }), "Asia/Seoul");
    expect(decision).toMatchObject({ outcome: "resolved", dueText: "내일" });
    expect(decision.dueAt?.toISOString()).toBe("2026-11-13T14:59:00.000Z");
    expect(decision.dueTextFromEvidence).toBe(false);
  });

  it("recovers wording the old extractor missed from the evidence text", () => {
    const decision = planDueBackfill(
      row({ evidenceText: "Dana will send the signed copy by Friday." }),
      "Asia/Seoul",
    );
    expect(decision).toMatchObject({
      outcome: "resolved",
      dueText: "Friday",
      dueTextFromEvidence: true,
    });
    expect(decision.dueAt?.toISOString()).toBe("2026-11-13T14:59:00.000Z");
  });

  it("falls back to the row's creation time when the source email is gone", () => {
    const decision = planDueBackfill(
      row({ dueText: "tomorrow", sourceReceivedAt: null, createdAt: RECEIVED }),
      "America/New_York",
    );
    expect(decision.usedCreatedAt).toBe(true);
    expect(decision.dueAt?.toISOString()).toBe("2026-11-13T04:59:00.000Z");
  });

  it("leaves ambiguous and missing wording without a dueAt", () => {
    expect(planDueBackfill(row({ dueText: "8시" }), "Asia/Seoul")).toMatchObject({
      outcome: "ambiguous",
      dueAt: null,
    });
    expect(
      planDueBackfill(row({ evidenceText: "I'll send it soon." }), "Asia/Seoul"),
    ).toMatchObject({ outcome: "noPhrase", dueAt: null, dueText: null });
  });
});

describe("summarizeDueBackfill", () => {
  it("counts outcomes without exposing any row content", () => {
    const decisions = [
      planDueBackfill(row({ dueText: "내일" }), "Asia/Seoul"),
      planDueBackfill(row({ evidenceText: "Dana will send it by Friday." }), "Asia/Seoul"),
      planDueBackfill(row({ dueText: "8시" }), "Asia/Seoul"),
      planDueBackfill(row({ evidenceText: "I'll send it soon." }), "Asia/Seoul"),
      planDueBackfill(row({ dueText: "after the offsite" }), "Asia/Seoul"),
    ];

    const summary = summarizeDueBackfill(decisions, new Date("2026-11-13T12:00:00.000Z"));

    expect(summary).toEqual({
      scanned: 5,
      resolved: 2,
      resolvedAlreadyPast: 0,
      ambiguous: 1,
      unrecognized: 1,
      noPhrase: 1,
      dueTextFromEvidence: 1,
      referenceFromCreatedAt: 0,
    });
    expect(summarizeDueBackfill(decisions, new Date("2026-11-20T00:00:00.000Z"))).toMatchObject({
      resolvedAlreadyPast: 2,
    });
  });
});
