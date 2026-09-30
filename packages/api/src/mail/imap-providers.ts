/**
 * Per-provider config for the generalized IMAP path (Phase 2 of
 * docs/providers/multi-provider-plan.md). One registry entry per
 * app-password IMAP provider; OAuth providers (Google, Outlook) never
 * appear here — their credential shape is different (inboxAuthKind()).
 *
 * `idPrefix` namespaces the synthesized EmailMessage.gmailId
 * (`<idPrefix>:<mailbox email>:<imap uid>`). It is PERSISTED in dedup keys —
 * an existing prefix must never change, or every already-ingested message
 * re-ingests as new.
 */

import { icloudInboxEnabled } from "../config.js";

export type ImapProviderKey = "NAVER" | "ICLOUD";

/**
 * Where a provider accepts mail for submission. Taken from the provider's own
 * help pages and fixed here: an SMTP connection is only ever opened to this
 * host, never to anything stored on, or derived from, an account row (step B3).
 *
 * `starttls` connects in clear and upgrades before any credential is sent; the
 * transport REQUIRES the upgrade, so a server that does not offer it fails the
 * send instead of falling back to plaintext. `implicit-tls` is TLS from the
 * first byte (port 465).
 */
export interface SmtpEndpoint {
  host: string;
  port: number;
  security: "starttls" | "implicit-tls";
}

export interface ImapProviderConfig {
  provider: ImapProviderKey;
  /** User-facing name for error copy ("Naver", "iCloud"). */
  label: string;
  /** The only host the SSRF allowlist accepts for this provider. */
  defaultHost: string;
  /** Persisted dedup-key namespace — never change an existing value. */
  idPrefix: string;
  /** Log + Sentry scope prefix (also effectively persisted: ops dashboards). */
  logScope: string;
  /** Shown in the settings UI when the IMAP LOGIN itself is rejected. */
  authFailureHint: string;
  /** Same ceiling rationale as routes/auth.ts MAX_LINKED_INBOXES: one user
   * must not turn the serial IMAP poll into a multi-minute tick. */
  maxAccounts: number;
  /** Outgoing mail server (step B3). The only SMTP host this provider uses. */
  smtp: SmtpEndpoint;
  /** Public webmail entry, handed back as the link for a saved draft. */
  webmailUrl: string;
}

export const IMAP_PROVIDERS: Record<ImapProviderKey, ImapProviderConfig> = {
  NAVER: {
    provider: "NAVER",
    label: "Naver",
    defaultHost: "imap.naver.com:993",
    idPrefix: "naver-imap",
    logScope: "naver-imap",
    authFailureHint:
      "Naver IMAP login failed. Generate a separate '외부 메일 비밀번호' in Naver security settings and paste that — not your account password.",
    maxAccounts: 10,
    // Naver help center, "IMAP/SMTP 설정 및 해제 방법"
    // (https://help.naver.com/service/30029/bookmark/21344), read 2026-09-30:
    // "SMTP 서버명 : smtp.naver.com", "SMTP 포트 : 587, 보안 연결(TLS) 필요
    // (TLS가 없는 경우 SSL로 연결)". Port 587 with TLS is the primary setting; the
    // stated fallback is implicit SSL (465), a one-line change here if 587
    // refuses our connections.
    smtp: { host: "smtp.naver.com", port: 587, security: "starttls" },
    webmailUrl: "https://mail.naver.com/",
  },
  ICLOUD: {
    provider: "ICLOUD",
    label: "iCloud",
    defaultHost: "imap.mail.me.com:993",
    idPrefix: "icloud-imap",
    logScope: "icloud-imap",
    authFailureHint:
      "iCloud IMAP login failed. Generate an app-specific password at account.apple.com (requires two-factor authentication on your Apple ID) and paste that — not your Apple ID password.",
    maxAccounts: 10,
    // Apple Support, "iCloud Mail server settings for other email client apps"
    // (https://support.apple.com/en-us/102525, published 2026-02-03, read
    // 2026-09-30): "Server name: smtp.mail.me.com", "Port: 587", "SSL Required:
    // Yes ... try TLS or STARTTLS", "SMTP Authentication Required: Yes",
    // username = the full iCloud Mail address, password = an app-specific one.
    smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
    webmailUrl: "https://www.icloud.com/mail/",
  },
};

/**
 * Host↔provider pin: the shared SSRF allowlist alone would let a NAVER row
 * point at the iCloud host (and vice versa). Compares the host part only —
 * the port-less form was always accepted, and port validity is the
 * allowlist's job. Enforced at the /connect write AND re-checked at poll
 * time (imap-accounts.ts), same belt-and-braces as the allowlist itself.
 */
export function hostMatchesProvider(host: string, provider: ImapProviderConfig): boolean {
  const hostPart = host.trim().toLowerCase().split(":")[0];
  return hostPart === provider.defaultHost.split(":")[0];
}

/**
 * Providers the poll scheduler may select rows for. NAVER predates the flag
 * doctrine and is always on; ICLOUD stays dark until ICLOUD_INBOX_ENABLED
 * (CASA surface freeze — see the flag comment in config.ts). Evaluated per
 * tick so the flag is togglable without a restart.
 */
export function enabledImapProviderKeys(): ImapProviderKey[] {
  return icloudInboxEnabled() ? ["NAVER", "ICLOUD"] : ["NAVER"];
}
