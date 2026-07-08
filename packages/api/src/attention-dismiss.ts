/**
 * Dismiss an attention item the user owns — clear it from the firewall queue
 * (status DISMISSED) without touching the underlying source (the email stays in
 * Gmail; this is an attention action, not inbox management). Works for ANY
 * source. Mirrors the ownership-checked mutation shape of attention-override.ts.
 */

import { prisma } from "./db.js";

export type AttentionDismissResult = { ok: true } | { ok: false; reason: "not_found" };

/** Mark an attention item the user owns as DISMISSED (removed from the queue). */
export async function dismissAttentionItem(
  userId: string,
  itemId: string,
): Promise<AttentionDismissResult> {
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
      data: { status: "DISMISSED", resolvedAt: new Date() },
    },
  );

  return { ok: true };
}
