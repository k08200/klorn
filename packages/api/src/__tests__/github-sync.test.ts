/**
 * syncGitHubForUser — load the user's encrypted PAT, fetch notifications
 * since the cursor, ingest them (real ingest, with judge + mirror mocked),
 * advance the cursor. Pins orchestration + cursor handling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.hoisted(() => vi.fn());
const userUpdate = vi.hoisted(() => vi.fn());
const fetchNotifsMock = vi.hoisted(() => vi.fn());
const judgeEmailMock = vi.hoisted(() => vi.fn());
const upsertGitHubMock = vi.hoisted(() => vi.fn());
const decryptMock = vi.hoisted(() => vi.fn((v: string) => v.replace("cipher:", "")));

vi.mock("../db.js", () => ({
  prisma: { user: { findUnique: userFindUnique, update: userUpdate } },
  db: {},
}));
vi.mock("../github-client.js", () => ({ fetchGitHubNotifications: fetchNotifsMock }));
vi.mock("../crypto-tokens.js", () => ({ decryptToken: decryptMock }));
vi.mock("../poc-judge.js", () => ({
  judgeEmail: judgeEmailMock,
  EMPTY_JUDGE_CONTEXT: { corrections: [], senderPrior: null, senderFacts: null },
}));
vi.mock("../attention-mirror.js", () => ({
  upsertAttentionForGitHubNotification: upsertGitHubMock,
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { syncGitHubForUser } from "../github-source.js";

const NOW = new Date("2026-06-13T12:00:00.000Z");

function notif(id: string) {
  return {
    id,
    reason: "review_requested",
    repo: "k08200/klorn",
    subjectTitle: `PR ${id}`,
    subjectType: "PullRequest",
    url: null,
    updatedAt: NOW,
  };
}

beforeEach(() => {
  userFindUnique.mockReset();
  userUpdate.mockReset();
  fetchNotifsMock.mockReset();
  judgeEmailMock.mockReset();
  upsertGitHubMock.mockReset();
  userUpdate.mockResolvedValue({});
  upsertGitHubMock.mockResolvedValue(undefined);
  judgeEmailMock.mockResolvedValue({
    tier: "QUEUE",
    reason: "PR review",
    features: { confidence: 0.7, senderTrust: 0.4, reversibility: 0.9, urgency: 0.3 },
    source: "llm",
  });
});

describe("syncGitHubForUser", () => {
  it("returns null when the user has no token (disconnected)", async () => {
    userFindUnique.mockResolvedValue({ githubTokenCipher: null, githubLastPolledAt: null });
    const result = await syncGitHubForUser("u1", NOW);
    expect(result).toBeNull();
    expect(fetchNotifsMock).not.toHaveBeenCalled();
  });

  it("decrypts the token, fetches since the cursor, ingests, advances the cursor", async () => {
    userFindUnique.mockResolvedValue({
      githubTokenCipher: "cipher:tok",
      githubLastPolledAt: new Date("2026-06-13T11:00:00Z"),
    });
    fetchNotifsMock.mockResolvedValue([notif("t1"), notif("t2")]);

    const result = await syncGitHubForUser("u1", NOW);

    expect(decryptMock).toHaveBeenCalledWith("cipher:tok");
    expect(fetchNotifsMock).toHaveBeenCalledWith("tok", new Date("2026-06-13T11:00:00Z"));
    expect(judgeEmailMock).toHaveBeenCalledTimes(2);
    expect(upsertGitHubMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ fetched: 2, surfaced: 2 });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { githubLastPolledAt: NOW },
    });
  });

  it("advances the cursor even when nothing new came back (no rework next tick)", async () => {
    userFindUnique.mockResolvedValue({ githubTokenCipher: "cipher:tok", githubLastPolledAt: null });
    fetchNotifsMock.mockResolvedValue([]);
    const result = await syncGitHubForUser("u1", NOW);
    expect(result).toEqual({ fetched: 0, surfaced: 0 });
    expect(judgeEmailMock).not.toHaveBeenCalled();
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { githubLastPolledAt: NOW },
    });
  });

  it("does NOT advance the cursor when the fetch fails (so the window isn't lost)", async () => {
    userFindUnique.mockResolvedValue({ githubTokenCipher: "cipher:tok", githubLastPolledAt: null });
    fetchNotifsMock.mockRejectedValue(new Error("502"));
    await expect(syncGitHubForUser("u1", NOW)).rejects.toThrow();
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
