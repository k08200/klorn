/**
 * Manual tier override — shared by the firewall API and the Telegram
 * webhook's inline buttons so the ground-truth convention can't fork.
 *
 * Override stamps tierReason as 'Manual override — user moved to X' so the
 * row is identifiable as a human-labelled ground-truth example for poc-judge
 * (Day 7 bar = 80% agreement between auto-tier and user-override-tier).
 */

import { prisma } from "./db.js";
import type { AttentionSourceName } from "./decision-label.js";
import { manualOverrideReason, type Tier } from "./tiers.js";

export type AttentionOverrideResult = { ok: true; tier: Tier } | { ok: false; reason: "not_found" };

/** Apply a manual tier override to an attention item the user owns. */
export async function overrideAttentionTier(
  userId: string,
  itemId: string,
  tier: Tier,
): Promise<AttentionOverrideResult> {
  // Ownership check before mutating
  const existing = await (
    prisma.attentionItem as unknown as {
      findFirst: (
        args: unknown,
      ) => Promise<{ id: string; source: string; sourceId: string } | null>;
    }
  ).findFirst({
    where: { id: itemId, userId },
    select: { id: true, source: true, sourceId: true },
  });

  if (!existing) return { ok: false, reason: "not_found" };

  // Atomic: the visible tier write and the ground-truth ledger stamp land in ONE
  // transaction. Previously they were two separate awaits — a crash or DB blip
  // between them left AttentionItem.tier corrected but DecisionLabel.outcome
  // null, silently dropping the override from every recall/over-suppression/
  // proposal metric. That undercount grows with volume and skews all downstream
  // numbers optimistically. Now either both land or neither does; a non-EMAIL
  // source simply matches 0 ledger rows (not an error) and commits cleanly. A
  // stamp failure now rolls back the tier write and surfaces (caller retries)
  // rather than being swallowed into a silent ledger loss.
  await prisma.$transaction(async (tx) => {
    await (tx.attentionItem as unknown as { update: (args: unknown) => Promise<unknown> }).update({
      where: { id: itemId },
      // manualOverrideReason keeps the MANUAL_OVERRIDE_PREFIX marker that
      // judge-context.ts mines from ever drifting.
      data: { tier, tierReason: manualOverrideReason(tier) },
    });

    await tx.decisionLabel.updateMany({
      // userId scopes the stamp to the acting user's own row; outcome:null makes
      // the first action win (only an unstamped row is touched).
      where: {
        userId,
        source: existing.source as AttentionSourceName,
        sourceId: existing.sourceId,
        outcome: null,
      },
      data: { outcome: `OVERRIDE:${tier}`, outcomeAt: new Date() },
    });
  });

  return { ok: true, tier };
}

/**
 * Best-effort lookup of the OPEN EMAIL-source AttentionItem for an
 * EmailMessage row (sourceId is the EmailMessage.id, set by poc-judge).
 * Used to attach tier-override buttons to outbound Telegram interrupts;
 * returns null on any failure so callers never gain a new failure mode.
 */
export async function findOpenEmailAttentionItemId(
  userId: string,
  emailDbId: string,
): Promise<string | null> {
  try {
    const row = await (
      prisma.attentionItem as unknown as {
        findFirst: (args: unknown) => Promise<{ id: string } | null>;
      }
    ).findFirst({
      where: { userId, source: "EMAIL", sourceId: emailDbId, status: "OPEN" },
      select: { id: true },
    });
    return row?.id ?? null;
  } catch (err) {
    // Don't swallow silently — a DB error here breaks override dedup, and
    // captureError is invisible without a Sentry DSN.
    console.warn(
      "[attention-override] findOpenEmailAttentionItemId failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
