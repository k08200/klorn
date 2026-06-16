/**
 * Push delivery for GitHub notifications the firewall judge tiered PUSH.
 *
 * The email path (email-sync.ts pushForFirewallEmail) already does this, but
 * GitHub notifications were only mirrored to an AttentionItem — a judge=PUSH
 * GitHub thread showed up in the firewall yet never actually interrupted the
 * user. This closes that gap with the same recency guard + dedup + gated send
 * the email path uses. sendPushNotification applies the quiet-hours / rate-limit
 * / Telegram gates, so we don't re-check them here.
 */

import type { GitHubNotificationLike } from "./attention-mirror.js";
import { prisma } from "./db.js";

const GITHUB_PUSH_RECENCY_MS = 6 * 60 * 60 * 1000;
const GITHUB_PUSH_DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const GITHUB_PUSH_TITLE = "GitHub";

/**
 * Only interrupt for recent activity. The poller re-fetches the notification
 * list each cycle, so an old thread can resurface; tiering it in the firewall
 * is fine, firing a stale "urgent" push for it is not. (Mirrors the email
 * path's FIREWALL_PUSH_RECENCY_MS guard.)
 */
export function isGitHubNotificationPushable(updatedAt: Date, now = Date.now()): boolean {
  return now - updatedAt.getTime() <= GITHUB_PUSH_RECENCY_MS;
}

export async function pushForFirewallGitHubNotification(n: GitHubNotificationLike): Promise<void> {
  if (!isGitHubNotificationPushable(n.updatedAt)) return;

  // Dedup on the GitHub thread id embedded in the bell row, so re-ingesting the
  // same notification next poll doesn't re-push it.
  const marker = `[gh:${n.id}]`;
  const already = await prisma.notification.findFirst({
    where: {
      userId: n.userId,
      type: "github",
      title: GITHUB_PUSH_TITLE,
      message: { contains: marker },
      createdAt: { gte: new Date(Date.now() - GITHUB_PUSH_DEDUP_WINDOW_MS) },
    },
    select: { id: true },
  });
  if (already) return;

  const body = `${n.repo}: ${n.subjectTitle}`.slice(0, 200);
  const notification = await prisma.notification.create({
    data: {
      userId: n.userId,
      type: "github",
      title: GITHUB_PUSH_TITLE,
      message: `${body} ${marker}`,
    },
  });

  const [{ pushNotification }, { sendPushNotification }] = await Promise.all([
    import("./websocket.js"),
    import("./push.js"),
  ]);

  pushNotification(n.userId, {
    id: notification.id,
    type: "github",
    title: GITHUB_PUSH_TITLE,
    message: body,
    createdAt: notification.createdAt.toISOString(),
  });

  // category "system": not category-filterable (no GitHub-specific pref), but
  // still respects quiet hours and the rate limit.
  await sendPushNotification(
    n.userId,
    { title: `GitHub — ${n.repo}`, body: n.subjectTitle, url: "/inbox/firewall" },
    "system",
  );
}
