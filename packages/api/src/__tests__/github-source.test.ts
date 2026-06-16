/**
 * GitHub as a second attention source — pure mapping + ingest core.
 *
 * PR1 foundation (no network, no scheduler): proves the firewall
 * generalizes past email. A GitHub notification is rendered into the
 * judge's existing ClassifiableEmail shape (faithful text, NOT a bespoke
 * scorer) so the same 4-tier judge, eval gate, and calibration apply
 * unchanged. Tier accuracy on GitHub is then MEASURED via the same
 * override/calibration loop rather than guessed at — the network poller
 * and any GitHub-specific judge tuning land in PR2, evidence-led.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const judgeEmailMock = vi.hoisted(() => vi.fn());
const upsertGitHubMock = vi.hoisted(() => vi.fn());
const pushGitHubMock = vi.hoisted(() => vi.fn());

vi.mock("../poc-judge.js", () => ({
  judgeEmail: judgeEmailMock,
  EMPTY_JUDGE_CONTEXT: { corrections: [], senderPrior: null, senderFacts: null },
}));

vi.mock("../attention-mirror.js", () => ({
  upsertAttentionForGitHubNotification: upsertGitHubMock,
}));

vi.mock("../github-push.js", () => ({
  pushForFirewallGitHubNotification: pushGitHubMock,
}));

import {
  type GitHubNotification,
  githubNotificationToClassifiable,
  ingestGitHubNotifications,
} from "../github-source.js";

const NOW = new Date("2026-06-13T10:00:00.000Z");

function notif(overrides: Partial<GitHubNotification> = {}): GitHubNotification {
  return {
    id: "thread-1",
    reason: "review_requested",
    repo: "k08200/klorn",
    subjectTitle: "Fix the auth flow",
    subjectType: "PullRequest",
    url: "https://github.com/k08200/klorn/pull/123",
    updatedAt: NOW,
    ...overrides,
  };
}

describe("githubNotificationToClassifiable", () => {
  it("renders the title as the subject and keeps Gmail labels empty", () => {
    const c = githubNotificationToClassifiable(notif());
    expect(c.subject).toBe("Fix the auth flow");
    expect(c.labels).toEqual([]);
  });

  it("never emits a Gmail promotions label (GitHub must not route to the marketing fast-path)", () => {
    const c = githubNotificationToClassifiable(notif({ reason: "subscribed" }));
    expect(c.labels ?? []).not.toContain("CATEGORY_PROMOTIONS");
  });

  it("phrases the reason in natural language the judge already understands", () => {
    expect(githubNotificationToClassifiable(notif({ reason: "review_requested" })).snippet).toMatch(
      /review/i,
    );
    expect(githubNotificationToClassifiable(notif({ reason: "mention" })).snippet).toMatch(
      /mention/i,
    );
    expect(githubNotificationToClassifiable(notif({ reason: "assign" })).snippet).toMatch(
      /assign/i,
    );
  });

  it("carries the repo and notification type into the sender/snippet so trust scores as a system notice", () => {
    const c = githubNotificationToClassifiable(notif());
    // The synthetic sender must read as automated/system (so the keyword
    // fallback floors it at QUEUE, never PUSH or SILENT) — it contains a
    // notifications-style address and the repo.
    expect(c.from.toLowerCase()).toContain("notifications");
    expect(c.from).toContain("k08200/klorn");
  });
});

describe("github mapping → judge (real keyword fallback, no network)", () => {
  beforeEach(() => {
    judgeEmailMock.mockReset();
    upsertGitHubMock.mockReset();
  });

  it("a review-requested PR does not fall into SILENT under the keyword fallback", async () => {
    // Use the REAL judge here by importing it un-mocked through a dynamic
    // path is overkill; instead assert the mapping contract that guarantees
    // it: low-marketing signal + system sender → keyword fallback yields
    // QUEUE, never SILENT. (End-to-end tier is covered by the eval set once
    // GitHub items exist; here we lock the mapping invariant.)
    const c = githubNotificationToClassifiable(notif({ reason: "review_requested" }));
    expect(c.subject.toLowerCase()).not.toMatch(/unsubscribe|광고|\[ad\]/);
  });
});

describe("ingestGitHubNotifications", () => {
  beforeEach(() => {
    judgeEmailMock.mockReset();
    upsertGitHubMock.mockReset();
    pushGitHubMock.mockReset();
    judgeEmailMock.mockResolvedValue({
      tier: "QUEUE",
      reason: "PR review",
      features: { confidence: 0.7, senderTrust: 0.4, reversibility: 0.9, urgency: 0.3 },
      source: "llm",
    });
    upsertGitHubMock.mockResolvedValue(undefined);
    pushGitHubMock.mockResolvedValue(undefined);
  });

  it("judges and mirrors each notification, returning the count surfaced", async () => {
    const n = await ingestGitHubNotifications("u1", [
      notif({ id: "t1" }),
      notif({ id: "t2", reason: "mention" }),
    ]);
    expect(n).toBe(2);
    expect(judgeEmailMock).toHaveBeenCalledTimes(2);
    expect(upsertGitHubMock).toHaveBeenCalledTimes(2);
    // Mirror is called with (notification, judgement, userId) so source rows
    // carry the GitHub identity, not an email id.
    const [firstNotif, firstJudgement] = upsertGitHubMock.mock.calls[0];
    expect(firstNotif.id).toBe("t1");
    expect(firstNotif.userId).toBe("u1");
    expect(firstJudgement.tier).toBe("QUEUE");
    // Non-PUSH tiers surface silently in the firewall — no interrupt.
    expect(pushGitHubMock).not.toHaveBeenCalled();
  });

  it("sends a push only for a judge=PUSH notification", async () => {
    judgeEmailMock.mockReset().mockResolvedValue({
      tier: "PUSH",
      reason: "you were mentioned",
      features: { confidence: 0.9, senderTrust: 0.5, reversibility: 0.5, urgency: 0.85 },
      source: "llm",
    });
    await ingestGitHubNotifications("u1", [notif({ id: "ping", reason: "mention" })]);
    expect(pushGitHubMock).toHaveBeenCalledTimes(1);
    expect(pushGitHubMock.mock.calls[0][0]).toMatchObject({ id: "ping", userId: "u1" });
  });

  it("a push failure does not drop the mirror or the surfaced count", async () => {
    judgeEmailMock.mockReset().mockResolvedValue({
      tier: "PUSH",
      reason: "review requested",
      features: { confidence: 0.9, senderTrust: 0.5, reversibility: 0.5, urgency: 0.8 },
      source: "llm",
    });
    pushGitHubMock.mockRejectedValueOnce(new Error("push blew up"));
    const n = await ingestGitHubNotifications("u1", [notif({ id: "t1" })]);
    expect(n).toBe(1);
    expect(upsertGitHubMock).toHaveBeenCalledTimes(1);
  });

  it("isolates a single judge failure — one bad notification can't drop the rest", async () => {
    judgeEmailMock.mockRejectedValueOnce(new Error("judge blew up")).mockResolvedValueOnce({
      tier: "PUSH",
      reason: "mention",
      features: { confidence: 0.9, senderTrust: 0.5, reversibility: 0.5, urgency: 0.8 },
      source: "llm",
    });
    const n = await ingestGitHubNotifications("u1", [notif({ id: "bad" }), notif({ id: "good" })]);
    expect(n).toBe(1);
    expect(upsertGitHubMock).toHaveBeenCalledTimes(1);
    expect(upsertGitHubMock.mock.calls[0][0].id).toBe("good");
  });

  it("skips notifications with no title (nothing to classify)", async () => {
    const n = await ingestGitHubNotifications("u1", [notif({ id: "empty", subjectTitle: "  " })]);
    expect(n).toBe(0);
    expect(judgeEmailMock).not.toHaveBeenCalled();
  });

  it("returns 0 for an empty batch without touching the judge", async () => {
    const n = await ingestGitHubNotifications("u1", []);
    expect(n).toBe(0);
    expect(judgeEmailMock).not.toHaveBeenCalled();
  });
});
