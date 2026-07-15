/**
 * Learned per-contact engagement — the importance-graph edge weights.
 *
 * Counters are incremented at action time (emailing/replying a contact = engaged;
 * dismissing their items = negative) and read O(1) at judge time — never computed
 * on the fly (same doctrine as ContactTrustScore). Best-effort: engagement is
 * observability, not control flow, so a write failure must never break the action
 * that triggered it.
 */

import { prisma } from "../db.js";
import { extractEmailAddress } from "../mail/email-address.js";

export type Engagement = "outbound" | "dismiss";

/** Record one engagement signal for a contact (upsert + increment). */
export async function recordContactEngagement(
  userId: string,
  rawEmail: string,
  kind: Engagement,
): Promise<void> {
  const contactEmail = extractEmailAddress(rawEmail);
  if (!contactEmail) return;
  try {
    await prisma.contactEngagementScore.upsert({
      where: { userId_contactEmail: { userId, contactEmail } },
      create: {
        userId,
        contactEmail,
        outboundCount: kind === "outbound" ? 1 : 0,
        dismissCount: kind === "dismiss" ? 1 : 0,
        lastEngagedAt: new Date(),
      },
      update: {
        ...(kind === "outbound"
          ? { outboundCount: { increment: 1 } }
          : { dismissCount: { increment: 1 } }),
        lastEngagedAt: new Date(),
      },
    });
  } catch (err) {
    console.warn(
      "[contact-engagement] record failed",
      kind,
      err instanceof Error ? err.message : String(err),
    );
  }
}
