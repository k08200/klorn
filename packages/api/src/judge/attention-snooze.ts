/**
 * Snooze an attention item the user owns — set it aside until a chosen time,
 * when the automation scheduler's source-agnostic resurrectSnoozedItems() flips
 * it back to OPEN. Works for ANY source (EMAIL included), unlike the
 * PENDING_ACTION-scoped snooze in chat-pending-actions.ts.
 */

import { prisma } from "../db.js";

export type AttentionSnoozeResult = { ok: true } | { ok: false; reason: "not_found" };

/** Snooze an attention item the user owns until `snoozeUntil` (a future date). */
export async function snoozeAttentionItem(
  userId: string,
  itemId: string,
  snoozeUntil: Date,
): Promise<AttentionSnoozeResult> {
  // Ownership check before mutating — never mutate by bare id.
  const existing = await (
    prisma.attentionItem as unknown as {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
    }
  ).findFirst({
    where: { id: itemId, userId },
    select: { id: true },
  });

  if (!existing) return { ok: false, reason: "not_found" };

  await (prisma.attentionItem as unknown as { update: (args: unknown) => Promise<unknown> }).update(
    {
      where: { id: itemId },
      // Clear lastAmplifiedAt so a resurfaced item doesn't inherit stale decay/
      // escalation state (mirrors the PENDING_ACTION snooze in chat-pending-actions.ts).
      data: { status: "SNOOZED", snoozedUntil: snoozeUntil, lastAmplifiedAt: null },
    },
  );

  return { ok: true };
}
