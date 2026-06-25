/**
 * Manual tier override — shared by the firewall API and the Telegram
 * webhook's inline buttons so the ground-truth convention can't fork.
 *
 * Override stamps tierReason as 'Manual override — user moved to X' so the
 * row is identifiable as a human-labelled ground-truth example for poc-judge
 * (Day 7 bar = 80% agreement between auto-tier and user-override-tier).
 */

import { prisma } from "./db.js";
import { stampDecisionOutcome } from "./decision-label.js";
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

  await (
    prisma.attentionItem as unknown as {
      update: (args: unknown) => Promise<unknown>;
    }
  ).update({
    where: { id: itemId },
    data: {
      tier,
      // Built via the tiers.ts helper so the ground-truth marker that
      // judge-context.ts mines (MANUAL_OVERRIDE_PREFIX) can never drift.
      tierReason: manualOverrideReason(tier),
    },
  });

  // Stamp the decision ledger with the user's correction before the in-place
  // tier overwrite above erases the shown tier from AttentionItem. Best-effort;
  // only EMAIL-source decisions have a ledger row today (no-op otherwise).
  await stampDecisionOutcome(
    userId,
    existing.source as "EMAIL",
    existing.sourceId,
    `OVERRIDE:${tier}`,
  );

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
  } catch {
    return null;
  }
}
