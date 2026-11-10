/**
 * Firewall thread collapse (P0-C).
 *
 * Klorn stores one EmailMessage per Gmail *message* (dedup is
 * @@unique([userId, gmailId])), so a multi-message conversation — an original
 * request plus its reply, a Vercel "Deployment failed" retry, an HN reply chain
 * — becomes N EmailMessage rows = N AttentionItems, each judged independently.
 * The firewall list would then render the same conversation N times, each copy
 * carrying a different judge-authored tierReason.
 *
 * This collapses EMAIL-source rows that share a Gmail threadId down to their
 * first occurrence. Callers pass rows pre-ordered [priority desc, surfacedAt
 * desc], so "first" is the thread's highest-priority (tie-broken by newest)
 * message — the right card to surface for the whole conversation.
 *
 * Only EMAIL rows with a real threadId collapse: a null/absent threadId never
 * merges (legacy rows, or sources that don't thread), and non-EMAIL sources are
 * passed through untouched even if their key happens to collide.
 */
export function collapseEmailThreads<T extends { source: string }>(
  rows: T[],
  threadIdOf: (row: T) => string | null | undefined,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (row.source === "EMAIL") {
      const threadId = threadIdOf(row);
      if (threadId) {
        if (seen.has(threadId)) continue;
        seen.add(threadId);
      }
    }
    out.push(row);
  }
  return out;
}

/**
 * A mail's thread key, the same definition as `GET /api/email?threads=1`
 * (email-lanes.ts THREAD_KEY): a provider thread id is unique only inside one
 * mailbox, so the account is part of the key. No thread id → null: the mail is
 * its own thread (never merged, count 1).
 */
export function emailThreadKey(
  email: { threadId?: string | null; linkedInboxAccountId?: string | null } | undefined,
): string | null {
  if (!email?.threadId) return null;
  return `${email.linkedInboxAccountId ?? ""}:${email.threadId}`;
}

/**
 * How many EMAIL rows each thread key holds, over the same rows passed to
 * collapseEmailThreads — the collapsed card's `threadCount`. Pure, one pass,
 * no I/O. Rows without a key are not counted (their count is 1).
 */
export function countEmailThreads<T extends { source: string }>(
  rows: T[],
  threadIdOf: (row: T) => string | null | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.source !== "EMAIL") continue;
    const key = threadIdOf(row);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
