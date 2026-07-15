/**
 * Dismiss an attention item the user owns — clear it from the firewall queue
 * (status DISMISSED) without touching the underlying source (the email stays in
 * Gmail; this is an attention action, not inbox management). Works for ANY
 * source. Mirrors the ownership-checked mutation shape of attention-override.ts.
 */

import { prisma } from "./db.js";
import { extractEmailAddress } from "./email-address.js";
import { recordContactEngagement } from "./learning/contact-engagement.js";
import { recordFeedback } from "./learning/feedback.js";

export type AttentionDismissResult = { ok: true } | { ok: false; reason: "not_found" };

/** Mark an attention item the user owns as DISMISSED (removed from the queue). */
export async function dismissAttentionItem(
  userId: string,
  itemId: string,
): Promise<AttentionDismissResult> {
  // Ownership check before mutating — never mutate by bare id.
  const existing = await (
    prisma.attentionItem as unknown as {
      findFirst: (args: unknown) => Promise<{
        id: string;
        source: string;
        sourceId: string;
      } | null>;
    }
  ).findFirst({
    where: { id: itemId, userId },
    select: { id: true, source: true, sourceId: true },
  });

  if (!existing) return { ok: false, reason: "not_found" };

  await (prisma.attentionItem as unknown as { update: (args: unknown) => Promise<unknown> }).update(
    {
      where: { id: itemId },
      data: { status: "DISMISSED", resolvedAt: new Date() },
    },
  );

  // Learn from the action: a dismiss is a "not important" signal. This feeds the
  // (live) feedback adaptor, which forces SILENT on patterns the user keeps
  // dismissing. Best-effort — recordFeedback never throws (feedback is
  // observability, not control flow), so it can't break the dismiss.
  await recordFeedback({
    userId,
    source: "ATTENTION_ITEM",
    sourceId: itemId,
    signal: "DISMISSED",
    evidence: "User dismissed from the desktop app",
  });

  // Per-sender learning: dismissing an EMAIL is the negative half of the
  // contact-engagement graph — the "dismisses −" the outbound "+" was already
  // wired for in #768, but whose writer was never called (dismissCount sat at
  // 0). Records dismissCount for the sender so the judge can learn to distrust a
  // sender the user keeps clearing (consumed only when CONTACT_ENGAGEMENT_IN_JUDGE
  // is on). Best-effort; recordContactEngagement never throws.
  if (existing.source === "EMAIL") {
    const email = await prisma.emailMessage.findUnique({
      where: { id: existing.sourceId },
      select: { from: true },
    });
    if (email?.from) {
      await recordContactEngagement(userId, extractEmailAddress(email.from), "dismiss");
    }
  }

  return { ok: true };
}
