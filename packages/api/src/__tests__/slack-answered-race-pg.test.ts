/**
 * Real-Postgres proof of two Slack judge races (docs/providers/slack.md §8-§9):
 *
 *   - the user replies while the episode's judge call is in flight: the reply
 *     is recorded on the claimed episode, the verdict still lands, and the
 *     PUSH does not ring. Deterministic interleaving: the fake judge waits on
 *     a promise the test resolves only after the reply was written;
 *   - a keyword-fallback verdict is re-judged once the model answers, exactly
 *     once (a second pass, or a racing one, judges nothing).
 *
 * The judge and the ring are fakes; claims, verdict writes and the reply's
 * stamp run on Postgres. Skipped unless KLORN_TEST_PG_URL points at a
 * database with every migration applied. Every pass is scoped to this file's
 * users through the rollout cohort, so a parallel suite's episodes are never
 * claimed here.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

const judge = vi.hoisted(() => ({ judgeEmail: vi.fn() }));
vi.mock("../judge/poc-judge.js", () => ({
  EMPTY_JUDGE_CONTEXT: { corrections: [] },
  judgeEmail: judge.judgeEmail,
}));
vi.mock("../llm/llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(async () => ({ chain: [] })),
}));
const budget = vi.hoisted(() => ({ admitPushNotification: vi.fn() }));
vi.mock("../judge/v3/push-budget-gate.js", () => budget);
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../notify/push.js", () => ({
  sendPushNotification: vi.fn(async () => ({ dispatchedAt: null })),
}));
vi.mock("../notify/desktop-alert.js", () => ({ desktopAlertTag: vi.fn(async () => ({})) }));
vi.mock("../pim/commitment-ingestion.js", () => ({
  extractAndUpsertCommitmentsFromText: vi.fn(async () => ({
    candidatesFound: 0,
    commitmentsCreated: 0,
    duplicatesSkipped: 0,
  })),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import { startSlackConnection } from "../slack/connection-store.js";
import { ingestSlackMessage, markSlackConversationAnswered } from "../slack/episodes.js";
import { judgeReadySlackEpisodes } from "../slack/judge-sweep.js";
import { rejudgeFallbackSlackEpisodes, resetSlackRejudgeState } from "../slack/rejudge.js";

const describePg = url ? describe : describe.skip;
const createdUsers: string[] = [];
const MINUTE = 60_000;
const llmPush = { tier: "PUSH", reason: "Payroll is wrong", features: {}, source: "llm" };

async function readyEpisode(): Promise<{ userId: string; connectionId: string }> {
  const user = await prisma.user.create({
    data: { email: `slack-race-${randomUUID()}@test.local` },
  });
  createdUsers.push(user.id);
  // Only this test's user is in reach of the judge passes below.
  process.env.ROLLOUT_COHORT_USER_IDS = user.id;
  await startSlackConnection(user.id);
  const { id: connectionId } = await prisma.slackConnection.findUniqueOrThrow({
    where: { userId: user.id },
    select: { id: true },
  });
  await ingestSlackMessage({
    connectionId,
    userId: user.id,
    eventId: `Ev${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    channel: "D0DM",
    channelType: "im",
    threadTs: null,
    ts: "1763100000.000100",
    senderId: "UOTHER",
    text: "the payroll file is wrong, call me",
    mentionsUser: false,
    // Quiet for five minutes: ready to judge, still fresh enough to ring.
    now: new Date(Date.now() - 5 * MINUTE),
  });
  return { userId: user.id, connectionId };
}

function episodeOf(connectionId: string) {
  return prisma.slackEpisode.findFirstOrThrow({
    where: { connectionId },
    select: {
      status: true,
      tier: true,
      verdictSource: true,
      answeredAt: true,
      notifiedAt: true,
      rejudgedAt: true,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSlackRejudgeState();
  process.env.SLACK_ENABLED = "cohort";
  budget.admitPushNotification.mockResolvedValue({
    status: "admitted",
    notification: { id: randomUUID(), createdAt: new Date() },
  });
});

afterEach(() => {
  delete process.env.SLACK_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

afterAll(async () => {
  if (!url) return;
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describePg("Slack judge races on Postgres", () => {
  it("a reply that lands while the judge call is in flight: the verdict is kept, nothing rings", async () => {
    const { connectionId } = await readyEpisode();
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const inJudge = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    judge.judgeEmail.mockImplementation(async () => {
      entered();
      await gate;
      return llmPush;
    });

    const pass = judgeReadySlackEpisodes(new Date());
    // A pass that fails before the judge call surfaces its error, not a timeout.
    await Promise.race([inJudge, pass]);
    expect((await episodeOf(connectionId)).status).toBe("JUDGING");
    await markSlackConversationAnswered({
      connectionId,
      channel: "D0DM",
      threadTs: null,
      ts: "1763100100.000100",
    });
    release();
    expect(await pass).toBe(1);

    const stored = await episodeOf(connectionId);
    expect(stored).toMatchObject({ status: "JUDGED", tier: "PUSH", notifiedAt: null });
    expect(stored.answeredAt).not.toBeNull();
    expect(budget.admitPushNotification).not.toHaveBeenCalled();
  });

  it("control: the same pass without the reply rings", async () => {
    const { connectionId } = await readyEpisode();
    judge.judgeEmail.mockResolvedValue(llmPush);
    expect(await judgeReadySlackEpisodes(new Date())).toBe(1);
    expect(budget.admitPushNotification).toHaveBeenCalledTimes(1);
    const stored = await episodeOf(connectionId);
    expect(stored.notifiedAt).not.toBeNull();
    expect(stored.answeredAt).toBeNull();
  });

  it("re-judges a keyword-fallback verdict exactly once, even with two passes racing", async () => {
    const { connectionId } = await readyEpisode();
    judge.judgeEmail.mockResolvedValue({
      tier: "QUEUE",
      reason: "keywords",
      features: {},
      source: "keyword-fallback",
    });
    await judgeReadySlackEpisodes(new Date());
    expect(await episodeOf(connectionId)).toMatchObject({
      status: "JUDGED",
      tier: "QUEUE",
      verdictSource: "keyword-fallback",
      rejudgedAt: null,
    });

    judge.judgeEmail.mockClear();
    judge.judgeEmail.mockResolvedValue(llmPush);
    const now = new Date();
    const [a, b] = await Promise.all([
      rejudgeFallbackSlackEpisodes(now),
      rejudgeFallbackSlackEpisodes(now),
    ]);
    expect(a + b).toBe(1);
    expect(judge.judgeEmail).toHaveBeenCalledTimes(1);
    const stored = await episodeOf(connectionId);
    expect(stored).toMatchObject({ tier: "PUSH", verdictSource: "llm" });
    expect(stored.rejudgedAt).not.toBeNull();
    // Fresh talk (five minutes old): the upgrade rang.
    expect(budget.admitPushNotification).toHaveBeenCalledTimes(1);

    expect(await rejudgeFallbackSlackEpisodes(new Date())).toBe(0);
    expect(judge.judgeEmail).toHaveBeenCalledTimes(1);
  });

  it("a still-unreachable model releases the claim, so a later pass can re-judge", async () => {
    const { connectionId } = await readyEpisode();
    const fallback = { tier: "QUEUE", reason: "k", features: {}, source: "keyword-fallback" };
    judge.judgeEmail.mockResolvedValue(fallback);
    await judgeReadySlackEpisodes(new Date());
    expect(await rejudgeFallbackSlackEpisodes(new Date())).toBe(0);
    expect((await episodeOf(connectionId)).rejudgedAt).toBeNull();

    resetSlackRejudgeState();
    judge.judgeEmail.mockResolvedValue({ ...llmPush, tier: "INFO" });
    expect(await rejudgeFallbackSlackEpisodes(new Date())).toBe(1);
    expect(await episodeOf(connectionId)).toMatchObject({ tier: "INFO", verdictSource: "llm" });
  });

  it("a model that keeps falling back is given up after three calls", async () => {
    const { connectionId } = await readyEpisode();
    judge.judgeEmail.mockResolvedValue({
      tier: "QUEUE",
      reason: "k",
      features: {},
      source: "keyword-fallback",
    });
    await judgeReadySlackEpisodes(new Date());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      resetSlackRejudgeState();
      expect(await rejudgeFallbackSlackEpisodes(new Date())).toBe(0);
    }
    const spent = await prisma.slackEpisode.findFirstOrThrow({
      where: { connectionId },
      select: { rejudgedAt: true, rejudgeAttempts: true, verdictSource: true },
    });
    expect(spent.rejudgeAttempts).toBe(3);
    expect(spent.rejudgedAt).not.toBeNull();
    expect(spent.verdictSource).toBe("keyword-fallback");
    judge.judgeEmail.mockClear();
    resetSlackRejudgeState();
    expect(await rejudgeFallbackSlackEpisodes(new Date())).toBe(0);
    expect(judge.judgeEmail).not.toHaveBeenCalled();
  });
});
