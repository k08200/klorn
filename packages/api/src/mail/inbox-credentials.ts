/**
 * Provider-aware credential shape for LinkedInboxAccount rows (Phase 0a of
 * the multi-provider plan, docs/providers/multi-provider-plan.md).
 *
 * A row's provider decides which credentials it must carry:
 *   - OAuth providers (GOOGLE, OUTLOOK) authenticate with an encrypted token
 *     pair — accessToken is the cipher, refresh handled by the provider module.
 *   - IMAP providers (NAVER, ICLOUD, IMAP) authenticate with host + an
 *     encrypted password (app-specific password for iCloud).
 *
 * "broken" = the row claims a provider but lacks that provider's credentials.
 * Callers treat it exactly like needsReconnect — prompt a re-link — never as
 * an invariant violation: rows can legitimately reach this state via a failed
 * half-migration or a manual DB edit, and the inbox must rot visibly, not
 * crash the sync tick.
 */

// KLORN: the Klorn address (step E1a), mail Klorn receives itself: no credentials.
export type InboxProviderName = "GOOGLE" | "NAVER" | "ICLOUD" | "OUTLOOK" | "IMAP" | "KLORN";

export type InboxAuthKind = "oauth" | "imap" | "broken";

const OAUTH_PROVIDERS: ReadonlySet<InboxProviderName> = new Set(["GOOGLE", "OUTLOOK"]);

export function inboxAuthKind(row: {
  provider: InboxProviderName;
  accessToken: string | null;
  imapHost: string | null;
  imapPasswordCipher: string | null;
}): InboxAuthKind {
  if (OAUTH_PROVIDERS.has(row.provider)) {
    return row.accessToken ? "oauth" : "broken";
  }
  return row.imapHost && row.imapPasswordCipher ? "imap" : "broken";
}
