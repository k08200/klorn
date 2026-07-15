import { beforeEach, describe, expect, it, vi } from "vitest";

type FeedbackRow = {
  id: string;
  userId: string;
  emailId: string;
  originalPriority: "URGENT" | "NORMAL" | "LOW";
  correctedPriority: "URGENT" | "NORMAL" | "LOW";
  reason: string | null;
  signals: string[];
  fromAddress: string;
  subject: string;
  labels: string[];
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const store = vi.hoisted(() => ({
  feedback: [] as FeedbackRow[],
}));

vi.mock("../db.js", () => ({
  prisma: {
    emailLabelFeedback: {
      findMany: vi.fn(
        async ({
          where,
          take,
          orderBy: _orderBy,
        }: {
          where: { userId: string };
          take?: number;
          orderBy?: unknown;
        }) => {
          const rows = store.feedback
            .filter((f) => f.userId === where.userId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return take ? rows.slice(0, take) : rows;
        },
      ),
    },
  },
}));

import { feedbackToFixture, listUserFeedbackFixtures } from "../mail/email-feedback-fixtures.js";

const seedRow = (overrides: Partial<FeedbackRow> = {}): FeedbackRow => ({
  id: "fb-1",
  userId: "user-1",
  emailId: "email-1",
  originalPriority: "NORMAL",
  correctedPriority: "URGENT",
  reason: "default",
  signals: [],
  fromAddress: "Kim <kim@vc-fund.com>",
  subject: "Re: Term sheet review by Friday",
  labels: ["INBOX", "UNREAD"],
  note: null,
  createdAt: new Date("2026-04-28T10:00:00.000Z"),
  updatedAt: new Date("2026-04-28T10:00:00.000Z"),
  ...overrides,
});

describe("feedbackToFixture", () => {
  it("maps a feedback row to a fixture-shaped object", () => {
    const fixture = feedbackToFixture(seedRow());
    expect(fixture).toEqual({
      id: "feedback-fb-1",
      capturedAt: "2026-04-28T10:00:00.000Z",
      from: "Kim <kim@vc-fund.com>",
      subject: "Re: Term sheet review by Friday",
      labels: ["INBOX", "UNREAD"],
      expectedSyncPriority: "URGENT",
      capturedHeuristic: {
        priority: "NORMAL",
        reason: "default",
        signals: [],
      },
      note: null,
    });
  });

  it("preserves heuristic divergence — original=LOW corrected=URGENT shows the gap", () => {
    const fixture = feedbackToFixture(
      seedRow({
        originalPriority: "LOW",
        correctedPriority: "URGENT",
        reason: "newsletter_sender",
      }),
    );
    expect(fixture.expectedSyncPriority).toBe("URGENT");
    expect(fixture.capturedHeuristic.priority).toBe("LOW");
    expect(fixture.capturedHeuristic.reason).toBe("newsletter_sender");
  });

  it("retains optional note when present", () => {
    const fixture = feedbackToFixture(seedRow({ note: "actually a digest" }));
    expect(fixture.note).toBe("actually a digest");
  });
});

describe("listUserFeedbackFixtures", () => {
  beforeEach(() => {
    store.feedback.length = 0;
  });

  it("returns an empty list when the user has no feedback", async () => {
    expect(await listUserFeedbackFixtures("user-1")).toEqual([]);
  });

  it("scopes by userId — never leaks another user's corrections", async () => {
    store.feedback.push(seedRow({ id: "fb-mine", userId: "user-1" }));
    store.feedback.push(seedRow({ id: "fb-other", userId: "user-2" }));

    const fixtures = await listUserFeedbackFixtures("user-1");
    expect(fixtures.map((f) => f.id)).toEqual(["feedback-fb-mine"]);
  });

  it("returns rows ordered newest-first", async () => {
    store.feedback.push(seedRow({ id: "fb-old", createdAt: new Date("2026-04-26T10:00:00.000Z") }));
    store.feedback.push(seedRow({ id: "fb-new", createdAt: new Date("2026-04-28T10:00:00.000Z") }));

    const fixtures = await listUserFeedbackFixtures("user-1");
    expect(fixtures.map((f) => f.id)).toEqual(["feedback-fb-new", "feedback-fb-old"]);
  });

  it("respects limit when more rows exist than requested", async () => {
    for (let i = 0; i < 5; i++) {
      store.feedback.push(
        seedRow({
          id: `fb-${i}`,
          createdAt: new Date(Date.UTC(2026, 3, 28, 10, i)),
        }),
      );
    }
    const fixtures = await listUserFeedbackFixtures("user-1", { limit: 2 });
    expect(fixtures).toHaveLength(2);
  });
});
