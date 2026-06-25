/**
 * upsertAttentionForGitHubNotification — GitHub items land in the same
 * AttentionItem table as email, keyed by source=GITHUB + the GitHub thread
 * id, so the generic firewall read path surfaces them with no changes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  prisma: { attentionItem: { upsert: upsertMock } },
  db: {},
}));

import {
  type GitHubNotificationLike,
  upsertAttentionForGitHubNotification,
} from "../attention-mirror.js";

const NOW = new Date("2026-06-13T10:00:00.000Z");

function notif(overrides: Partial<GitHubNotificationLike> = {}): GitHubNotificationLike {
  return {
    id: "thread-1",
    userId: "u1",
    repo: "k08200/klorn",
    subjectTitle: "Fix the auth flow",
    subjectType: "PullRequest",
    reason: "review_requested",
    url: "https://github.com/k08200/klorn/pull/123",
    updatedAt: NOW,
    ...overrides,
  };
}

const JUDGEMENT = {
  tier: "QUEUE" as const,
  reason: "PR review requested",
  features: { confidence: 0.7, senderTrust: 0.4, reversibility: 0.9, urgency: 0.3 },
  source: "llm" as const,
};

beforeEach(() => {
  upsertMock.mockReset();
  upsertMock.mockResolvedValue({});
});

describe("upsertAttentionForGitHubNotification", () => {
  it("keys the row by source=GITHUB and the GitHub thread id", async () => {
    await upsertAttentionForGitHubNotification(notif(), JUDGEMENT);
    const args = upsertMock.mock.calls[0][0];
    expect(args.where).toEqual({
      userId_source_sourceId: { userId: "u1", source: "GITHUB", sourceId: "thread-1" },
    });
    expect(args.create.source).toBe("GITHUB");
    expect(args.create.userId).toBe("u1");
  });

  it("passes the judged tier through and titles the row with the subject", async () => {
    await upsertAttentionForGitHubNotification(notif(), JUDGEMENT);
    const { create } = upsertMock.mock.calls[0][0];
    expect(create.tier).toBe("QUEUE");
    expect(create.tierReason).toBe("PR review requested");
    expect(create.title).toBe("Fix the auth flow");
    expect(create.surfacedAt).toEqual(NOW);
  });

  it("records repo, reason, and the open-url in evidence (no email fields)", async () => {
    await upsertAttentionForGitHubNotification(notif(), JUDGEMENT);
    const { create } = upsertMock.mock.calls[0][0];
    const facts: Array<{ label: string; value: string }> = create.evidence.facts;
    const byLabel = Object.fromEntries(facts.map((f) => [f.label, f.value]));
    expect(byLabel.Repository).toBe("k08200/klorn");
    expect(byLabel.Reason).toBe("review_requested");
    expect(byLabel.Link).toBe("https://github.com/k08200/klorn/pull/123");
  });

  it("maps actionable reasons to REPLY_NEEDED and passive ones to FOLLOWUP", async () => {
    await upsertAttentionForGitHubNotification(notif({ reason: "review_requested" }), JUDGEMENT);
    expect(upsertMock.mock.calls[0][0].create.type).toBe("REPLY_NEEDED");

    upsertMock.mockClear();
    await upsertAttentionForGitHubNotification(notif({ reason: "subscribed" }), JUDGEMENT);
    expect(upsertMock.mock.calls[0][0].create.type).toBe("FOLLOWUP");
  });

  it("never throws on a DB failure (best-effort mirror)", async () => {
    upsertMock.mockRejectedValue(new Error("db down"));
    await expect(upsertAttentionForGitHubNotification(notif(), JUDGEMENT)).resolves.toBeUndefined();
  });
});
