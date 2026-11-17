/**
 * Slack residuals (docs/providers/slack.md §8-§9):
 *   - a keyword-fallback verdict is re-judged once the model answers again
 *     (slack/rejudge.ts): at most once per episode, under the same daily caps,
 *     only while the text is kept, and an upgrade to PUSH rings only on fresh
 *     talk (bell row up to 72 h, nothing after);
 *   - a reply recorded while the judge call was in flight stops the ring (the
 *     real-Postgres interleaving is slack-answered-race-pg.test.ts);
 *   - a quiet-hours Slack push sends the bell's live frame (untagged), so the
 *     Windows shell can hold it for its catch-up, and links its row to the
 *     episode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const judge = vi.hoisted(() => ({ judgeEmail: vi.fn() }));
vi.mock("../judge/poc-judge.js", () => ({
  EMPTY_JUDGE_CONTEXT: { corrections: [] },
  judgeEmail: judge.judgeEmail,
}));
vi.mock("../llm/llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(async () => ({ chain: [] })),
}));
vi.mock("../notify/notification-strings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../notify/notification-strings.js")>();
  return { ...actual, getUserNotificationLanguage: vi.fn(async () => "en") };
});
const budget = vi.hoisted(() => ({ admitPushNotification: vi.fn() }));
vi.mock("../judge/v3/push-budget-gate.js", () => budget);
const ring = vi.hoisted(() => ({
  pushNotification: vi.fn(),
  sendPushNotification: vi.fn(async () => ({ dispatchedAt: null })),
  desktopAlertTag: vi.fn(async (): Promise<{ alert?: string }> => ({ alert: "push" })),
}));
vi.mock("../websocket.js", () => ({ pushNotification: ring.pushNotification }));
vi.mock("../notify/push.js", () => ({ sendPushNotification: ring.sendPushNotification }));
vi.mock("../notify/desktop-alert.js", () => ({ desktopAlertTag: ring.desktopAlertTag }));
const commit = vi.hoisted(() => ({
  extractAndUpsertCommitmentsFromText: vi.fn(async () => ({
    candidatesFound: 0,
    commitmentsCreated: 0,
    duplicatesSkipped: 0,
  })),
}));
vi.mock("../pim/commitment-ingestion.js", () => commit);
const db = vi.hoisted(() => ({
  prisma: {
    notification: {
      create: vi.fn(async () => ({ id: "n-held" })),
      count: vi.fn(async () => 0),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    slackEpisode: {
      findMany: vi.fn(),
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => ({ id: "ep-1" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 0),
    },
    slackMessage: { findMany: vi.fn() },
  },
}));
vi.mock("../db.js", () => db);
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { captureError } from "../sentry.js";

import { judgeReadySlackEpisodes, SLACK_JUDGED_EPISODES_PER_DAY } from "../slack/judge-sweep.js";
import { notifySlackPush } from "../slack/notify.js";
import { SLACK_MESSAGE_RETENTION_DAYS } from "../slack/purge.js";
import {
  rejudgeFallbackSlackEpisodes,
  resetSlackRejudgeState,
  SLACK_REJUDGE_BATCH,
  SLACK_REJUDGE_BELL_MAX_AGE_MS,
  SLACK_REJUDGE_RETRY_MS,
  SLACK_REJUDGE_RING_FRESH_MS,
} from "../slack/rejudge.js";
import { callText } from "./helpers/canary.js";
import { DB_CANARY, validationErrorQuotingText } from "./helpers/prisma-canary.js";

const NOW = new Date("2026-11-17T10:00:00Z");
const MINUTE = 60_000;
const SLACK_TEXT = "the payroll file for Q4 is wrong, call me";

const episode = (over: Record<string, unknown> = {}) => ({
  id: "ep-1",
  userId: "user-1",
  connectionId: "conn-1",
  channelId: "D0DM",
  channelType: "im",
  threadKey: "",
  mentionsUser: false,
  firstTs: "1763100000.000100",
  lastMessageAt: new Date(NOW.getTime() - 10 * MINUTE),
  tier: "QUEUE",
  connection: { workspaceUrl: "https://acme.slack.com/" },
  ...over,
});

const llmPush = {
  tier: "PUSH",
  reason: "Payroll is wrong, needs you",
  features: {},
  source: "llm",
};
const fallback = { tier: "QUEUE", reason: "keywords", features: {}, source: "keyword-fallback" };

/** The data of every slackEpisode.updateMany call, in order. */
const episodeWrites = () =>
  db.prisma.slackEpisode.updateMany.mock.calls.map(
    (call) => (call as unknown as [{ where: Record<string, unknown>; data: unknown }])[0],
  );

beforeEach(() => {
  vi.clearAllMocks();
  resetSlackRejudgeState();
  process.env.SLACK_ENABLED = "true";
  delete process.env.ROLLOUT_COHORT_USER_IDS;
  delete process.env.BACKGROUND_AGENTS_DISABLED;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  judge.judgeEmail.mockResolvedValue(llmPush);
  budget.admitPushNotification.mockResolvedValue({
    status: "admitted",
    notification: { id: "n1", createdAt: NOW },
  });
  db.prisma.slackEpisode.findMany.mockResolvedValue([episode()]);
  db.prisma.slackEpisode.findFirst.mockResolvedValue({ id: "ep-1" });
  db.prisma.slackEpisode.updateMany.mockResolvedValue({ count: 1 });
  db.prisma.slackEpisode.count.mockResolvedValue(0);
  db.prisma.notification.count.mockResolvedValue(0);
  db.prisma.slackMessage.findMany.mockResolvedValue([
    { text: SLACK_TEXT, ts: "1763100000.000100", threadTs: null },
  ]);
});

afterEach(() => {
  delete process.env.SLACK_ENABLED;
  vi.restoreAllMocks();
});

describe("the first judgment records where its verdict came from", () => {
  it("stores verdictSource with the verdict, so a keyword-fallback one can be found again", async () => {
    judge.judgeEmail.mockResolvedValueOnce(fallback);
    await judgeReadySlackEpisodes(NOW);
    expect(episodeWrites()).toContainEqual({
      where: { id: "ep-1", status: "JUDGING" },
      data: {
        status: "JUDGED",
        tier: "QUEUE",
        reason: "keywords",
        verdictSource: "keyword-fallback",
        judgedAt: NOW,
      },
    });
  });
});

describe("rejudgeFallbackSlackEpisodes", () => {
  it("picks only unanswered keyword-fallback verdicts whose text is still kept, newest first", async () => {
    await rejudgeFallbackSlackEpisodes(NOW);
    const query = db.prisma.slackEpisode.findMany.mock.calls[0]?.[0];
    expect(query).toMatchObject({
      where: {
        status: "JUDGED",
        verdictSource: "keyword-fallback",
        rejudgedAt: null,
        answeredAt: null,
        startedAt: { gt: new Date(NOW.getTime() - SLACK_MESSAGE_RETENTION_DAYS * 86_400_000) },
      },
      orderBy: { lastMessageAt: "desc" },
      take: SLACK_REJUDGE_BATCH,
    });
  });

  it("claims the episode, re-judges it with the model and stores the new verdict once", async () => {
    expect(await rejudgeFallbackSlackEpisodes(NOW)).toBe(1);
    const [claim, verdict] = episodeWrites();
    expect(claim).toEqual({
      where: { id: "ep-1", status: "JUDGED", verdictSource: "keyword-fallback", rejudgedAt: null },
      data: { rejudgedAt: NOW },
    });
    expect(verdict).toEqual({
      where: { id: "ep-1", status: "JUDGED", rejudgedAt: NOW },
      data: {
        tier: "PUSH",
        reason: "Payroll is wrong, needs you",
        verdictSource: "llm",
        judgedAt: NOW,
      },
    });
    expect(judge.judgeEmail).toHaveBeenCalledTimes(1);
  });

  it("an episode another worker claimed first is not judged again", async () => {
    db.prisma.slackEpisode.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await rejudgeFallbackSlackEpisodes(NOW)).toBe(0);
    expect(judge.judgeEmail).not.toHaveBeenCalled();
  });

  it("an upgrade to PUSH on fresh talk rings through the interrupt budget", async () => {
    db.prisma.slackEpisode.findMany.mockResolvedValue([
      episode({ lastMessageAt: new Date(NOW.getTime() - SLACK_REJUDGE_RING_FRESH_MS + MINUTE) }),
    ]);
    await rejudgeFallbackSlackEpisodes(NOW);
    expect(budget.admitPushNotification).toHaveBeenCalledTimes(1);
    expect(ring.pushNotification).toHaveBeenCalledTimes(1);
    expect(ring.sendPushNotification).toHaveBeenCalledTimes(1);
  });

  it("an upgrade on older talk writes a bell row only: no budget slot, no ring", async () => {
    db.prisma.slackEpisode.findMany.mockResolvedValue([
      episode({ lastMessageAt: new Date(NOW.getTime() - SLACK_REJUDGE_RING_FRESH_MS - MINUTE) }),
    ]);
    await rejudgeFallbackSlackEpisodes(NOW);
    expect(budget.admitPushNotification).not.toHaveBeenCalled();
    expect(ring.pushNotification).not.toHaveBeenCalled();
    expect(ring.sendPushNotification).not.toHaveBeenCalled();
    expect(db.prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "user-1", type: "slack", dedupeKey: "slack:ep-1" }),
      select: { id: true },
    });
  });

  it("an upgrade on talk older than 72 h corrects the lane and alerts nothing", async () => {
    db.prisma.slackEpisode.findMany.mockResolvedValue([
      episode({ lastMessageAt: new Date(NOW.getTime() - SLACK_REJUDGE_BELL_MAX_AGE_MS - MINUTE) }),
    ]);
    expect(await rejudgeFallbackSlackEpisodes(NOW)).toBe(1);
    expect(db.prisma.notification.create).not.toHaveBeenCalled();
    expect(budget.admitPushNotification).not.toHaveBeenCalled();
  });

  it("a fallback PUSH the model keeps at PUSH alerts nothing new", async () => {
    db.prisma.slackEpisode.findMany.mockResolvedValue([episode({ tier: "PUSH" })]);
    await rejudgeFallbackSlackEpisodes(NOW);
    expect(budget.admitPushNotification).not.toHaveBeenCalled();
    expect(db.prisma.notification.create).not.toHaveBeenCalled();
  });

  it("a reply that landed during the re-judge call stops the ring", async () => {
    db.prisma.slackEpisode.findFirst.mockResolvedValue(null);
    await rejudgeFallbackSlackEpisodes(NOW);
    expect(db.prisma.slackEpisode.findFirst).toHaveBeenCalledWith({
      where: { id: "ep-1", answeredAt: null },
      select: { id: true },
    });
    expect(budget.admitPushNotification).not.toHaveBeenCalled();
    expect(db.prisma.notification.create).not.toHaveBeenCalled();
  });

  it("model still unreachable: releases the claim and leaves that user alone for a while", async () => {
    judge.judgeEmail.mockResolvedValue(fallback);
    expect(await rejudgeFallbackSlackEpisodes(NOW)).toBe(0);
    expect(episodeWrites().at(-1)).toEqual({
      where: { id: "ep-1", rejudgedAt: NOW },
      data: { rejudgedAt: null },
    });
    // Within the retry interval the user's episodes are not even read.
    db.prisma.slackEpisode.findMany.mockClear();
    await rejudgeFallbackSlackEpisodes(new Date(NOW.getTime() + SLACK_REJUDGE_RETRY_MS - MINUTE));
    expect(db.prisma.slackEpisode.findMany.mock.calls[0]?.[0]?.where?.userId).toEqual({
      notIn: ["user-1"],
    });
    // After it, they are tried again.
    db.prisma.slackEpisode.findMany.mockClear();
    judge.judgeEmail.mockResolvedValue(llmPush);
    await rejudgeFallbackSlackEpisodes(new Date(NOW.getTime() + SLACK_REJUDGE_RETRY_MS + MINUTE));
    expect(db.prisma.slackEpisode.findMany.mock.calls[0]?.[0]?.where?.userId).toBeUndefined();
    expect(judge.judgeEmail).toHaveBeenCalledTimes(2);
  });

  it("one user's unreachable model does not hold back another user's re-judge", async () => {
    db.prisma.slackEpisode.findMany.mockResolvedValue([
      episode(),
      episode({ id: "ep-2" }),
      episode({ id: "ep-3", userId: "user-2" }),
    ]);
    judge.judgeEmail.mockResolvedValueOnce(fallback).mockResolvedValueOnce(llmPush);
    expect(await rejudgeFallbackSlackEpisodes(NOW)).toBe(1);
    // ep-2 belongs to the user whose call just fell back: skipped this pass.
    expect(judge.judgeEmail).toHaveBeenCalledTimes(2);
    const claimed = episodeWrites()
      .filter((w) => (w.data as { rejudgedAt?: unknown }).rejudgedAt === NOW)
      .map((w) => w.where.id);
    expect(claimed).toEqual(["ep-1", "ep-3"]);
  });

  it("past the per-connection daily cap the attempt is spent without a model call", async () => {
    db.prisma.slackEpisode.count.mockResolvedValue(SLACK_JUDGED_EPISODES_PER_DAY);
    expect(await rejudgeFallbackSlackEpisodes(NOW)).toBe(0);
    expect(judge.judgeEmail).not.toHaveBeenCalled();
    // Spent, not released: the claim stays.
    expect(episodeWrites()).toHaveLength(1);
  });

  it("an episode with no text left is not judged, and the attempt is spent", async () => {
    db.prisma.slackMessage.findMany.mockResolvedValue([]);
    expect(await rejudgeFallbackSlackEpisodes(NOW)).toBe(0);
    expect(judge.judgeEmail).not.toHaveBeenCalled();
    expect(episodeWrites()).toHaveLength(1);
  });

  it("a failure spends the attempt (no retry loop) and reports facts, never the text", async () => {
    const errors = vi.mocked(console.error);
    judge.judgeEmail.mockRejectedValue(validationErrorQuotingText());
    expect(await rejudgeFallbackSlackEpisodes(NOW)).toBe(0);
    // The claim stays: no release, so no retry.
    expect(episodeWrites()).toHaveLength(1);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureError).mock.calls[0]?.[1]).toMatchObject({
      tags: { scope: "slack.rejudge" },
      extra: { episodeId: "ep-1" },
    });
    expect(callText(vi.mocked(captureError))).not.toContain(DB_CANARY);
    expect(callText(errors)).not.toContain(DB_CANARY);
  });

  it("re-runs the commitment pass only when the fallback had said SILENT", async () => {
    judge.judgeEmail.mockResolvedValue({ ...llmPush, tier: "QUEUE" });
    db.prisma.slackEpisode.findMany.mockResolvedValue([episode({ tier: "SILENT" })]);
    await rejudgeFallbackSlackEpisodes(NOW);
    expect(commit.extractAndUpsertCommitmentsFromText).toHaveBeenCalledTimes(1);
    commit.extractAndUpsertCommitmentsFromText.mockClear();
    db.prisma.slackEpisode.findMany.mockResolvedValue([episode({ tier: "INFO" })]);
    await rejudgeFallbackSlackEpisodes(NOW);
    expect(commit.extractAndUpsertCommitmentsFromText).not.toHaveBeenCalled();
  });

  it("stands down with the flag off, under the background brake, and outside the cohort", async () => {
    delete process.env.SLACK_ENABLED;
    expect(await rejudgeFallbackSlackEpisodes(NOW)).toBe(0);
    process.env.SLACK_ENABLED = "true";
    process.env.BACKGROUND_AGENTS_DISABLED = "true";
    expect(await rejudgeFallbackSlackEpisodes(NOW)).toBe(0);
    delete process.env.BACKGROUND_AGENTS_DISABLED;
    expect(db.prisma.slackEpisode.findMany).not.toHaveBeenCalled();
    process.env.SLACK_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "user-9";
    await rejudgeFallbackSlackEpisodes(NOW);
    expect(db.prisma.slackEpisode.findMany.mock.calls[0]?.[0]?.where?.userId).toEqual({
      in: ["user-9"],
    });
  });
});

describe("a reply recorded during the first judgment", () => {
  it("keeps the verdict but does not ring once the episode is answered", async () => {
    db.prisma.slackEpisode.findMany.mockResolvedValue([
      { ...episode(), lastTs: "1763100000.000100", startedAt: NOW, messageCount: 1 },
    ]);
    db.prisma.slackEpisode.findFirst.mockResolvedValue(null);
    await judgeReadySlackEpisodes(NOW);
    expect(episodeWrites()).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ status: "JUDGED", tier: "PUSH" }),
      }),
    );
    expect(budget.admitPushNotification).not.toHaveBeenCalled();
    expect(ring.pushNotification).not.toHaveBeenCalled();
  });
});

describe("notifySlackPush — bell only, and the quiet-hours frame", () => {
  const input = {
    userId: "user-1",
    episodeId: "ep-1",
    kind: "dm" as const,
    preview: "prod is down",
    reason: "Needs you now",
    link: "https://acme.slack.com/archives/D0DM/p1",
    now: NOW,
  };

  it("ring: false writes the bell row only", async () => {
    expect(await notifySlackPush({ ...input, ring: false })).toBe("held");
    expect(budget.admitPushNotification).not.toHaveBeenCalled();
    expect(ring.pushNotification).not.toHaveBeenCalled();
    expect(db.prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it("ring: false still respects the daily Slack bell-row cap", async () => {
    db.prisma.notification.count.mockResolvedValueOnce(20).mockResolvedValueOnce(0);
    expect(await notifySlackPush({ ...input, ring: false })).toBe("capped");
    expect(db.prisma.notification.create).not.toHaveBeenCalled();
  });

  it("will not ring (quiet hours): sends the bell's live frame, untagged, and no device push", async () => {
    budget.admitPushNotification.mockResolvedValueOnce({
      status: "unbudgeted",
      notification: { id: "n2", createdAt: NOW },
      why: "will_not_ring",
    });
    ring.desktopAlertTag.mockResolvedValueOnce({});
    expect(await notifySlackPush(input)).toBe("unbudgeted");
    expect(ring.pushNotification).toHaveBeenCalledWith("user-1", {
      id: "n2",
      type: "slack",
      title: "Slack · Direct message",
      message: "prod is down\nNeeds you now",
      createdAt: NOW.toISOString(),
      link: input.link,
    });
    expect(ring.sendPushNotification).not.toHaveBeenCalled();
    // The row names its episode, so a late toast can tell it was answered.
    expect(db.prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: "n2", dedupeKey: null },
      data: { dedupeKey: "slack:ep-1" },
    });
  });
});
