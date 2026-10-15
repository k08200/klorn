/**
 * Close the attention items of emails that have left the inbox (archived,
 * deleted, moved by a filter). RESOLVED is the system's own "no longer
 * relevant" — distinct from DISMISSED, which only a human sets. Only
 * OPEN/SNOOZED rows are touched, so a terminal user decision is preserved.
 *
 * Shared by the inbox sync (rows it still sees but that are no longer in the
 * inbox) and bulk archive (rows it deletes itself, which the sync can
 * therefore never notice). Chunked for the bind-param cap.
 */

import { prisma } from "../db.js";

const PARAM_CAP = 10_000;

export async function resolveAttentionForEmails(userId: string, emailIds: string[]): Promise<void> {
  for (let i = 0; i < emailIds.length; i += PARAM_CAP) {
    await prisma.attentionItem.updateMany({
      where: {
        userId,
        source: "EMAIL",
        sourceId: { in: emailIds.slice(i, i + PARAM_CAP) },
        status: { in: ["OPEN", "SNOOZED"] },
      },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
  }
}
