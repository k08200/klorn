/**
 * Attention aging sweep — closes the root cause behind the frozen firewall
 * board (#1044): EMAIL AttentionItems were never auto-resolved, so the OPEN
 * pool grew unbounded and any windowed read eventually drops live items.
 *
 * Policy, deliberately conservative:
 * - RESOLVE when the user already ACTED elsewhere: the underlying
 *   EmailMessage row is gone, or the mail left every folder Klorn reads it
 *   from (archived/trashed at the provider and reflected back by reconcile).
 *   Klorn reads INBOX, plus SPAM when the spam lane (SPAM_INTAKE_ENABLED) is
 *   on — a spam-lane row carries SPAM and never INBOX, and Klorn surfaced it
 *   on purpose, so it stays open while it is still in SPAM. Moving it out of
 *   SPAM to the trash, or deleting it, is the user's act. Known limitations:
 *   `labels` is the last-synced snapshot, not a live check — a transient
 *   out-of-INBOX state (e.g. Gmail native snooze) captured at the wrong
 *   moment resolves the item permanently (re-judge never re-OPENs by
 *   design); a spam the user deletes for good in Gmail (or Gmail's own
 *   30-day spam purge) never reaches the snapshot, so that item waits for
 *   its lane's age-out; and an INBOX mail the user reports as spam reads
 *   the same as spam-lane intake once the spam lane re-syncs its labels.
 * - Age out only the low-stakes lanes: SILENT after 14 days, QUEUE (and
 *   legacy null tier, which the board buckets as QUEUE) after 30 days.
 * - PUSH and AUTO never age: PUSH is precisely "needs the user", and AUTO
 *   is classification-only.
 *
 * Every resolution is stamped with its rule in `resolvedReason` (all share
 * AGING_REASON_PREFIX), so what the sweep resolved can be told apart from what
 * any other path resolved, and reopened (the rollback SQL is in the PR that
 * added the column): with the flag off, reopen RESOLVED rows carrying an
 * aging stamp whose mail row still exists and is still in INBOX or SPAM. A
 * stamped row whose mail is gone or left both stays resolved — reopening it
 * would leave an orphan OPEN item nothing ever resolves again.
 *
 * Gated by ATTENTION_AGING_ENABLED (OFF by default — what leaves the board
 * is a product decision; the flip is deliberate). Runs hourly from the
 * automation scheduler; each pass is bounded so a large backlog converges
 * over a few ticks instead of one giant query.
 */

import { attentionAgingEnabled } from "../config.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { NOT_AGENT_SET } from "./agent-tier.js";

export const SILENT_MAX_AGE_DAYS = 14;
export const QUEUE_MAX_AGE_DAYS = 30;
/** Rows per acted-path page, and pages per tick (one tick reads ≤ 5,000 items). */
export const ACTED_SCAN_PAGE = 500;
export const ACTED_SCAN_MAX_PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The prefix every aging stamp shares — the rollback key. */
export const AGING_REASON_PREFIX = "aging:";
/** `AttentionItem.resolvedReason` per rule. One prefix, so one query undoes all. */
export const AGING_RESOLVED_REASON = {
  /** The mail is gone, or left every folder Klorn reads it from. */
  ACTED: `${AGING_REASON_PREFIX}acted`,
  /** SILENT, surfaced more than SILENT_MAX_AGE_DAYS ago. */
  SILENT: `${AGING_REASON_PREFIX}silent`,
  /** QUEUE or legacy null tier, surfaced more than QUEUE_MAX_AGE_DAYS ago. */
  QUEUE: `${AGING_REASON_PREFIX}queue`,
} as const;

/** The folders Klorn reads mail from: INBOX, and SPAM for the spam lane. */
const READ_FOLDERS = ["INBOX", "SPAM"] as const;

export interface AttentionAgingResult {
  resolvedActed: number;
  resolvedAged: number;
}

/**
 * Where the acted-path scan resumes: the last item id one tick read. Process
 * memory on purpose — a restart only restarts the walk. Without it the scan
 * would re-read the same head every tick, and once a page of still-live items
 * (PUSH/MEETING/INFO never age, spam-lane items stay) filled it, no item past
 * it would ever be checked.
 */
let actedScanCursor: string | undefined;

/** Test seam: start the next acted-path walk from the first item. */
export function _resetActedScanCursorForTests(): void {
  actedScanCursor = undefined;
}

/** The user acted elsewhere: the row is gone, or the mail left every folder Klorn reads. */
function actedElsewhere(labels: string[] | undefined): boolean {
  if (!labels) return true;
  return !READ_FOLDERS.some((folder) => labels.includes(folder));
}

/** One acted-path page. Returns how many it resolved and the last id it read. */
async function resolveActedPage(
  now: Date,
  after: string | undefined,
): Promise<{ resolved: number; lastId: string | undefined; full: boolean }> {
  const items = await prisma.attentionItem.findMany({
    where: { status: "OPEN", source: "EMAIL", ...(after ? { id: { gt: after } } : {}) },
    select: { id: true, userId: true, sourceId: true },
    orderBy: { id: "asc" },
    take: ACTED_SCAN_PAGE,
  });
  if (items.length === 0) return { resolved: 0, lastId: undefined, full: false };

  const emails = await prisma.emailMessage.findMany({
    // userId scope carried even though EMAIL sourceIds are uuid PKs with no
    // cross-user collision — same "every sweep query is scoped" invariant
    // the reconcile path keeps on principle (email-sync.ts).
    where: {
      id: { in: items.map((i) => i.sourceId) },
      userId: { in: [...new Set(items.map((i) => i.userId))] },
    },
    select: { id: true, userId: true, labels: true },
  });
  // Keyed by (user, mail): an item reads only its own user's row, never another
  // user's row that happens to carry the id.
  const labelsOf = new Map(emails.map((e) => [`${e.userId}:${e.id}`, e.labels]));
  const actedIds = items
    .filter((item) => actedElsewhere(labelsOf.get(`${item.userId}:${item.sourceId}`)))
    .map((item) => item.id);

  let resolved = 0;
  if (actedIds.length > 0) {
    const { count } = await prisma.attentionItem.updateMany({
      where: { id: { in: actedIds }, status: "OPEN" },
      data: { status: "RESOLVED", resolvedAt: now, resolvedReason: AGING_RESOLVED_REASON.ACTED },
    });
    resolved = count;
  }
  return { resolved, lastId: items.at(-1)?.id, full: items.length === ACTED_SCAN_PAGE };
}

/**
 * Acted-elsewhere: walk OPEN EMAIL items in id order, a bounded number of
 * pages per tick, resuming where the last tick stopped. Reaching the end
 * restarts from the head: within the same tick when the tick began mid-way,
 * otherwise on the next tick. A failed page is reported and ends this tick's walk: the cursor
 * stays on the last good page so the next tick retries it, and the age-out
 * still runs. Returns how many it resolved before any failure.
 */
async function resolveActedElsewhere(now: Date): Promise<number> {
  let resolved = 0;
  // Only a tick that began mid-way has a head left to cover after the end.
  let canWrap = actedScanCursor !== undefined;
  try {
    for (let page = 0; page < ACTED_SCAN_MAX_PAGES; page++) {
      const result = await resolveActedPage(now, actedScanCursor);
      resolved += result.resolved;
      if (result.full) {
        actedScanCursor = result.lastId;
        continue;
      }
      actedScanCursor = undefined;
      if (!canWrap) break;
      canWrap = false;
    }
  } catch (err) {
    console.warn("[ATTENTION-AGING] acted-elsewhere scan failed:", err);
    captureError(err, { tags: { scope: "attention-aging.acted" } });
  }
  return resolved;
}

export async function sweepAttentionAging(now: Date = new Date()): Promise<AttentionAgingResult> {
  // The scheduler checks the flag too; checking here keeps every caller dark.
  if (!attentionAgingEnabled()) return { resolvedActed: 0, resolvedAged: 0 };

  const resolvedActed = await resolveActedElsewhere(now);

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
      data: { status: "RESOLVED", resolvedAt: now, resolvedReason: AGING_RESOLVED_REASON.SILENT },
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
      data: { status: "RESOLVED", resolvedAt: now, resolvedReason: AGING_RESOLVED_REASON.QUEUE },
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
    data: { status: "RESOLVED", resolvedAt: now, resolvedReason: AGING_RESOLVED_REASON.QUEUE },
  });

  return { resolvedActed, resolvedAged: silent.count + queue.count + nullTier.count };
}
