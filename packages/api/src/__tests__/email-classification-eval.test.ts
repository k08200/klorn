import { describe, expect, it } from "vitest";
import { dogfoodEmailClassificationFixtures } from "../__fixtures__/email-classification/dogfood.js";
import {
  evaluateEmailPriorityFixtures,
  evaluateUserCorrectionFixtures,
} from "../email-classification-eval.js";
import type { UserCorrectionFixture } from "../mail/email-feedback-fixtures.js";

describe("email classification eval", () => {
  it("replays curated dogfood fixtures through the same heuristic gate", () => {
    const report = evaluateEmailPriorityFixtures(dogfoodEmailClassificationFixtures);

    expect(report.total).toBe(dogfoodEmailClassificationFixtures.length);
    expect(report.matched).toBe(report.total);
    expect(report.mismatches).toEqual([]);
    expect(report.matchRate).toBe(1);
  });

  it("summarizes user corrections without mutating classifier behavior", () => {
    const fixtures: UserCorrectionFixture[] = [
      {
        id: "feedback-fixed",
        capturedAt: "2026-04-28T00:00:00.000Z",
        from: "Mina Park <mina@alpha-capital.com>",
        subject: "Re: Seed round follow-up",
        labels: ["INBOX", "UNREAD"],
        expectedSyncPriority: "URGENT",
        capturedHeuristic: {
          priority: "NORMAL",
          reason: "old_default",
          signals: [],
        },
        note: null,
      },
      {
        id: "feedback-still-low",
        capturedAt: "2026-04-28T00:00:00.000Z",
        from: "newsletter@example.com",
        subject: "Weekly product digest",
        labels: ["INBOX"],
        expectedSyncPriority: "NORMAL",
        capturedHeuristic: {
          priority: "LOW",
          reason: "newsletter_sender",
          signals: ["newsletter@example.com"],
        },
        note: "actually customer-facing",
      },
      {
        id: "feedback-changed-other",
        capturedAt: "2026-04-28T00:00:00.000Z",
        from: "ops@example.com",
        subject: "URGENT REPLY NEEDED",
        labels: ["INBOX"],
        expectedSyncPriority: "LOW",
        capturedHeuristic: {
          priority: "NORMAL",
          reason: "old_default",
          signals: [],
        },
        note: null,
      },
    ];

    const report = evaluateUserCorrectionFixtures(fixtures);

    expect(report).toMatchObject({
      total: 3,
      matched: 1,
      mismatched: 2,
      nowMatchesUser: 1,
      stillMatchesCapturedHeuristic: 1,
      changedButStillMismatched: 1,
    });
    expect(report.cases.map((item) => item.status)).toEqual([
      "now_matches_user",
      "still_matches_captured_heuristic",
      "changed_but_still_mismatched",
    ]);
  });

  it("treats an empty correction set as a clean baseline", () => {
    const report = evaluateUserCorrectionFixtures([]);

    expect(report).toMatchObject({
      total: 0,
      matched: 0,
      mismatched: 0,
      matchRate: 1,
      nowMatchesUser: 0,
      stillMatchesCapturedHeuristic: 0,
      changedButStillMismatched: 0,
    });
  });
});
