/**
 * Slack v1 part 2 (docs/providers/slack.md §8-§10): permalinks, push content,
 * judging an episode through the existing judge, ringing a PUSH episode under
 * the interrupt budget, and the scheduler's judge sweep (claim, judge, notify,
 * commitments, cohort, per-connection daily cap, empty episodes).
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
const lang = vi.hoisted(() => ({ value: "en" }));
vi.mock("../notify/notification-strings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../notify/notification-strings.js")>();
  return { ...actual, getUserNotificationLanguage: vi.fn(async () => lang.value) };
});
const budget = vi.hoisted(() => ({ admitPushNotification: vi.fn() }));
vi.mock("../judge/v3/push-budget-gate.js", () => budget);
const ring = vi.hoisted(() => ({
  pushNotification: vi.fn(),
  sendPushNotification: vi.fn(async () => ({ dispatchedAt: null })),
  desktopAlertTag: vi.fn(async () => ({ alert: "push" })),
}));
vi.mock("../websocket.js", () => ({ pushNotification: ring.pushNotification }));
vi.mock("../notify/push.js", () => ({ sendPushNotification: ring.sendPushNotification }));
vi.mock("../notify/desktop-alert.js", () => ({ desktopAlertTag: ring.desktopAlertTag }));
const commit = vi.hoisted(() => ({
  extractAndUpsertCommitmentsFromText: vi.fn(async () => ({
    candidatesFound: 1,
    commitmentsCreated: 1,
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
      // The reply re-check before a ring: unanswered.
      findFirst: vi.fn(async () => ({ id: "ep-1" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => 0),
    },
    slackMessage: { findMany: vi.fn() },
  },
}));
vi.mock("../db.js", () => db);
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { captureError } from "../sentry.js";

import { judgeSlackEpisode, slackConversationKind } from "../slack/judge-episode.js";
import {
  judgeReadySlackEpisodes,
  SLACK_JUDGED_EPISODES_PER_DAY,
  SLACK_OPT_IN_EPISODES_PER_DAY,
  SLACK_RING_RECENCY_MS,
} from "../slack/judge-sweep.js";
import {
  notifySlackPush,
  SLACK_BELL_ROWS_PER_DAY,
  SLACK_PUSH_OPEN_PATH,
  SLACK_RINGS_PER_DAY,
} from "../slack/notify.js";
import { slackPermalink } from "../slack/permalink.js";
import { slackPushContent } from "../slack/push-content.js";
import { callText } from "./helpers/canary.js";
import {
  DB_CANARY,
  knownErrorQuotingSubject,
  validationErrorQuotingText,
} from "./helpers/prisma-canary.js";

const NOW = new Date("2026-11-14T10:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  lang.value = "en";
  delete process.env.SLACK_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
  delete process.env.BACKGROUND_AGENTS_DISABLED;
  judge.judgeEmail.mockResolvedValue({
    tier: "PUSH",
    reason: "Prod down, needs you now",
    features: {},
    source: "llm",
  });
  budget.admitPushNotification.mockResolvedValue({
    status: "admitted",
    notification: { id: "n1", createdAt: NOW },
  });
});

describe("slackPermalink", () => {
  it("builds Slack's archive link, with thread parameters for a reply", () => {
    expect(slackPermalink("https://acme.slack.com/", "D0DM", "1763100000.000100", null)).toBe(
      "https://acme.slack.com/archives/D0DM/p1763100000000100",
    );
    expect(
      slackPermalink("https://acme.slack.com/", "C0X", "1763100009.000200", "1763100000.000100"),
    ).toBe(
      "https://acme.slack.com/archives/C0X/p1763100009000200?thread_ts=1763100000.000100&cid=C0X",
    );
  });

  it("refuses a workspace URL that is not https on slack.com", () => {
    expect(slackPermalink("https://evil.example.com/", "D0DM", "1.2", null)).toBeNull();
    expect(slackPermalink(null, "D0DM", "1.2", null)).toBeNull();
  });
});

describe("slackPushContent", () => {
  it("titles by how the message reached the user and keeps the body plain and short", () => {
    const content = slackPushContent({
      kind: "mention",
      preview: `<@U1> can you check <https://x.example|the dashboard>? ${"z".repeat(400)}`,
      reason: "Asks you to check a dashboard",
      language: "en",
    });
    expect(content.title).toBe("Slack · You were mentioned");
    const [line1, line2] = content.body.split("\n");
    expect(line1?.startsWith("@someone can you check the dashboard?")).toBe(true);
    expect((line1 ?? "").length).toBeLessThanOrEqual(180);
    expect(line2).toBe("Asks you to check a dashboard");
  });

  it("is localized in every notification language", () => {
    for (const language of ["en", "ko", "ja", "zh", "es", "fr", "de"]) {
      const title = slackPushContent({ kind: "dm", preview: "hi", reason: "", language }).title;
      expect(title.startsWith("Slack")).toBe(true);
      expect(title.length).toBeGreaterThan("Slack · ".length);
    }
    expect(
      slackPushContent({ kind: "dm", preview: "hi", reason: "", language: "ko" }).title,
    ).not.toBe(slackPushContent({ kind: "dm", preview: "hi", reason: "", language: "en" }).title);
  });
});

describe("judgeSlackEpisode", () => {
  it("names the conversation kind from the channel type and mention", () => {
    expect(slackConversationKind("im", false)).toBe("dm");
    expect(slackConversationKind("mpim", false)).toBe("group_dm");
    expect(slackConversationKind("channel", true)).toBe("mention");
    expect(slackConversationKind("group", false)).toBe("opt_in");
  });

  it("calls the existing judge as a Slack item with the user's credentials and caps the reason", async () => {
    judge.judgeEmail.mockResolvedValueOnce({
      tier: "AUTO",
      reason: "r".repeat(500),
      features: {},
      source: "llm",
    });
    const result = await judgeSlackEpisode({
      userId: "user-1",
      channelType: "im",
      mentionsUser: false,
      messages: [{ text: "first <@U1>" }, { text: "second" }],
    });
    const call = judge.judgeEmail.mock.calls[0] ?? [];
    expect(call[0]).toMatchObject({
      from: "",
      subject: "",
      snippet: "first @someone",
      body: "first @someone | second",
      slack: { conversation: "dm" },
    });
    expect(call[1]).toBe("user-1");
    expect(call[3]).toEqual({ chain: [] });
    // Outside the slice of the daily cap reserved for incoming mail.
    expect(call[7]).toEqual({ backlog: true });
    // A retired lane can never come out: AUTO folds to QUEUE.
    expect(result?.tier).toBe("QUEUE");
    expect(result?.reason.length).toBe(200);
  });

  it("has nothing to judge when every message is blank after rendering", async () => {
    const result = await judgeSlackEpisode({
      userId: "user-1",
      channelType: "im",
      mentionsUser: false,
      messages: [{ text: "   " }, { text: "" }],
    });
    expect(result).toBeNull();
    expect(judge.judgeEmail).not.toHaveBeenCalled();
  });
});

describe("notifySlackPush", () => {
  const input = {
    userId: "user-1",
    episodeId: "ep-1",
    kind: "dm" as const,
    preview: "prod is down",
    reason: "Needs you now",
    link: "https://acme.slack.com/archives/D0DM/p1",
    now: NOW,
  };

  it("spends an interrupt-budget slot, then rings the open clients and device push", async () => {
    expect(await notifySlackPush(input)).toBe("admitted");
    expect(budget.admitPushNotification).toHaveBeenCalledWith(
      "user-1",
      {
        type: "slack",
        title: "Slack · Direct message",
        message: "prod is down\nNeeds you now",
        link: input.link,
      },
      { pinned: false, trusted: false, now: NOW },
    );
    expect(ring.pushNotification).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ id: "n1", type: "slack", link: input.link, alert: "push" }),
    );
    expect(ring.sendPushNotification).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        title: "Slack · Direct message",
        url: SLACK_PUSH_OPEN_PATH,
        bellNotificationId: "n1",
      }),
      "email_urgent",
      { bucket: "interrupt" },
    );
    // No notificationId: phone escalation keys on it, and a Slack message from
    // anyone in the workspace must never dial the user's phone.
    const payload = (ring.sendPushNotification.mock.calls[0] as unknown[] | undefined)?.[1];
    expect(payload).not.toHaveProperty("notificationId");
  });

  it("past two Slack rings today, writes a quiet bell row instead of ringing", async () => {
    db.prisma.notification.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(SLACK_RINGS_PER_DAY);
    expect(await notifySlackPush(input)).toBe("held");
    expect(budget.admitPushNotification).not.toHaveBeenCalled();
    expect(ring.sendPushNotification).not.toHaveBeenCalled();
    expect(db.prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it("past the daily Slack bell-row cap, writes nothing at all", async () => {
    db.prisma.notification.count
      .mockResolvedValueOnce(SLACK_BELL_ROWS_PER_DAY)
      .mockResolvedValueOnce(0);
    expect(await notifySlackPush(input)).toBe("capped");
    expect(budget.admitPushNotification).not.toHaveBeenCalled();
    expect(db.prisma.notification.create).not.toHaveBeenCalled();
  });

  it("held by the budget: a bell row only, no ring", async () => {
    budget.admitPushNotification.mockResolvedValueOnce({ status: "held", limit: 5 });
    expect(await notifySlackPush(input)).toBe("held");
    expect(db.prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "user-1", type: "slack", dedupeKey: "slack:ep-1" }),
      select: { id: true },
    });
    expect(ring.sendPushNotification).not.toHaveBeenCalled();
  });

  it("quiet hours or opt-out (will not ring): the row is written, nothing rings", async () => {
    budget.admitPushNotification.mockResolvedValueOnce({
      status: "unbudgeted",
      notification: { id: "n2", createdAt: NOW },
      why: "will_not_ring",
    });
    expect(await notifySlackPush(input)).toBe("unbudgeted");
    expect(ring.sendPushNotification).not.toHaveBeenCalled();
  });
});

describe("judgeReadySlackEpisodes", () => {
  const episode = (over: Record<string, unknown> = {}) => ({
    id: "ep-1",
    userId: "user-1",
    connectionId: "conn-1",
    channelId: "D0DM",
    channelType: "im",
    threadKey: "",
    mentionsUser: false,
    firstTs: "1763100000.000100",
    lastTs: "1763100000.000100",
    startedAt: new Date(NOW.getTime() - 10 * 60_000),
    lastMessageAt: new Date(NOW.getTime() - 5 * 60_000),
    messageCount: 1,
    connection: { workspaceUrl: "https://acme.slack.com/" },
    ...over,
  });

  beforeEach(() => {
    process.env.SLACK_ENABLED = "true";
    db.prisma.slackEpisode.findMany.mockResolvedValue([episode()]);
    db.prisma.slackMessage.findMany.mockResolvedValue([
      { text: "can you send the contract by Friday?", ts: "1763100000.000100", threadTs: null },
    ]);
  });

  it("does nothing while SLACK_ENABLED is off or the background brake is on", async () => {
    delete process.env.SLACK_ENABLED;
    expect(await judgeReadySlackEpisodes(NOW)).toBe(0);
    process.env.SLACK_ENABLED = "true";
    process.env.BACKGROUND_AGENTS_DISABLED = "true";
    expect(await judgeReadySlackEpisodes(NOW)).toBe(0);
    expect(db.prisma.slackEpisode.findMany).not.toHaveBeenCalled();
  });

  it("claims a ready episode, judges it, rings PUSH with a permalink, extracts commitments", async () => {
    expect(await judgeReadySlackEpisodes(NOW)).toBe(1);
    expect(db.prisma.slackEpisode.updateMany.mock.calls[0]?.[0]).toEqual({
      where: {
        id: "ep-1",
        OR: [
          { status: "OPEN" },
          { status: "JUDGING", claimedAt: { lte: new Date(NOW.getTime() - 10 * 60_000) } },
        ],
      },
      data: { status: "JUDGING", claimedAt: NOW },
    });
    // The verdict is stored first, guarded on the claim; notifiedAt only after a ring.
    expect(db.prisma.slackEpisode.updateMany.mock.calls[1]?.[0]).toEqual({
      where: { id: "ep-1", status: "JUDGING" },
      data: {
        status: "JUDGED",
        tier: "PUSH",
        reason: "Prod down, needs you now",
        verdictSource: "llm",
        judgedAt: NOW,
      },
    });
    expect(db.prisma.slackEpisode.updateMany.mock.calls[2]?.[0]).toMatchObject({
      where: { id: "ep-1" },
      data: { notifiedAt: expect.any(Date) },
    });
    expect(budget.admitPushNotification.mock.calls[0]?.[1]?.link).toBe(
      "https://acme.slack.com/archives/D0DM/p1763100000000100",
    );
    expect(commit.extractAndUpsertCommitmentsFromText).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        sourceType: "SLACK",
        sourceId: "D0DM:1763100000.000100",
        text: "can you send the contract by Friday?",
        senderIsUser: false,
      }),
    );
  });

  it("an episode another worker claimed first is skipped", async () => {
    db.prisma.slackEpisode.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await judgeReadySlackEpisodes(NOW)).toBe(0);
    expect(judge.judgeEmail).not.toHaveBeenCalled();
  });

  it("does not ring or extract for a quiet lane, and SILENT skips commitments", async () => {
    judge.judgeEmail.mockResolvedValueOnce({
      tier: "SILENT",
      reason: "chit-chat",
      features: {},
      source: "llm",
    });
    await judgeReadySlackEpisodes(NOW);
    expect(budget.admitPushNotification).not.toHaveBeenCalled();
    expect(commit.extractAndUpsertCommitmentsFromText).not.toHaveBeenCalled();
  });

  it("only looks at the cohort's episodes in cohort mode, and at none with an empty cohort", async () => {
    process.env.SLACK_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
    await judgeReadySlackEpisodes(NOW);
    expect(db.prisma.slackEpisode.findMany.mock.calls[0]?.[0]?.where?.userId).toEqual({
      in: ["someone-else"],
    });
    db.prisma.slackEpisode.findMany.mockClear();
    process.env.ROLLOUT_COHORT_USER_IDS = "";
    expect(await judgeReadySlackEpisodes(NOW)).toBe(0);
    expect(db.prisma.slackEpisode.findMany).not.toHaveBeenCalled();
  });

  it("re-claims an episode whose JUDGING claim is older than the claim timeout", async () => {
    await judgeReadySlackEpisodes(NOW);
    const where = db.prisma.slackEpisode.findMany.mock.calls[0]?.[0]?.where;
    expect(where.OR[1]).toEqual({
      status: "JUDGING",
      claimedAt: { lte: new Date(NOW.getTime() - 10 * 60_000) },
    });
  });

  it("past the per-connection daily cap an episode is closed without an LLM call", async () => {
    db.prisma.slackEpisode.count.mockResolvedValueOnce(SLACK_JUDGED_EPISODES_PER_DAY);
    await judgeReadySlackEpisodes(NOW);
    expect(judge.judgeEmail).not.toHaveBeenCalled();
    expect(db.prisma.slackEpisode.updateMany.mock.calls[1]?.[0]).toEqual({
      where: { id: "ep-1", status: "JUDGING" },
      data: { status: "OVER_CAP", judgedAt: NOW },
    });
  });

  it("followed-channel chatter has its own smaller cap, so DMs keep room", async () => {
    db.prisma.slackEpisode.findMany.mockResolvedValue([
      episode({ channelType: "channel", channelId: "C0OPT", mentionsUser: false }),
    ]);
    db.prisma.slackEpisode.count
      .mockResolvedValueOnce(SLACK_OPT_IN_EPISODES_PER_DAY)
      .mockResolvedValueOnce(SLACK_OPT_IN_EPISODES_PER_DAY);
    await judgeReadySlackEpisodes(NOW);
    expect(judge.judgeEmail).not.toHaveBeenCalled();
    // A DM at the same counts is still judged.
    db.prisma.slackEpisode.findMany.mockResolvedValue([episode()]);
    db.prisma.slackEpisode.count.mockResolvedValueOnce(SLACK_OPT_IN_EPISODES_PER_DAY);
    await judgeReadySlackEpisodes(NOW);
    expect(judge.judgeEmail).toHaveBeenCalledTimes(1);
  });

  it("an episode whose messages were all deleted is closed as empty", async () => {
    db.prisma.slackMessage.findMany.mockResolvedValueOnce([]);
    await judgeReadySlackEpisodes(NOW);
    expect(judge.judgeEmail).not.toHaveBeenCalled();
    expect(db.prisma.slackEpisode.updateMany.mock.calls[1]?.[0]).toEqual({
      where: { id: "ep-1", status: "JUDGING" },
      data: { status: "EMPTY", judgedAt: NOW },
    });
  });

  it("a judge failure lands the episode in QUEUE, the default lane, instead of looping", async () => {
    judge.judgeEmail.mockRejectedValueOnce(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await judgeReadySlackEpisodes(NOW);
    error.mockRestore();
    expect(db.prisma.slackEpisode.updateMany.mock.calls[1]?.[0]).toMatchObject({
      where: { id: "ep-1", status: "JUDGING" },
      data: { status: "JUDGED", tier: "QUEUE" },
    });
  });

  it("a disconnect mid-judge (claim lost) writes nothing further: no ring, no commitments", async () => {
    db.prisma.slackEpisode.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await judgeReadySlackEpisodes(NOW);
    expect(budget.admitPushNotification).not.toHaveBeenCalled();
    expect(commit.extractAndUpsertCommitmentsFromText).not.toHaveBeenCalled();
  });

  it("a failing ring or commitment pass never rewrites the stored verdict", async () => {
    budget.admitPushNotification.mockRejectedValueOnce(new Error("push down"));
    commit.extractAndUpsertCommitmentsFromText.mockRejectedValueOnce(new Error("ledger down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await judgeReadySlackEpisodes(NOW);
    error.mockRestore();
    const writes = db.prisma.slackEpisode.updateMany.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(writes.filter((d) => d.tier === "QUEUE")).toEqual([]);
    expect(writes.filter((d) => "notifiedAt" in d)).toEqual([]);
  });

  it("held or quiet-hours outcomes do not stamp notifiedAt", async () => {
    budget.admitPushNotification.mockResolvedValueOnce({ status: "held", limit: 5 });
    await judgeReadySlackEpisodes(NOW);
    const writes = db.prisma.slackEpisode.updateMany.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(writes.filter((d) => "notifiedAt" in d)).toEqual([]);
  });

  it("a PUSH verdict on talk older than six hours is stored but does not ring", async () => {
    db.prisma.slackEpisode.findMany.mockResolvedValue([
      episode({ lastMessageAt: new Date(NOW.getTime() - SLACK_RING_RECENCY_MS - 1) }),
    ]);
    await judgeReadySlackEpisodes(NOW);
    expect(db.prisma.slackEpisode.updateMany.mock.calls[1]?.[0]?.data).toMatchObject({
      tier: "PUSH",
    });
    expect(budget.admitPushNotification).not.toHaveBeenCalled();
  });

  it("does not mine followed-channel chatter for commitments", async () => {
    db.prisma.slackEpisode.findMany.mockResolvedValue([
      episode({ channelType: "channel", channelId: "C0OPT", mentionsUser: false }),
    ]);
    judge.judgeEmail.mockResolvedValueOnce({
      tier: "QUEUE",
      reason: "fyi",
      features: {},
      source: "llm",
    });
    await judgeReadySlackEpisodes(NOW);
    expect(commit.extractAndUpsertCommitmentsFromText).not.toHaveBeenCalled();
  });
  describe("a database error quoting the Slack text never reaches Sentry or the console", () => {
    let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;
    beforeEach(() => {
      consoleSpies = (["error", "warn", "log"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => {}),
      );
    });
    afterEach(() => {
      for (const spy of consoleSpies) spy.mockRestore();
    });

    const expectNoCanary = () => {
      expect(callText(vi.mocked(captureError))).not.toContain(DB_CANARY);
      for (const spy of consoleSpies) expect(callText(spy)).not.toContain(DB_CANARY);
    };

    it.each([
      [
        "judging (the messages read)",
        "slack.judge",
        () => db.prisma.slackMessage.findMany.mockRejectedValueOnce(validationErrorQuotingText()),
      ],
      [
        "ringing",
        "slack.notify",
        () => budget.admitPushNotification.mockRejectedValueOnce(knownErrorQuotingSubject()),
      ],
      [
        "the commitment pass",
        "slack.commitments",
        () =>
          commit.extractAndUpsertCommitmentsFromText.mockRejectedValueOnce(
            validationErrorQuotingText(),
          ),
      ],
    ])("when %s fails: the facts under scope %s", async (_step, scope, fail) => {
      fail();
      await judgeReadySlackEpisodes(NOW);
      expect(captureError).toHaveBeenCalledTimes(1);
      expect(vi.mocked(captureError).mock.calls[0]?.[1]).toMatchObject({
        tags: { scope },
        extra: { episodeId: "ep-1" },
      });
      expectNoCanary();
    });

    it("when queueing the unjudged episode fails too", async () => {
      db.prisma.slackMessage.findMany.mockRejectedValueOnce(validationErrorQuotingText());
      db.prisma.slackEpisode.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(knownErrorQuotingSubject());
      await judgeReadySlackEpisodes(NOW);
      await vi.waitFor(() => expect(captureError).toHaveBeenCalledTimes(2));
      expect(vi.mocked(captureError).mock.calls[1]?.[1]).toMatchObject({
        tags: { scope: "slack.judge" },
        extra: { code: "P2002", model: "Notification" },
      });
      expectNoCanary();
    });
  });
});
