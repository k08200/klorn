/**
 * Slack conversation episodes (docs/providers/slack.md §7). An episode is one
 * burst of messages in one conversation — the same channel and thread (or the
 * top level) — each within EPISODE_GAP_MS of the previous. It is judged once,
 * when it goes quiet, gets old, or gets long; a message after that starts a
 * new episode. One LLM call per burst, not per message.
 */

import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";
import { isUniqueViolation } from "../mail/email-attachments.js";

/** A message joins the open episode when it arrives within this of the last one. */
export const EPISODE_GAP_MS = 10 * 60_000;
/** Judged once nothing new arrived for this long. */
export const EPISODE_QUIET_MS = 90_000;
/** Judged at most this long after its first message, even if the talk goes on. */
export const EPISODE_MAX_WAIT_MS = 5 * 60_000;
/** Judged at once when it holds this many messages; the next starts a new one. */
export const EPISODE_MAX_MESSAGES = 20;

export type EpisodeStatus = "OPEN" | "JUDGING" | "JUDGED" | "ANSWERED";

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

/**
 * Stores one kept message and files it under its episode. A retried or
 * replayed event_id stores nothing ("duplicate"); any other database error is
 * thrown so the webhook answers 5xx and Slack retries.
 */
export async function ingestSlackMessage(input: SlackIngestInput): Promise<"stored" | "duplicate"> {
  const now = input.now ?? new Date();
  const threadKey = episodeThreadKey(input.threadTs);
  try {
    return await prisma.$transaction(async (tx) => {
      const seen = await tx.slackMessage.findUnique({
        where: {
          connectionId_eventId: { connectionId: input.connectionId, eventId: input.eventId },
        },
        select: { id: true },
      });
      if (seen) return "duplicate" as const;
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
      const episode = open
        ? await tx.slackEpisode.update({
            where: { id: open.id },
            data: {
              messageCount: { increment: 1 },
              lastMessageAt: now,
              lastTs: input.ts,
              ...(input.mentionsUser ? { mentionsUser: true } : {}),
            },
            select: { id: true },
          })
        : await tx.slackEpisode.create({
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
      await tx.slackMessage.create({
        data: {
          userId: input.userId,
          connectionId: input.connectionId,
          episodeId: episode.id,
          eventId: input.eventId,
          channelId: input.channel,
          ts: input.ts,
          threadTs: input.threadTs,
          senderId: input.senderId,
          text: input.text,
          createdAt: now,
        },
      });
      return "stored" as const;
    }, INTERACTIVE_TX_OPTIONS);
  } catch (err) {
    if (isUniqueViolation(err)) return "duplicate";
    throw err;
  }
}

/**
 * The user replied in this conversation: its open episode needs no judgment
 * and no notification. Returns how many episodes were closed.
 */
export async function markSlackConversationAnswered(input: {
  connectionId: string;
  channel: string;
  threadTs: string | null;
}): Promise<number> {
  const result = await prisma.slackEpisode.updateMany({
    where: {
      connectionId: input.connectionId,
      channelId: input.channel,
      threadKey: episodeThreadKey(input.threadTs),
      status: "OPEN",
    },
    data: { status: "ANSWERED" },
  });
  return result.count;
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
