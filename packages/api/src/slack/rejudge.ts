/**
 * Re-judging Slack episodes the keyword fallback judged (docs/providers/slack.md
 * §8). When no model answers (provider outage, the user's daily cost cap, an
 * unusable key), judgeEmail falls back to keywords and the episode would keep
 * that verdict for good. Each Slack tick, after the judge pass, this pass takes
 * up to SLACK_REJUDGE_BATCH such episodes (newest first) and judges them again
 * with the same judge, under the same rules as the first judgment:
 *
 * - its verdict is replaced at most once: the claim (rejudgedAt) is taken
 *   before the call and kept. It is released only when the call fell back to
 *   keywords again (no model yet) and fewer than SLACK_REJUDGE_MAX_ATTEMPTS
 *   calls were made; that user is then left alone for SLACK_REJUDGE_RETRY_MS.
 *   So an outage costs one call per user per interval, and an episode whose
 *   text keeps breaking the model's answer is given up after three. Any other
 *   failure spends the attempt;
 * - only while the text is kept (SLACK_MESSAGE_RETENTION_DAYS after the
 *   episode started), never after the user replied in the conversation;
 * - only while the connection is under its daily caps (judge-sweep.ts
 *   overDailyCap), checked before the claim: a full day leaves the episode for
 *   later and that user waits, nothing is spent. The episode keeps its
 *   judgedAt, so a backlog re-judged after midnight never takes the new day's
 *   slots from fresh episodes;
 * - stand down with SLACK_ENABLED, the cohort and BACKGROUND_AGENTS_DISABLED.
 *
 * An upgrade to PUSH (the fallback said anything else) is a correction of a
 * lane already shown, so it alerts by age, measured from the last message:
 * up to SLACK_REJUDGE_RING_FRESH_MS it rings like a first judgment (interrupt
 * budget, Slack ring and bell caps, quiet hours, a reply re-read first); up
 * to SLACK_REJUDGE_BELL_MAX_AGE_MS (the 72 h of Today's "Needs you now")
 * it writes a bell row only; older, nothing — the lane is corrected silently,
 * as the mail fallback re-judge does (judge/fallback-rejudge.ts).
 */

import { prisma } from "../db.js";
import { captureDbFailure, logDbFailure } from "../report-db-failure.js";
import { judgeSlackEpisode, SLACK_FALLBACK_SOURCE, type SlackVerdict } from "./judge-episode.js";
import {
  alertSlackEpisode,
  commitmentsIfDirect,
  type FirstMessage,
  overDailyCap,
  READY_SELECT,
  type ReadyEpisode,
  slackJudgeReach,
} from "./judge-sweep.js";
import { SLACK_MESSAGE_RETENTION_DAYS } from "./purge.js";

/** Fallback episodes re-judged per 30 s tick, after the judge pass. */
export const SLACK_REJUDGE_BATCH = 3;
/**
 * An upgrade to PUSH on talk at most this old still rings. A provider blip of
 * minutes leaves a live conversation where a ring helps; after half an hour
 * the people in it have moved on or written again — and a new message opens a
 * new episode that the judge rings on its own merits.
 */
export const SLACK_REJUDGE_RING_FRESH_MS = 30 * 60_000;
/** Older upgrades get a bell row up to Today's 72 h PUSH window, then nothing. */
export const SLACK_REJUDGE_BELL_MAX_AGE_MS = 72 * 3_600_000;
/** After a re-judge fell back again (or the day was full), that user waits this long. */
export const SLACK_REJUDGE_RETRY_MS = 10 * 60_000;
/** Re-judge calls one episode may take; the third fallback in a row is final. */
export const SLACK_REJUDGE_MAX_ATTEMPTS = 3;
const DAY_MS = 86_400_000;

type FallbackEpisode = ReadyEpisode & { tier: string | null };
/** degraded: no model yet; full: the connection's day is full. Both make the user wait. */
type Outcome = "rejudged" | "degraded" | "full" | "spent";

/** userId → when its episodes may be tried again (per process; a restart retries once). */
const retryAt = new Map<string, number>();

/** Test seam: forget every user's retry time. */
export function resetSlackRejudgeState(): void {
  retryAt.clear();
}

function waitingUsers(nowMs: number): string[] {
  for (const [userId, at] of retryAt) if (at <= nowMs) retryAt.delete(userId);
  return [...retryAt.keys()];
}

function userFilter(reach: string[] | null, waiting: string[]) {
  if (!reach && waiting.length === 0) return {};
  return {
    userId: { ...(reach ? { in: reach } : {}), ...(waiting.length ? { notIn: waiting } : {}) },
  };
}

async function claim(episodeId: string, now: Date): Promise<boolean> {
  const { count } = await prisma.slackEpisode.updateMany({
    where: {
      id: episodeId,
      status: "JUDGED",
      verdictSource: SLACK_FALLBACK_SOURCE,
      rejudgedAt: null,
      answeredAt: null,
    },
    data: { rejudgedAt: now, rejudgeAttempts: { increment: 1 } },
  });
  return count === 1;
}

/** The model is still out of reach: hand the attempt back, unless it was the last. */
async function release(episodeId: string, now: Date): Promise<void> {
  await prisma.slackEpisode.updateMany({
    where: { id: episodeId, rejudgedAt: now, rejudgeAttempts: { lt: SLACK_REJUDGE_MAX_ATTEMPTS } },
    data: { rejudgedAt: null },
  });
}

async function alertUpgrade(
  episode: FallbackEpisode,
  verdict: SlackVerdict,
  first: FirstMessage,
  now: Date,
): Promise<void> {
  if (verdict.tier !== "PUSH" || episode.tier === "PUSH") return;
  const age = now.getTime() - episode.lastMessageAt.getTime();
  if (age > SLACK_REJUDGE_BELL_MAX_AGE_MS) return;
  await alertSlackEpisode(episode, verdict, first, { ring: age <= SLACK_REJUDGE_RING_FRESH_MS });
}

async function rejudgeClaimed(episode: FallbackEpisode, now: Date): Promise<Outcome> {
  const messages = await prisma.slackMessage.findMany({
    where: { episodeId: episode.id },
    orderBy: { ts: "asc" },
    select: { text: true, ts: true, threadTs: true },
  });
  const first = messages[0];
  if (!first) return "spent";
  const verdict = await judgeSlackEpisode({
    userId: episode.userId,
    channelType: episode.channelType,
    mentionsUser: episode.mentionsUser,
    messages,
  });
  if (!verdict) return "spent";
  if (verdict.source === SLACK_FALLBACK_SOURCE) {
    await release(episode.id, now);
    return "degraded";
  }
  const { count } = await prisma.slackEpisode.updateMany({
    where: { id: episode.id, status: "JUDGED", rejudgedAt: now },
    data: { tier: verdict.tier, reason: verdict.reason, verdictSource: "llm" },
  });
  if (count !== 1) return "spent";
  await alertUpgrade(episode, verdict, first, now);
  // A SILENT fallback skipped the commitment pass; any other lane already ran it.
  if (episode.tier === "SILENT") {
    await commitmentsIfDirect(episode, verdict.tier, messages, now);
  }
  return "rejudged";
}

async function rejudgeOne(episode: FallbackEpisode, now: Date): Promise<Outcome> {
  try {
    if (await overDailyCap(episode, now)) return "full";
    if (!(await claim(episode.id, now))) return "spent";
    return await rejudgeClaimed(episode, now);
  } catch (err) {
    logDbFailure("[SLACK] re-judging an episode failed", err, {
      level: "error",
      ids: { episodeId: episode.id },
    });
    captureDbFailure("[SLACK] re-judging an episode failed", err, {
      tags: { scope: "slack.rejudge" },
      extra: { episodeId: episode.id },
    });
    return "spent";
  }
}

/** One re-judge pass; returns how many verdicts it replaced. */
export async function rejudgeFallbackSlackEpisodes(now: Date = new Date()): Promise<number> {
  const reach = slackJudgeReach();
  if (reach === "none") return 0;
  const episodes: FallbackEpisode[] = await prisma.slackEpisode.findMany({
    where: {
      ...userFilter(reach, waitingUsers(now.getTime())),
      status: "JUDGED",
      verdictSource: SLACK_FALLBACK_SOURCE,
      rejudgedAt: null,
      answeredAt: null,
      startedAt: { gt: new Date(now.getTime() - SLACK_MESSAGE_RETENTION_DAYS * DAY_MS) },
    },
    orderBy: { lastMessageAt: "desc" },
    take: SLACK_REJUDGE_BATCH,
    select: { ...READY_SELECT, tier: true },
  });
  let rejudged = 0;
  for (const episode of episodes) {
    // A call that fell back earlier in this pass: that user's model is still out.
    if (retryAt.has(episode.userId)) continue;
    const outcome = await rejudgeOne(episode, now);
    if (outcome === "rejudged") rejudged += 1;
    if (outcome === "degraded" || outcome === "full") {
      retryAt.set(episode.userId, now.getTime() + SLACK_REJUDGE_RETRY_MS);
    }
  }
  return rejudged;
}
