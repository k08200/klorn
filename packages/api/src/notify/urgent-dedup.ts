/**
 * Dedup marker for the urgent-email notification sweep.
 *
 * The scheduler records which urgent emails it has already pinged by embedding
 * their Gmail message IDs in the Notification.message string, then reads them
 * back next tick to avoid re-notifying. The marker is a single trailing
 * `[id1,id2,…]` block: anchoring the reader to the END of the string (`$`)
 * avoids false-positives from any `[...]` that appears inside the human-facing
 * body (e.g. a sender name or subject), while still capturing EVERY notified id.
 *
 * The previous format embedded only the first email's id, so when several
 * urgent emails arrived in one tick the rest were never recorded and got
 * re-notified every sync tick for up to an hour.
 */

/** Build `"<body> [id1,id2,…]"`. Gmail message IDs are hex, never contain commas. */
export function buildUrgentDedupMessage(body: string, gmailIds: readonly string[]): string {
  return `${body} [${gmailIds.join(",")}]`;
}

/**
 * Extract every notified gmailId from prior notification messages. Reads only
 * the trailing `[...]` marker of each message and splits it, so all ids written
 * by buildUrgentDedupMessage are recovered. Backward-compatible with the old
 * single-id `[gmailId]` format (split of one element yields that one id).
 */
export function parseNotifiedGmailIds(messages: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const match = message.match(/\[([^\]]+)\]$/);
    if (!match) continue;
    for (const id of match[1].split(",")) {
      const trimmed = id.trim();
      if (trimmed) ids.add(trimmed);
    }
  }
  return ids;
}
