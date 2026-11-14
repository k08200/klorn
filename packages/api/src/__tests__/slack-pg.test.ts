/**
 * Real-Postgres proof of Slack v1 storage (docs/providers/slack.md §7, §11,
 * §12): episode grouping, event_id dedupe under retries and a concurrent
 * race, own replies closing an episode, the 7-day / 90-day purge, disconnect
 * scoped to one user, and RLS on all three tables. Skipped unless
 * KLORN_TEST_PG_URL points at a database with every migration applied.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import { disconnectSlack, findSlackHook, startSlackConnection } from "../slack/connection-store.js";
import {
  EPISODE_GAP_MS,
  ingestSlackMessage,
  markSlackConversationAnswered,
} from "../slack/episodes.js";
import { purgeExpiredSlackData } from "../slack/purge.js";

const describePg = url ? describe : describe.skip;
const createdUsers: string[] = [];
const DAY_MS = 86_400_000;

async function newConnection(): Promise<{ userId: string; connectionId: string }> {
  const user = await prisma.user.create({ data: { email: `slack-${randomUUID()}@test.local` } });
  createdUsers.push(user.id);
  await startSlackConnection(user.id);
  const row = await prisma.slackConnection.findUniqueOrThrow({
    where: { userId: user.id },
    select: { id: true },
  });
  return { userId: user.id, connectionId: row.id };
}

const message = (
  ids: { userId: string; connectionId: string },
  over: Partial<Parameters<typeof ingestSlackMessage>[0]> = {},
) => ({
  ...ids,
  eventId: `Ev${randomUUID().replace(/-/g, "").slice(0, 12)}`,
  channel: "D0DM",
  channelType: "im",
  threadTs: null,
  ts: "1763100000.000100",
  senderId: "UOTHER",
  text: "can you send the contract today?",
  mentionsUser: false,
  ...over,
});

afterAll(async () => {
  if (!url) return;
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describePg("Slack storage on Postgres", () => {
  it("groups a DM burst into one episode and splits after the gap", async () => {
    const ids = await newConnection();
    const t0 = new Date();
    await ingestSlackMessage(message(ids, { now: t0 }));
    await ingestSlackMessage(message(ids, { now: new Date(t0.getTime() + 60_000), ts: "2.0" }));
    await ingestSlackMessage(
      message(ids, { now: new Date(t0.getTime() + 60_000 + EPISODE_GAP_MS + 1), ts: "3.0" }),
    );
    const episodes = await prisma.slackEpisode.findMany({
      where: { connectionId: ids.connectionId },
      orderBy: { startedAt: "asc" },
      select: { messageCount: true, firstTs: true, lastTs: true, status: true },
    });
    expect(episodes).toEqual([
      { messageCount: 2, firstTs: "1763100000.000100", lastTs: "2.0", status: "OPEN" },
      { messageCount: 1, firstTs: "3.0", lastTs: "3.0", status: "OPEN" },
    ]);
  });

  it("a retried event_id is stored once, even when the retries race", async () => {
    const ids = await newConnection();
    const event = message(ids);
    const results = await Promise.all([
      ingestSlackMessage(event),
      ingestSlackMessage(event),
      ingestSlackMessage(event),
    ]);
    expect(results.filter((r) => r === "stored")).toHaveLength(1);
    expect(await ingestSlackMessage(event)).toBe("duplicate");
    expect(await prisma.slackMessage.count({ where: { connectionId: ids.connectionId } })).toBe(1);
    const episode = await prisma.slackEpisode.findFirstOrThrow({
      where: { connectionId: ids.connectionId },
      select: { messageCount: true },
    });
    expect(episode.messageCount).toBe(1);
  });

  it("two different first messages arriving together open one episode, not two", async () => {
    const ids = await newConnection();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        ingestSlackMessage(message(ids, { ts: `1763100000.00010${i}` })),
      ),
    );
    expect(results).toEqual(["stored", "stored", "stored", "stored", "stored"]);
    const episodes = await prisma.slackEpisode.findMany({
      where: { connectionId: ids.connectionId },
      select: { messageCount: true },
    });
    expect(episodes).toEqual([{ messageCount: 5 }]);
  });

  it("stores text with NUL and lone surrogates once the envelope sanitized it", async () => {
    const ids = await newConnection();
    const { sanitizeSlackText } = await import("../slack/text.js");
    const text = sanitizeSlackText("a\u0000b\ud800");
    expect(await ingestSlackMessage(message(ids, { text }))).toBe("stored");
  });

  it("the user's reply closes the open episode and the next message opens a new one", async () => {
    const ids = await newConnection();
    await ingestSlackMessage(message(ids));
    // A late (or replayed) reply older than the message answers nothing.
    expect(
      await markSlackConversationAnswered({
        connectionId: ids.connectionId,
        channel: "D0DM",
        threadTs: null,
        ts: "1763099999.000100",
      }),
    ).toBe(0);
    expect(
      await markSlackConversationAnswered({
        connectionId: ids.connectionId,
        channel: "D0DM",
        threadTs: null,
        ts: "1763100100.000100",
      }),
    ).toBe(1);
    await ingestSlackMessage(message(ids, { ts: "1763100200.000100" }));
    const statuses = await prisma.slackEpisode.findMany({
      where: { connectionId: ids.connectionId },
      orderBy: { startedAt: "asc" },
      select: { status: true },
    });
    expect(statuses.map((s) => s.status)).toEqual(["ANSWERED", "OPEN"]);
  });

  it("purges text after 7 days and verdicts after 90, keeping younger rows", async () => {
    const ids = await newConnection();
    const now = new Date();
    await ingestSlackMessage(
      message(ids, { now: new Date(now.getTime() - 8 * DAY_MS), ts: "1.0" }),
    );
    await ingestSlackMessage(
      message(ids, { now: new Date(now.getTime() - 6 * DAY_MS), ts: "2.0" }),
    );
    const old = await prisma.slackEpisode.create({
      data: {
        userId: ids.userId,
        connectionId: ids.connectionId,
        channelId: "D0DM",
        channelType: "im",
        threadKey: "",
        status: "JUDGED",
        tier: "QUEUE",
        reason: "old verdict",
        firstTs: "0.1",
        lastTs: "0.1",
        createdAt: new Date(now.getTime() - 91 * DAY_MS),
      },
      select: { id: true },
    });
    await purgeExpiredSlackData(now);
    const texts = await prisma.slackMessage.findMany({
      where: { connectionId: ids.connectionId },
      select: { ts: true },
    });
    expect(texts.map((t) => t.ts)).toEqual(["2.0"]);
    expect(await prisma.slackEpisode.findUnique({ where: { id: old.id } })).toBeNull();
    // The 8-day-old message's episode is younger than 90 days: its verdict stays.
    expect(await prisma.slackEpisode.count({ where: { connectionId: ids.connectionId } })).toBe(2);
  });

  it("disconnect deletes one user's connection and Slack rows, not another user's", async () => {
    const a = await newConnection();
    const b = await newConnection();
    await ingestSlackMessage(message(a));
    await ingestSlackMessage(message(b));
    const hookA = (
      await prisma.slackConnection.findUniqueOrThrow({
        where: { userId: a.userId },
        select: { hookId: true },
      })
    ).hookId;
    await disconnectSlack(a.userId);
    expect(await findSlackHook(hookA)).toBeNull();
    expect(await prisma.slackMessage.count({ where: { userId: a.userId } })).toBe(0);
    expect(await prisma.slackEpisode.count({ where: { userId: a.userId } })).toBe(0);
    expect(await prisma.slackMessage.count({ where: { userId: b.userId } })).toBe(1);
    expect(await prisma.slackConnection.count({ where: { userId: b.userId } })).toBe(1);
  });

  it("has row-level security on every Slack table", async () => {
    const rows = await prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('SlackConnection', 'SlackEpisode', 'SlackMessage') ORDER BY relname`;
    expect(rows).toEqual([
      { relname: "SlackConnection", relrowsecurity: true },
      { relname: "SlackEpisode", relrowsecurity: true },
      { relname: "SlackMessage", relrowsecurity: true },
    ]);
  });
});
