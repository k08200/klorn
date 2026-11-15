/**
 * Slack data retention (docs/providers/slack.md §11): message text is deleted
 * 7 days after receipt; an episode — its lane, short reason and timestamps,
 * no text — after 90. Run from the Slack scheduler, independent of
 * LOG_RETENTION_ENABLED, so the promise holds wherever Slack is on.
 */

import { prisma } from "../db.js";

export const SLACK_MESSAGE_RETENTION_DAYS = 7;
export const SLACK_EPISODE_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

export async function purgeExpiredSlackData(
  now: Date = new Date(),
): Promise<{ messages: number; episodes: number }> {
  const messages = await prisma.slackMessage.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - SLACK_MESSAGE_RETENTION_DAYS * DAY_MS) } },
  });
  const episodes = await prisma.slackEpisode.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - SLACK_EPISODE_RETENTION_DAYS * DAY_MS) } },
  });
  return { messages: messages.count, episodes: episodes.count };
}
