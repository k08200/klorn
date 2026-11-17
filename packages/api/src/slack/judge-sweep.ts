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
 * connection a day reach the judge, of which followed-channel chatter may use
 * SLACK_OPT_IN_EPISODES_PER_DAY (DMs and mentions keep the rest); past it an
 * episode is closed OVER_CAP without an LLM call.
 *
 * Order per episode: the verdict is stored first (guarded on the claim, so a
 * disconnect mid-judge writes nothing), then the ring and the commitments run
 * best-effort — a failure in either never rewrites the verdict, and a retaken
 * claim can never ring twice. Episodes older than SLACK_RING_RECENCY_MS (after
 * an outage or the brake) are judged but do not ring. A reply the user sent
 * while the judge call was in flight (episodes.ts stamps answeredAt on the
 * claimed episode) keeps the verdict but stops the ring: it is re-read right
 * before ringing.
 *
 * The verdict's source is stored with it; a keyword-fallback verdict (no
 * model answered) is re-judged once later by rejudge.ts.
 */

import { cohortRestriction, SLACK_FLAGS } from "../config.js";
import { prisma } from "../db.js";
import { captureDbFailure, logDbFailure } from "../report-db-failure.js";
import { isBackgroundAgentsDisabled } from "../scheduler-heartbeat.js";
import { extractSlackCommitments } from "./commitments.js";
import { EPISODE_MAX_MESSAGES, EPISODE_MAX_WAIT_MS, EPISODE_QUIET_MS } from "./episodes.js";
import {
  judgeSlackEpisode,
  type SlackVerdict,
  slackConversationKind,
  slackEpisodeText,
} from "./judge-episode.js";
import { notifySlackPush } from "./notify.js";
import { slackPermalink } from "./permalink.js";

/** Episodes judged per tick; the rest wait for the next 30 s tick. */
export const SLACK_JUDGE_BATCH = 10;
/** Episodes per connection per UTC day that reach the LLM judge. */
export const SLACK_JUDGED_EPISODES_PER_DAY = 200;
/** Of those, how many followed-channel (opt-in) episodes may use. */
export const SLACK_OPT_IN_EPISODES_PER_DAY = 120;
/** A PUSH verdict on talk older than this does not ring (mail uses the same 6 h). */
export const SLACK_RING_RECENCY_MS = 6 * 3_600_000;
/** A JUDGING claim older than this belongs to a crashed tick and is retried. */
export const SLACK_CLAIM_TIMEOUT_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

export type ReadyEpisode = {
  id: string;
  userId: string;
  connectionId: string;
  channelId: string;
  channelType: string;
  threadKey: string;
  mentionsUser: boolean;
  firstTs: string;
  lastMessageAt: Date;
  connection: { workspaceUrl: string | null };
};

export const READY_SELECT = {
  id: true,
  userId: true,
  connectionId: true,
  channelId: true,
  channelType: true,
  threadKey: true,
  mentionsUser: true,
  firstTs: true,
  lastMessageAt: true,
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

const OPT_IN_WHERE = { channelType: { in: ["channel", "group"] }, mentionsUser: false };

export async function overDailyCap(episode: ReadyEpisode, now: Date): Promise<boolean> {
  const dayStart = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  const judgedToday = {
    connectionId: episode.connectionId,
    status: "JUDGED",
    judgedAt: { gte: dayStart },
  };
  const total = await prisma.slackEpisode.count({ where: judgedToday });
  if (total >= SLACK_JUDGED_EPISODES_PER_DAY) return true;
  if (slackConversationKind(episode.channelType, episode.mentionsUser) !== "opt_in") return false;
  const optIn = await prisma.slackEpisode.count({ where: { ...judgedToday, ...OPT_IN_WHERE } });
  return optIn >= SLACK_OPT_IN_EPISODES_PER_DAY;
}

/** Writes an outcome only while this tick still holds the claim; false if it lost it. */
async function settle(episodeId: string, data: Record<string, unknown>): Promise<boolean> {
  const { count } = await prisma.slackEpisode.updateMany({
    where: { id: episodeId, status: "JUDGING" },
    data,
  });
  return count === 1;
}

export type FirstMessage = { text: string; ts: string; threadTs: string | null };

/** Whether the user has not replied since the episode's last message. */
async function stillUnanswered(episodeId: string): Promise<boolean> {
  const row = await prisma.slackEpisode.findFirst({
    where: { id: episodeId, answeredAt: null },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Alerts the user about a PUSH episode: a ring under the interrupt budget, or
 * (ring: false) a bell row only. Nothing at all once the user replied: the
 * reply is re-read here, after the verdict and right before the alert, so one
 * that landed while the judge call was in flight still counts. Best-effort:
 * a failure is reported and never touches the stored verdict.
 */
export async function alertSlackEpisode(
  episode: ReadyEpisode,
  verdict: { reason: string },
  first: FirstMessage,
  options: { ring: boolean },
): Promise<void> {
  // Quiet hours, focus and the budget day are read at ring time, not tick start.
  const now = new Date();
  try {
    if (!(await stillUnanswered(episode.id))) return;
    const outcome = await notifySlackPush({
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
      ring: options.ring,
      now,
    });
    if (outcome === "admitted") {
      await prisma.slackEpisode.updateMany({
        where: { id: episode.id },
        data: { notifiedAt: now },
      });
    }
  } catch (err) {
    logDbFailure("[SLACK] ringing an episode failed", err, {
      level: "error",
      ids: { episodeId: episode.id },
    });
    captureDbFailure("[SLACK] ringing an episode failed", err, {
      tags: { scope: "slack.notify" },
      extra: { episodeId: episode.id },
    });
  }
}

async function ringIfPush(
  episode: ReadyEpisode,
  verdict: SlackVerdict,
  first: FirstMessage,
  tickNow: Date,
): Promise<void> {
  if (verdict.tier !== "PUSH") return;
  if (tickNow.getTime() - episode.lastMessageAt.getTime() > SLACK_RING_RECENCY_MS) return;
  await alertSlackEpisode(episode, verdict, first, { ring: true });
}

/** Followed-channel chatter between other people is not the user's ledger. */
export async function commitmentsIfDirect(
  episode: ReadyEpisode,
  tier: string,
  messages: ReadonlyArray<{ text: string }>,
  now: Date,
): Promise<void> {
  const kind = slackConversationKind(episode.channelType, episode.mentionsUser);
  if (tier === "SILENT" || kind === "opt_in") return;
  try {
    await extractSlackCommitments({
      userId: episode.userId,
      channel: episode.channelId,
      firstTs: episode.firstTs,
      threadKey: episode.threadKey,
      text: slackEpisodeText(messages),
      referenceDate: now,
    });
  } catch (err) {
    logDbFailure("[SLACK] commitments failed", err, {
      level: "error",
      ids: { episodeId: episode.id },
    });
    captureDbFailure("[SLACK] commitments failed", err, {
      tags: { scope: "slack.commitments" },
      extra: { episodeId: episode.id },
    });
  }
}

async function judgeOne(episode: ReadyEpisode, now: Date): Promise<void> {
  const messages = await prisma.slackMessage.findMany({
    where: { episodeId: episode.id },
    orderBy: { ts: "asc" },
    select: { text: true, ts: true, threadTs: true },
  });
  const first = messages[0];
  if (!first) return void (await settle(episode.id, { status: "EMPTY", judgedAt: now }));
  if (await overDailyCap(episode, now)) {
    return void (await settle(episode.id, { status: "OVER_CAP", judgedAt: now }));
  }
  const verdict = await judgeSlackEpisode({
    userId: episode.userId,
    channelType: episode.channelType,
    mentionsUser: episode.mentionsUser,
    messages,
  });
  if (!verdict) return void (await settle(episode.id, { status: "EMPTY", judgedAt: now }));
  const kept = await settle(episode.id, {
    status: "JUDGED",
    tier: verdict.tier,
    reason: verdict.reason,
    verdictSource: verdict.source,
    judgedAt: now,
  });
  if (!kept) return;
  await ringIfPush(episode, verdict, first, now);
  await commitmentsIfDirect(episode, verdict.tier, messages, now);
}

/** A failed judgment lands in QUEUE (the default lane) rather than retrying forever. */
async function judgeOrQueue(episode: ReadyEpisode, now: Date): Promise<void> {
  try {
    await judgeOne(episode, now);
  } catch (err) {
    logDbFailure("[SLACK] judging an episode failed", err, {
      level: "error",
      ids: { episodeId: episode.id },
    });
    captureDbFailure("[SLACK] judging an episode failed", err, {
      tags: { scope: "slack.judge" },
      extra: { episodeId: episode.id },
    });
    await settle(episode.id, {
      status: "JUDGED",
      tier: "QUEUE",
      reason: "Could not be judged",
      judgedAt: now,
    }).catch((settleErr) =>
      captureDbFailure("[SLACK] queueing an unjudged episode failed", settleErr, {
        tags: { scope: "slack.judge" },
        extra: { episodeId: episode.id },
      }),
    );
  }
}

/**
 * Whose episodes a judge pass may touch: null for everyone, else the cohort's
 * user ids. "none" while the flag is off, the cohort is empty, or the
 * background brake is on (no LLM calls).
 */
export function slackJudgeReach(): string[] | null | "none" {
  if (isBackgroundAgentsDisabled()) return "none";
  const reach = cohortRestriction(SLACK_FLAGS);
  if (reach.kind === "none") return "none";
  if (reach.kind === "all") return null;
  return reach.userIds.length === 0 ? "none" : reach.userIds;
}

/** One judge pass; returns how many episodes this pass claimed. */
export async function judgeReadySlackEpisodes(now: Date = new Date()): Promise<number> {
  const userIds = slackJudgeReach();
  if (userIds === "none") return 0;
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
