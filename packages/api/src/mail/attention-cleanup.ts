/**
 * Resolve the EMAIL attention items mirroring the given EmailMessage ids. Called
 * when those emails leave the INBOX (archived/trashed in Gmail, or a mailbox
 * renumbered by its IMAP server and its rows retired) so a handled email also
 * leaves the attention queue — otherwise the AttentionItem is orphaned OPEN and the
 * priority amplifier keeps surfacing it (the stale-PUSH accumulation bug). Only
 * OPEN/SNOOZED are touched, so a terminal user decision (already
 * RESOLVED/DISMISSED) is preserved. Chunked for the bind-param cap.
 */

import { prisma } from "../db.js";

/** Bind-parameter chunk: well under Postgres' 65535 ceiling. */
const ATTENTION_PARAM_CAP = 10000;

export async function resolveAttentionForDeletedEmails(
  userId: string,
  emailIds: string[],
): Promise<void> {
  for (let i = 0; i < emailIds.length; i += ATTENTION_PARAM_CAP) {
    await prisma.attentionItem.updateMany({
      where: {
        userId,
        source: "EMAIL",
        sourceId: { in: emailIds.slice(i, i + ATTENTION_PARAM_CAP) },
        status: { in: ["OPEN", "SNOOZED"] },
      },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
  }
}
