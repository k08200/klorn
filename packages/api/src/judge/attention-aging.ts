/**
 * Attention aging sweep — closes the root cause behind the frozen firewall
 * board (#1044): EMAIL AttentionItems were never auto-resolved, so the OPEN
 * pool grew unbounded and any windowed read eventually drops live items.
 *
 * Policy, deliberately conservative:
 * - RESOLVE when the user already ACTED elsewhere: the underlying
 *   EmailMessage row is gone, or it left the INBOX (archived/trashed at the
 *   provider and reflected back by reconcile). Known limitation: `labels`
 *   is the last-synced snapshot, not a live check — a transient
 *   out-of-INBOX state (e.g. Gmail native snooze) captured at the wrong
 *   moment resolves the item permanently (re-judge never re-OPENs by
 *   design). Accepted for the OFF-by-default flip; revisit with a
 *   freshness guard if it bites.
 * - Age out only the low-stakes lanes: SILENT after 14 days, QUEUE (and
 *   legacy null tier, which the board buckets as QUEUE) after 30 days.
 * - PUSH and AUTO never age: PUSH is precisely "needs the user", and AUTO
 *   is classification-only.
 *
 * Gated by ATTENTION_AGING_ENABLED (OFF by default — what leaves the board
 * is a product decision; the flip is deliberate). Runs hourly from the
 * automation scheduler; each pass is bounded so a large backlog converges
 * over a few ticks instead of one giant query.
 */

import { prisma } from "../db.js";
import { NOT_AGENT_SET } from "./agent-tier.js";

export const SILENT_MAX_AGE_DAYS = 14;
export const QUEUE_MAX_AGE_DAYS = 30;
const ACTED_SCAN_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AttentionAgingResult {
  resolvedActed: number;
  resolvedAged: number;
}

export async function sweepAttentionAging(now: Date = new Date()): Promise<AttentionAgingResult> {
  // ── Acted-elsewhere: EMAIL items whose email vanished or left the INBOX.
  const openEmailItems = await prisma.attentionItem.findMany({
    where: { status: "OPEN", source: "EMAIL" },
    select: { id: true, userId: true, sourceId: true },
    orderBy: { surfacedAt: "asc" },
    take: ACTED_SCAN_LIMIT,
  });

  let resolvedActed = 0;
  if (openEmailItems.length > 0) {
    const emails = await prisma.emailMessage.findMany({
      // userId scope carried even though EMAIL sourceIds are uuid PKs with no
      // cross-user collision — same "every sweep query is scoped" invariant
      // the reconcile path keeps on principle (email-sync.ts).
      where: {
        id: { in: openEmailItems.map((i) => i.sourceId) },
        userId: { in: [...new Set(openEmailItems.map((i) => i.userId))] },
      },
      select: { id: true, labels: true },
    });
    const labelsById = new Map(emails.map((e) => [e.id, e.labels]));
    const actedIds = openEmailItems
      .filter((item) => {
        const labels = labelsById.get(item.sourceId);
        // Row gone (locally deleted) or no longer in INBOX (archived/trashed
        // at the provider) — the decision was made outside the board.
        return !labels || !labels.includes("INBOX");
      })
      .map((item) => item.id);
    if (actedIds.length > 0) {
      const { count } = await prisma.attentionItem.updateMany({
        where: { id: { in: actedIds }, status: "OPEN" },
        data: { status: "RESOLVED", resolvedAt: now },
      });
      resolvedActed = count;
    }
  }

  // ── Age-out: low-stakes lanes only. Direct updateMany — no fetch needed.
  // An MCP agent's lane is exempt (NOT_AGENT_SET, step A2b): otherwise an injected
  // agent could demote an important old mail to SILENT and have this sweep resolve
  // it. Acted-elsewhere above is not aging — a mail the user archived stays resolved.
  const silentCutoff = new Date(now.getTime() - SILENT_MAX_AGE_DAYS * DAY_MS);
  const queueCutoff = new Date(now.getTime() - QUEUE_MAX_AGE_DAYS * DAY_MS);
  const [silent, queue] = await Promise.all([
    prisma.attentionItem.updateMany({
      where: {
        status: "OPEN",
        source: "EMAIL",
        tier: "SILENT",
        surfacedAt: { lt: silentCutoff },
        ...NOT_AGENT_SET,
      },
      data: { status: "RESOLVED", resolvedAt: now },
    }),
    prisma.attentionItem.updateMany({
      // Legacy null tier is bucketed as QUEUE by the board — age it the same.
      where: {
        status: "OPEN",
        source: "EMAIL",
        tier: { in: ["QUEUE"] },
        surfacedAt: { lt: queueCutoff },
        ...NOT_AGENT_SET,
      },
      data: { status: "RESOLVED", resolvedAt: now },
    }),
  ]);
  const nullTier = await prisma.attentionItem.updateMany({
    where: {
      status: "OPEN",
      source: "EMAIL",
      tier: null,
      surfacedAt: { lt: queueCutoff },
      ...NOT_AGENT_SET,
    },
    data: { status: "RESOLVED", resolvedAt: now },
  });

  return { resolvedActed, resolvedAged: silent.count + queue.count + nullTier.count };
}
