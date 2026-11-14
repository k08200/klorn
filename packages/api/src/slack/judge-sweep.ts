/**
 * The Slack scheduler's judge pass (docs/providers/slack.md §7-§10): find
 * episodes that are ready (quiet 90 s, 5 minutes old, or 20 messages), claim
 * each one (OPEN → JUDGING, so an ingest can no longer extend it and no other
 * worker judges it twice), judge it with the existing judge, ring a PUSH
 * episode under the interrupt budget, and run the commitment ledger on any
 * lane but SILENT.
 *
 * Off while SLACK_ENABLED is off or BACKGROUND_AGENTS_DISABLED is set (the
 * LLM brake). Cohort-aware. At most SLACK_JUDGED_EPISODES_PER_DAY episodes per
 * connection a day reach the judge; past it an episode is closed OVER_CAP
 * without an LLM call — the signing secret is the user's own, so the episode
 * count is theirs to inflate.
 */

import { SLACK_FLAGS, cohortRestriction } from "../config.js";
import { prisma } from "../db.js";
import { isBackgroundAgentsDisabled } from "../scheduler-heartbeat.js";
import { captureError } from "../sentry.js";
import { extractSlackCommitments } from "./commitments.js";
import {
  EPISODE_MAX_MESSAGES,
  EPISODE_MAX_WAIT_MS,
  EPISODE_QUIET_MS,
} from "./episodes.js";
import { judgeSlackEpisode, slackConversationKind, slackEpisodeText } from "./judge-episode.js";
import { notifySlackPush } from "./notify.js";
import { slackPermalink } from "./permalink.js";

/** Episodes judged per tick; the rest wait for the next 30 s tick. */
export const SLACK_JUDGE_BATCH = 10;
/** Episodes per connection per UTC day that reach the LLM judge. */
export const SLACK_JUDGED_EPISODES_PER_DAY = 200;
/** A JUDGING claim older than this belongs to a crashed tick and is retried. */
export const SLACK_CLAIM_TIMEOUT_MS = 10 * 60_000;
const LOG_PREFIX = "[SLACK]";
const DAY_MS = 86_400_000;

type ReadyEpisode = {
  id: string;
  userId: string;
  connectionId: string;
  channelId: string;
  channelType: string;
  threadKey: string;
  mentionsUser: boolean;
  firstTs: string;
  connection: { workspaceUrl: string | null };
};

const READY_SELECT = {
  id: true,
  userId: true,
  connectionId: true,
  channelId: true,
  channelType: true,
  threadKey: true,
  mentionsUser: true,
  firstTs: true,
  connection: { select: { workspaceUrl: true } },
} as const;

function readyWhere(now: Date, userIds: string[] | null) {
  const t = now.getTime();
  return {
    ...(userIds ? { userId: { in: userIds } } : {}),
    OR: [
      {
        status: "OPEN",
        OR: [
          { lastMessageAt: { lte: new Date(t - EPISODE_QUIET_MS) } },
          { startedAt: { lte: new Date(t - EPISODE_MAX_WAIT_MS) } },
          { messageCount: { gte: EPISODE_MAX_MESSAGES } },
        ],
      },
      { status: "JUDGING", claimedAt: { lte: new Date(t - SLACK_CLAIM_TIMEOUT_MS) } },
    ],
  };
}

async function claim(episodeId: string, now: Date): Promise<boolean> {
  const t = now.getTime();
  const { count } = await prisma.slackEpisode.updateMany({
    where: {
      id: episodeId,
      OR: [
        { status: "OPEN" },
        { status: "JUDGING", claimedAt: { lte: new Date(t - SLACK_CLAIM_TIMEOUT_MS) } },
      ],
    },
    data: { status: "JUDGING", claimedAt: now },
  });
  return count === 1;
}

async function overDailyCap(connectionId: string, now: Date): Promise<boolean> {
  const dayStart = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  const judged = await prisma.slackEpisode.count({
    where: { connectionId, status: "JUDGED", judgedAt: { gte: dayStart } },
  });
  return judged >= SLACK_JUDGED_EPISODES_PER_DAY;
}

async function close(episodeId: string, status: "EMPTY" | "OVER_CAP", now: Date): Promise<void> {
  await prisma.slackEpisode.update({ where: { id: episodeId }, data: { status, judgedAt: now } });
}

async function judgeOne(episode: ReadyEpisode, now: Date): Promise<void> {
  const messages = await prisma.slackMessage.findMany({
    where: { episodeId: episode.id },
    orderBy: { ts: "asc" },
    select: { text: true, ts: true, threadTs: true },
  });
  if (messages.length === 0) return close(episode.id, "EMPTY", now);
  if (await overDailyCap(episode.connectionId, now)) return close(episode.id, "OVER_CAP", now);
  const verdict = await judgeSlackEpisode({
    userId: episode.userId,
    channelType: episode.channelType,
    mentionsUser: episode.mentionsUser,
    messages,
  });
  const first = messages[0];
  const notified =
    verdict.tier === "PUSH" && first
      ? await notifySlackPush({
          userId: episode.userId,
          episodeId: episode.id,
          kind: slackConversationKind(episode.channelType, episode.mentionsUser),
          preview: first.text,
          reason: verdict.reason,
          link: slackPermalink(
            episode.connection.workspaceUrl,
            episode.channelId,
            first.ts,
            first.threadTs,
          ),
          now,
        })
      : null;
  await prisma.slackEpisode.update({
    where: { id: episode.id },
    data: {
      status: "JUDGED",
      tier: verdict.tier,
      reason: verdict.reason,
      judgedAt: now,
      ...(notified ? { notifiedAt: now } : {}),
    },
  });
  if (verdict.tier !== "SILENT") {
    await extractSlackCommitments({
      userId: episode.userId,
      channel: episode.channelId,
      firstTs: episode.firstTs,
      threadKey: episode.threadKey,
      text: slackEpisodeText(messages),
      referenceDate: now,
    });
  }
}

/** A failed judgment lands in QUEUE (the default lane) rather than retrying forever. */
async function judgeOrQueue(episode: ReadyEpisode, now: Date): Promise<void> {
  try {
    await judgeOne(episode, now);
  } catch (err) {
    console.error(`${LOG_PREFIX} judging an episode failed:`, err instanceof Error ? err.name : err);
    captureError(err, { tags: { scope: "slack.judge" } });
    await prisma.slackEpisode.update({
      where: { id: episode.id },
      data: { status: "JUDGED", tier: "QUEUE", reason: "Could not be judged", judgedAt: now },
    });
  }
}

/** One judge pass; returns how many episodes this pass claimed. */
export async function judgeReadySlackEpisodes(now: Date = new Date()): Promise<number> {
  if (isBackgroundAgentsDisabled()) return 0;
  const reach = cohortRestriction(SLACK_FLAGS);
  if (reach.kind === "none") return 0;
  const userIds = reach.kind === "only" ? reach.userIds : null;
  if (userIds && userIds.length === 0) return 0;
  const ready: ReadyEpisode[] = await prisma.slackEpisode.findMany({
    where: readyWhere(now, userIds),
    orderBy: { lastMessageAt: "asc" },
    take: SLACK_JUDGE_BATCH,
    select: READY_SELECT,
  });
  let claimed = 0;
  for (const episode of ready) {
    if (!(await claim(episode.id, now))) continue;
    claimed += 1;
    await judgeOrQueue(episode, now);
  }
  return claimed;
}
