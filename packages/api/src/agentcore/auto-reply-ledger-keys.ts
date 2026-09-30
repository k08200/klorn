/**
 * Notification.dedupeKey namespaces for unattended replies. One row per mail
 * per namespace (unique on userId + dedupeKey) is the at-most-once claim that
 * is written BEFORE a send and kept — even as a failure record — afterwards.
 *
 * Both namespaces guard the same mail: the AUTO_REPLY rule sweep claims
 * `auto-reply:`, the auto-mode sweep claims `auto-mode-reply:`, and each
 * checks BOTH before spending an LLM call or sending.
 */

export function ruleReplyLedgerKey(gmailId: string): string {
  return `auto-reply:${gmailId}`;
}

export function autoModeLedgerKey(gmailId: string): string {
  return `auto-mode-reply:${gmailId}`;
}

/** Every key that means "an unattended reply already claimed this mail". */
export function replyLedgerKeys(gmailId: string): string[] {
  return [ruleReplyLedgerKey(gmailId), autoModeLedgerKey(gmailId)];
}
