/**
 * Slack v1 storage (docs/providers/slack.md §5, §7, §11): episode grouping,
 * retry/replay dedupe by event_id, the 7-day text / 90-day verdict purge, and
 * the connection store (secrets encrypted, never selected for the client,
 * disconnect deletes everything). Prisma is faked; the behaviour under test
 * is which queries run with which scope.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const tx = {
    slackMessage: { findUnique: vi.fn(), create: vi.fn() },
    slackEpisode: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      slackMessage: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      slackEpisode: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      slackConnection: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        deleteMany: vi.fn(async () => ({ count: 1 })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    },
  };
});
vi.mock("../db.js", () => ({
  prisma: db.prisma,
  INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 },
}));

import { decryptToken } from "../crypto-tokens.js";
import {
  disconnectSlack,
  findSlackHook,
  getSlackConnectionStatus,
  saveSlackCredentials,
  setSlackOptInChannels,
  startSlackConnection,
} from "../slack/connection-store.js";
import {
  deleteSlackMessageCopy,
  EPISODE_GAP_MS,
  EPISODE_MAX_MESSAGES,
  EPISODE_MAX_WAIT_MS,
  EPISODE_QUIET_MS,
  episodeThreadKey,
  ingestSlackMessage,
  isEpisodeReady,
  markSlackConversationAnswered,
} from "../slack/episodes.js";
import {
  purgeExpiredSlackData,
  SLACK_EPISODE_RETENTION_DAYS,
  SLACK_MESSAGE_RETENTION_DAYS,
} from "../slack/purge.js";

const NOW = new Date("2026-11-14T10:00:00Z");
const DAY_MS = 86_400_000;

const input = (over: Record<string, unknown> = {}) => ({
  connectionId: "conn-1",
  userId: "user-1",
  eventId: "Ev0001",
  channel: "D0DM",
  channelType: "im",
  threadTs: null,
  ts: "1763114400.000100",
  senderId: "UOTHER",
  text: "can you review the deck?",
  mentionsUser: false,
  now: NOW,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.tx.slackMessage.findUnique.mockResolvedValue(null);
  db.tx.slackEpisode.findFirst.mockResolvedValue(null);
  db.tx.slackEpisode.create.mockResolvedValue({ id: "ep-new" });
  db.tx.slackEpisode.update.mockResolvedValue({ id: "ep-open" });
  db.tx.slackMessage.create.mockResolvedValue({ id: "msg-1" });
});

describe("episode grouping", () => {
  it("uses the thread ts as the conversation key, or one key for top-level messages", () => {
    expect(episodeThreadKey("1763.0001")).toBe("1763.0001");
    expect(episodeThreadKey(null)).toBe("");
  });

  it("opens a new episode when no open one is recent enough", async () => {
    expect(await ingestSlackMessage(input())).toBe("stored");
    const where = db.tx.slackEpisode.findFirst.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      connectionId: "conn-1",
      channelId: "D0DM",
      threadKey: "",
      status: "OPEN",
      lastMessageAt: { gte: new Date(NOW.getTime() - EPISODE_GAP_MS) },
      messageCount: { lt: EPISODE_MAX_MESSAGES },
    });
    expect(db.tx.slackEpisode.create.mock.calls[0]?.[0]?.data).toMatchObject({
      userId: "user-1",
      connectionId: "conn-1",
      channelId: "D0DM",
      channelType: "im",
      threadKey: "",
      messageCount: 1,
      firstTs: "1763114400.000100",
      lastTs: "1763114400.000100",
      mentionsUser: false,
    });
    expect(db.tx.slackMessage.create.mock.calls[0]?.[0]?.data).toMatchObject({
      userId: "user-1",
      connectionId: "conn-1",
      episodeId: "ep-new",
      eventId: "Ev0001",
      senderId: "UOTHER",
      text: "can you review the deck?",
    });
  });

  it("appends to the open episode of the same conversation", async () => {
    db.tx.slackEpisode.findFirst.mockResolvedValue({ id: "ep-open" });
    await ingestSlackMessage(input({ threadTs: "1763.0001", mentionsUser: true }));
    expect(db.tx.slackEpisode.create).not.toHaveBeenCalled();
    expect(db.tx.slackEpisode.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "ep-open" },
      data: {
        messageCount: { increment: 1 },
        lastMessageAt: NOW,
        lastTs: "1763114400.000100",
        mentionsUser: true,
      },
    });
    expect(db.tx.slackMessage.create.mock.calls[0]?.[0]?.data.episodeId).toBe("ep-open");
  });

  it("is ready after 90 s of quiet, 5 minutes from the first message, or 20 messages", () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    const fresh = { startedAt: NOW, lastMessageAt: NOW, messageCount: 1 };
    expect(isEpisodeReady(fresh, at(EPISODE_QUIET_MS - 1))).toBe(false);
    expect(isEpisodeReady(fresh, at(EPISODE_QUIET_MS))).toBe(true);
    const chatty = {
      startedAt: NOW,
      lastMessageAt: at(EPISODE_MAX_WAIT_MS - 1000),
      messageCount: 5,
    };
    expect(isEpisodeReady(chatty, at(EPISODE_MAX_WAIT_MS - 500))).toBe(false);
    expect(isEpisodeReady(chatty, at(EPISODE_MAX_WAIT_MS))).toBe(true);
    expect(isEpisodeReady({ ...fresh, messageCount: EPISODE_MAX_MESSAGES }, NOW)).toBe(true);
  });
});

describe("retry and replay dedupe", () => {
  it("a replayed event_id stores nothing and touches no episode", async () => {
    db.tx.slackMessage.findUnique.mockResolvedValue({ id: "msg-1" });
    expect(await ingestSlackMessage(input())).toBe("duplicate");
    expect(db.tx.slackMessage.findUnique.mock.calls[0]?.[0]?.where).toEqual({
      connectionId_eventId: { connectionId: "conn-1", eventId: "Ev0001" },
    });
    expect(db.tx.slackEpisode.findFirst).not.toHaveBeenCalled();
    expect(db.tx.slackEpisode.create).not.toHaveBeenCalled();
    expect(db.tx.slackMessage.create).not.toHaveBeenCalled();
  });

  it("a concurrent duplicate that loses the unique race is a duplicate, not an error", async () => {
    db.prisma.$transaction.mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "P2002" }),
    );
    expect(await ingestSlackMessage(input())).toBe("duplicate");
  });

  it("other database errors propagate so Slack retries", async () => {
    db.prisma.$transaction.mockRejectedValueOnce(new Error("pool timeout"));
    await expect(ingestSlackMessage(input())).rejects.toThrow("pool timeout");
  });
});

describe("own replies and deletions", () => {
  it("the user's reply marks the open episode of that conversation answered", async () => {
    db.prisma.slackEpisode.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(
      await markSlackConversationAnswered({
        connectionId: "conn-1",
        channel: "D0DM",
        threadTs: null,
      }),
    ).toBe(1);
    expect(db.prisma.slackEpisode.updateMany.mock.calls[0]?.[0]).toEqual({
      where: { connectionId: "conn-1", channelId: "D0DM", threadKey: "", status: "OPEN" },
      data: { status: "ANSWERED" },
    });
  });

  it("message_deleted deletes Klorn's copy, scoped to the connection", async () => {
    await deleteSlackMessageCopy({ connectionId: "conn-1", channel: "C0X", ts: "1763.0002" });
    expect(db.prisma.slackMessage.deleteMany).toHaveBeenCalledWith({
      where: { connectionId: "conn-1", channelId: "C0X", ts: "1763.0002" },
    });
  });
});

describe("purgeExpiredSlackData", () => {
  it("deletes message text after 7 days and episode verdicts after 90", async () => {
    db.prisma.slackMessage.deleteMany.mockResolvedValueOnce({ count: 4 });
    db.prisma.slackEpisode.deleteMany.mockResolvedValueOnce({ count: 2 });
    expect(SLACK_MESSAGE_RETENTION_DAYS).toBe(7);
    expect(SLACK_EPISODE_RETENTION_DAYS).toBe(90);
    expect(await purgeExpiredSlackData(NOW)).toEqual({ messages: 4, episodes: 2 });
    expect(db.prisma.slackMessage.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date(NOW.getTime() - 7 * DAY_MS) } },
    });
    expect(db.prisma.slackEpisode.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date(NOW.getTime() - 90 * DAY_MS) } },
    });
  });

  it("a message 6 days old survives and one 8 days old does not (the cutoff is exact)", async () => {
    await purgeExpiredSlackData(NOW);
    const cutoff = db.prisma.slackMessage.deleteMany.mock.calls[0]?.[0]?.where.createdAt.lt as Date;
    expect(new Date(NOW.getTime() - 6 * DAY_MS) < cutoff).toBe(false);
    expect(new Date(NOW.getTime() - 8 * DAY_MS) < cutoff).toBe(true);
  });
});

describe("connection store", () => {
  it("starting a connection mints a 128-bit hex hookId once and is idempotent", async () => {
    db.prisma.slackConnection.findUnique.mockResolvedValueOnce(null);
    db.prisma.slackConnection.create.mockImplementationOnce(
      async (args: { data: unknown }) => args.data,
    );
    await startSlackConnection("user-1");
    const data = db.prisma.slackConnection.create.mock.calls[0]?.[0]?.data as {
      userId: string;
      hookId: string;
    };
    expect(data.userId).toBe("user-1");
    expect(data.hookId).toMatch(/^[0-9a-f]{32}$/);

    db.prisma.slackConnection.findUnique.mockResolvedValueOnce({ id: "c1" });
    await startSlackConnection("user-1");
    expect(db.prisma.slackConnection.create).toHaveBeenCalledTimes(1);
  });

  it("the status never selects a secret column", async () => {
    db.prisma.slackConnection.findUnique.mockResolvedValueOnce(null);
    expect(await getSlackConnectionStatus("user-1")).toEqual({ state: "none" });
    const args = db.prisma.slackConnection.findUnique.mock.calls[0]?.[0];
    expect(args.where).toEqual({ userId: "user-1" });
    expect(Object.keys(args.select)).not.toContain("signingSecretCipher");
    expect(Object.keys(args.select)).not.toContain("userTokenCipher");
  });

  it("stores both secrets encrypted, scoped to the session user", async () => {
    db.prisma.slackConnection.findUnique.mockResolvedValueOnce({ id: "c1", teamId: null });
    await saveSlackCredentials("user-1", {
      signingSecret: "8f742231b10e8888abcd99eeeeee85a5",
      userToken: "xoxp-1-2-3",
      teamId: "T0001",
      slackUserId: "U0001",
      workspaceUrl: "https://acme.slack.com/",
      now: NOW,
    });
    const args = db.prisma.slackConnection.update.mock.calls[0]?.[0];
    expect(args.where).toEqual({ userId: "user-1" });
    expect(args.data.signingSecretCipher).not.toContain("8f742231");
    expect(args.data.userTokenCipher).not.toContain("xoxp");
    expect(decryptToken(args.data.signingSecretCipher)).toBe("8f742231b10e8888abcd99eeeeee85a5");
    expect(decryptToken(args.data.userTokenCipher)).toBe("xoxp-1-2-3");
    expect(args.select).toBeDefined();
    expect(Object.keys(args.select)).not.toContain("userTokenCipher");
  });

  it("switching to another workspace drops what was stored from the old one", async () => {
    db.prisma.slackConnection.findUnique.mockResolvedValueOnce({ id: "c1", teamId: "TOLD" });
    await saveSlackCredentials("user-1", {
      signingSecret: "8f742231b10e8888abcd99eeeeee85a5",
      userToken: "xoxp-1-2-3",
      teamId: "TNEW",
      slackUserId: "U0001",
      workspaceUrl: "https://new.slack.com/",
      now: NOW,
    });
    expect(db.prisma.slackEpisode.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
  });

  it("refuses credentials before the connection was started", async () => {
    db.prisma.slackConnection.findUnique.mockResolvedValueOnce(null);
    await expect(
      saveSlackCredentials("user-1", {
        signingSecret: "s",
        userToken: "xoxp-1",
        teamId: "T",
        slackUserId: "U",
        workspaceUrl: "https://a.slack.com/",
        now: NOW,
      }),
    ).resolves.toBe("not-started");
    expect(db.prisma.slackConnection.update).not.toHaveBeenCalled();
  });

  it("opt-in channels are written to the session user's row only", async () => {
    await setSlackOptInChannels("user-1", ["C0001"]);
    expect(db.prisma.slackConnection.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { optInChannelIds: ["C0001"] },
    });
  });

  it("disconnect deletes the user's messages, episodes and connection", async () => {
    await disconnectSlack("user-1");
    expect(db.prisma.slackMessage.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(db.prisma.slackEpisode.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(db.prisma.slackConnection.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });

  it("the webhook lookup reads one hook and only what verification and the filter need", async () => {
    db.prisma.slackConnection.findUnique.mockResolvedValueOnce(null);
    expect(await findSlackHook("a".repeat(32))).toBeNull();
    const args = db.prisma.slackConnection.findUnique.mock.calls[0]?.[0];
    expect(args.where).toEqual({ hookId: "a".repeat(32) });
    expect(Object.keys(args.select)).not.toContain("userTokenCipher");
  });
});
