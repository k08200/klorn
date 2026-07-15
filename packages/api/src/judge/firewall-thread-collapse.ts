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
