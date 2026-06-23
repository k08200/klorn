/**
 * GitHub as a second attention source.
 *
 * The attention firewall's thesis is "tier any interrupt source", but email
 * was the only one wired through the judge. This module makes a GitHub
 * notification thread a first-class firewall input by rendering it into the
 * judge's existing ClassifiableEmail shape — FAITHFUL TEXT, not a bespoke
 * scorer. The same 4-tier judge, the per-tier eval gate, and the weekly
 * calibration therefore apply to GitHub unchanged.
 *
 * Why map instead of building a GitHub-specific judge now: we have zero
 * GitHub tier data. Whether GitHub needs different feature scoring is a
 * question the override/calibration loop will answer with numbers — the
 * same discipline that took the email judge to 92%. Guessing a separate
 * scorer up front is the speculative-refactor trap. If the calibration
 * snapshot shows GitHub tiers are systematically wrong, THAT is when a
 * GitHub feature adapter earns its keep.
 *
 * Layers: pure mapping (githubNotificationToClassifiable) → batch ingest
 * (ingestGitHubNotifications, no network) → per-user poll (syncGitHubForUser,
 * loads the BYO token + drives github-client). The 5-minute scheduler that
 * calls syncGitHubForUser lives in github-scheduler.ts.
 */

import {
  type EmailJudgementLike,
  type GitHubNotificationLike,
  upsertAttentionForGitHubNotification,
} from "./attention-mirror.js";
import { decryptToken } from "./crypto-tokens.js";
import { prisma } from "./db.js";
import type { ClassifiableEmail } from "./email-classifier.js";
import { fetchGitHubNotifications } from "./github-client.js";
import { pushForFirewallGitHubNotification } from "./github-push.js";
import { judgeEmail } from "./poc-judge.js";
import { captureError } from "./sentry.js";

/** A GitHub notification thread, normalized from the Notifications API. */
export interface GitHubNotification {
  /** GitHub notification thread id — the firewall sourceId. */
  id: string;
  /** assign | mention | review_requested | ci_activity | subscribed | … */
  reason: string;
  /** owner/name */
  repo: string;
  subjectTitle: string;
  /** PullRequest | Issue | CheckSuite | Release | Discussion | … */
  subjectType: string;
  /** Resolved html url to open the thread, or null if unresolved. */
  url: string | null;
  updatedAt: Date;
}

/**
 * Natural-language phrasing for each notification reason, so the judge (LLM
 * or keyword fallback) reads the intent in words it already understands —
 * no GitHub-specific feature rules required.
 */
function reasonPhrase(reason: string, subjectType: string): string {
  const what = subjectType === "PullRequest" ? "pull request" : subjectType.toLowerCase();
  switch (reason) {
    case "review_requested":
      return `A review was requested from you on this ${what}.`;
    case "mention":
      return `You were mentioned on this ${what}.`;
    case "assign":
      return `This ${what} was assigned to you.`;
    case "team_mention":
      return `Your team was mentioned on this ${what}.`;
    case "ci_activity":
      return `A CI run finished on this ${what}.`;
    case "comment":
      return `There is a new comment on this ${what}.`;
    case "state_change":
      return `The state of this ${what} changed.`;
    default:
      return `Update on this ${what} (${reason}).`;
  }
}

/** Reasons that imply the recipient personally needs to act/respond. */
const ACTIONABLE_REASONS = new Set(["review_requested", "mention", "assign", "team_mention"]);

export function isActionableReason(reason: string): boolean {
  return ACTIONABLE_REASONS.has(reason);
}

/**
 * Render a GitHub notification into the judge's email shape. The synthetic
 * sender reads as an automated GitHub notification address (so the keyword
 * fallback floors it at QUEUE — never PUSH, never the marketing SILENT
 * branch); the reason phrasing carries the real attention signal. Gmail
 * labels are intentionally empty: a GitHub item must never hit the
 * CATEGORY_PROMOTIONS marketing fast-path.
 */
export function githubNotificationToClassifiable(n: GitHubNotification): ClassifiableEmail {
  return {
    id: n.id,
    from: `${n.repo} (GitHub) <notifications@github.com>`,
    subject: n.subjectTitle,
    snippet: `${n.subjectType} · ${reasonPhrase(n.reason, n.subjectType)}`,
    labels: [],
  };
}

/**
 * Judge + mirror a batch of already-fetched GitHub notifications. No
 * network — the caller (PR2 poller) supplies the notifications. Per-item
 * failures are isolated so one bad thread can't drop the batch. Returns the
 * count actually surfaced.
 */
export async function ingestGitHubNotifications(
  userId: string,
  notifications: GitHubNotification[],
): Promise<number> {
  let surfaced = 0;
  for (const n of notifications) {
    if (!n.subjectTitle?.trim()) continue;
    try {
      const judgement = await judgeEmail(githubNotificationToClassifiable(n), userId);
      const like: GitHubNotificationLike = {
        id: n.id,
        userId,
        repo: n.repo,
        subjectTitle: n.subjectTitle,
        subjectType: n.subjectType,
        reason: n.reason,
        url: n.url,
        updatedAt: n.updatedAt,
      };
      await upsertAttentionForGitHubNotification(like, judgement as EmailJudgementLike);
      // A judge=PUSH GitHub thread must actually interrupt — not just appear in
      // the firewall. Best-effort: a push failure never drops the mirror.
      if ((judgement as EmailJudgementLike).tier === "PUSH") {
        await pushForFirewallGitHubNotification(like).catch((err) => {
          // A failed PUSH means the user silently missed a judge-adjudicated
          // interrupt — signal both to the console and Sentry (captureError
          // alone is silent when Sentry is off).
          console.warn(`[GITHUB] push failed for thread ${n.id}:`, err);
          captureError(err, { tags: { scope: "github.push" }, extra: { threadId: n.id } });
        });
      }
      surfaced++;
    } catch (err) {
      console.warn(`[GITHUB] ingest failed for thread ${n.id}:`, err);
      // Sentry too: a dropped PUSH-tier thread is a missed interrupt, and a
      // systematic ingest regression must alert in prod (matches the push path).
      captureError(err, { tags: { scope: "github.ingest" }, extra: { threadId: n.id } });
    }
  }
  return surfaced;
}

export interface GitHubSyncResult {
  fetched: number;
  surfaced: number;
}

/**
 * Poll one user's GitHub notifications and surface them. Loads the
 * encrypted PAT, fetches since the stored cursor, ingests, then advances
 * the cursor to the run time. The cursor advances ONLY on a successful
 * fetch — a failed fetch throws (caller logs) and leaves the window intact
 * so the next tick retries it. Returns null when the user is disconnected.
 */
export async function syncGitHubForUser(
  userId: string,
  now: Date = new Date(),
): Promise<GitHubSyncResult | null> {
  const user = (await prisma.user.findUnique({
    where: { id: userId },
    select: { githubTokenCipher: true, githubLastPolledAt: true },
  })) as { githubTokenCipher: string | null; githubLastPolledAt: Date | null } | null;

  if (!user?.githubTokenCipher) return null;

  const token = decryptToken(user.githubTokenCipher);
  const notifications = await fetchGitHubNotifications(token, user.githubLastPolledAt ?? undefined);

  const surfaced =
    notifications.length > 0 ? await ingestGitHubNotifications(userId, notifications) : 0;

  await prisma.user.update({ where: { id: userId }, data: { githubLastPolledAt: now } });
  return { fetched: notifications.length, surfaced };
}
