/**
 * Rejection hint — feeds reject-with-feedback reasons back into agent prompts.
 *
 * Counterpart to buildTrustHintForPrompt (trust-score.ts): a compact,
 * capped text snippet injected into the autonomous agent's system prompt.
 * Rejections used to be a dead end — the user said "no" and the "why" was
 * thrown away. Since migration 20260612000000 the reject endpoint persists
 * PendingAction.rejectionReason, and this module surfaces the most recent
 * ones so the agent stops proposing the same mistake.
 *
 * Hints are observability for the LLM, not control flow — every failure
 * path returns "" so a broken query can never break an agent run.
 */

import { prisma } from "../db.js";

/** How many recent rejection reasons to inject (newest first). */
export const REJECTION_HINT_LIMIT = 5;

/** Per-reason cap so one long rant can't blow up the prompt budget. */
const REASON_SNIPPET_MAX = 200;

function truncateReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length <= REASON_SNIPPET_MAX) return trimmed;
  return `${trimmed.slice(0, REASON_SNIPPET_MAX)}…`;
}

/**
 * Returns a compact prompt snippet listing the user's most recent rejection
 * reasons, or "" when there is nothing to say.
 */
export async function buildRejectionHintForPrompt(userId: string): Promise<string> {
  try {
    const rows = await prisma.pendingAction.findMany({
      where: { userId, status: "REJECTED", rejectionReason: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: REJECTION_HINT_LIMIT,
      select: { toolName: true, rejectionReason: true },
    });

    const lines = rows
      .filter((row) => row.rejectionReason && row.rejectionReason.trim().length > 0)
      .map((row) => `- ${row.toolName}: "${truncateReason(row.rejectionReason as string)}"`);
    if (lines.length === 0) return "";

    return (
      "\n## Recent Rejections\n" +
      "The user rejected these proposed actions recently — avoid repeating these mistakes:\n" +
      lines.join("\n")
    );
  } catch {
    return "";
  }
}
