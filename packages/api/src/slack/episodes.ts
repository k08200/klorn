/**
 * Slack conversation episodes (docs/providers/slack.md §7). An episode is one
 * burst of messages in one conversation — the same channel and thread (or the
 * top level) — each within EPISODE_GAP_MS of the previous. It is judged once,
 * when it goes quiet, gets old, or gets long; a message after that starts a
 * new episode. One LLM call per burst, not per message.
 *
 * Concurrency: each ingest takes a transaction-scoped advisory lock on its
 * conversation key, so two first messages arriving together cannot open two
 * episodes, and an append only lands on an episode that is still OPEN (one the
 * judge already claimed is left alone and a new episode starts).
 *
 * Storage caps (§11): a connection keeps at most SLACK_MAX_MESSAGES_PER_HOUR
 * new messages an hour and SLACK_MAX_LIVE_MESSAGES unexpired ones. The signing
 * secret is the connection owner's own, so a signed event proves who sent it,
 * not that Slack did; the caps bound what one connection can store.
 */

import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";
import { isUniqueViolation } from "./unique-violation.js";

/** A message joins the open episode when it arrives within this of the last one. */
export const EPISODE_GAP_MS = 10 * 60_000;
/** Judged once nothing new arrived for this long. */
export const EPISODE_QUIET_MS = 90_000;
/** Judged at most this long after its first message, even if the talk goes on. */
export const EPISODE_MAX_WAIT_MS = 5 * 60_000;
/** Judged at once when it holds this many messages; the next starts a new one. */
export const EPISODE_MAX_MESSAGES = 20;
/** New messages one connection may store per hour; past it they are dropped. */
export const SLACK_MAX_MESSAGES_PER_HOUR = 300;
/** Unexpired messages one connection may hold (7-day retention). */
export const SLACK_MAX_LIVE_MESSAGES = 3000;
const HOUR_MS = 3_600_000;

export type EpisodeStatus = "OPEN" | "JUDGING" | "JUDGED" | "ANSWERED";
export type IngestResult = "stored" | "duplicate" | "capped";

export interface SlackIngestInput {
  connectionId: string;
  userId: string;
  eventId: string;
  channel: string;
  channelType: string;
  threadTs: string | null;
  ts: string;
  senderId: string;
  text: string;
  mentionsUser: boolean;
  now?: Date;
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export function episodeThreadKey(threadTs: string | null): string {
  return threadTs ?? "";
}

export function isEpisodeReady(
  episode: { startedAt: Date; lastMessageAt: Date; messageCount: number },
  now: Date,
): boolean {
  const t = now.getTime();
  return (
    episode.messageCount >= EPISODE_MAX_MESSAGES ||
    t - episode.lastMessageAt.getTime() >= EPISODE_QUIET_MS ||
    t - episode.startedAt.getTime() >= EPISODE_MAX_WAIT_MS
  );
}

async function overStorageCap(tx: Tx, connectionId: string, now: Date): Promise<boolean> {
  const lastHour = await tx.slackMessage.count({
    where: { connectionId, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } },
  });
  if (lastHour >= SLACK_MAX_MESSAGES_PER_HOUR) return true;
  const live = await tx.slackMessage.count({ where: { connectionId } });
  return live >= SLACK_MAX_LIVE_MESSAGES;
}

/** Appends to the conversation's OPEN episode; null when there is none to join. */
async function appendToOpenEpisode(
  tx: Tx,
  input: SlackIngestInput,
  threadKey: string,
  now: Date,
): Promise<string | null> {
  const open = await tx.slackEpisode.findFirst({
    where: {
      connectionId: input.connectionId,
      channelId: input.channel,
      threadKey,
      status: "OPEN",
      lastMessageAt: { gte: new Date(now.getTime() - EPISODE_GAP_MS) },
      messageCount: { lt: EPISODE_MAX_MESSAGES },
    },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true },
  });
  if (!open) return null;
  const appended = await tx.slackEpisode.updateMany({
    where: { id: open.id, status: "OPEN" },
    data: {
      messageCount: { increment: 1 },
      lastMessageAt: now,
      lastTs: input.ts,
      ...(input.mentionsUser ? { mentionsUser: true } : {}),
    },
  });
  return appended.count > 0 ? open.id : null;
}

async function createEpisode(
  tx: Tx,
  input: SlackIngestInput,
  threadKey: string,
  now: Date,
): Promise<string> {
  const created = await tx.slackEpisode.create({
    data: {
      userId: input.userId,
      connectionId: input.connectionId,
      channelId: input.channel,
      channelType: input.channelType,
      threadKey,
      messageCount: 1,
      firstTs: input.ts,
      lastTs: input.ts,
      mentionsUser: input.mentionsUser,
      startedAt: now,
      lastMessageAt: now,
    },
    select: { id: true },
  });
  return created.id;
}

async function ingestInTx(tx: Tx, input: SlackIngestInput, now: Date): Promise<IngestResult> {
  const threadKey = episodeThreadKey(input.threadTs);
  const lockKey = `slack:${input.connectionId}:${input.channel}:${threadKey}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  const seen = await tx.slackMessage.findUnique({
    where: { connectionId_eventId: { connectionId: input.connectionId, eventId: input.eventId } },
    select: { id: true },
  });
  if (seen) return "duplicate";
  if (await overStorageCap(tx, input.connectionId, now)) return "capped";
  const episodeId =
    (await appendToOpenEpisode(tx, input, threadKey, now)) ??
    (await createEpisode(tx, input, threadKey, now));
  await tx.slackMessage.create({
    data: {
      userId: input.userId,
      connectionId: input.connectionId,
      episodeId,
      eventId: input.eventId,
      channelId: input.channel,
      ts: input.ts,
      threadTs: input.threadTs,
      senderId: input.senderId,
      text: input.text,
      createdAt: now,
    },
  });
  return "stored";
}

/**
 * Stores one kept message and files it under its episode. A retried or
 * replayed event_id stores nothing ("duplicate"), a connection over its
 * storage caps stores nothing ("capped"); any other database error is thrown
 * so the webhook answers 5xx and Slack retries.
 */
export async function ingestSlackMessage(input: SlackIngestInput): Promise<IngestResult> {
  const now = input.now ?? new Date();
  try {
    return await prisma.$transaction((tx) => ingestInTx(tx, input, now), INTERACTIVE_TX_OPTIONS);
  } catch (err) {
    if (isUniqueViolation(err)) return "duplicate";
    throw err;
  }
}

/**
 * The user replied in this conversation: its open episodes from before the
 * reply need no judgment and no notification. A reply inside a thread also
 * answers the top-level episode holding the thread's parent message. Only
 * episodes whose last message is older than the reply are closed, so a late
 * or replayed reply cannot silence newer messages. Returns how many closed.
 */
export async function markSlackConversationAnswered(input: {
  connectionId: string;
  channel: string;
  threadTs: string | null;
  ts: string;
}): Promise<number> {
  const before = { connectionId: input.connectionId, channelId: input.channel, status: "OPEN" };
  const own = await prisma.slackEpisode.updateMany({
    where: { ...before, threadKey: episodeThreadKey(input.threadTs), lastTs: { lt: input.ts } },
    data: { status: "ANSWERED" },
  });
  if (!input.threadTs) return own.count;
  const parent = await prisma.slackMessage.findFirst({
    where: { connectionId: input.connectionId, channelId: input.channel, ts: input.threadTs },
    select: { episodeId: true },
  });
  if (!parent) return own.count;
  const top = await prisma.slackEpisode.updateMany({
    where: { ...before, id: parent.episodeId, lastTs: { lt: input.ts } },
    data: { status: "ANSWERED" },
  });
  return own.count + top.count;
}

/** Slack's message_deleted: drop Klorn's copy of that message. */
export async function deleteSlackMessageCopy(input: {
  connectionId: string;
  channel: string;
  ts: string;
}): Promise<number> {
  const result = await prisma.slackMessage.deleteMany({
    where: { connectionId: input.connectionId, channelId: input.channel, ts: input.ts },
  });
  return result.count;
}
