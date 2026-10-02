/**
 * CalDAV endpoint presets.
 *
 * The point of this file is that it stays short. CalDAV is a standard, so the
 * long tail — Nextcloud, university and company servers, self-hosted Radicale
 * — is reached by RFC 6764 discovery against the user's own domain, not by an
 * entry here. Presets exist only for hosts where discovery from the mail
 * domain does not land on the right place, which in practice means the big
 * consumer providers.
 *
 * Mirrors `mail/imap-providers.ts` in shape deliberately: the same user is
 * connecting the same account, and "Apple" should mean one thing in both
 * lists.
 */

export interface CalDavProviderConfig {
  /** Stable id — persisted on stored accounts, so it must not change. */
  readonly id: string;
  /** Shown to the user. */
  readonly label: string;
  /** Discovery entry point. */
  readonly baseUrl: string;
  /**
   * What to tell the user about credentials. Every one of these providers
   * rejects the account password, and "wrong password" is what the user sees
   * unless we say so up front.
   */
  readonly credentialHint: string;
}

export const CALDAV_PROVIDERS: readonly CalDavProviderConfig[] = [
  {
    id: "icloud",
    label: "Apple iCloud",
    baseUrl: "https://caldav.icloud.com",
    credentialHint:
      "Use your Apple ID and an app-specific password from account.apple.com — the Apple ID password will be rejected.",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    baseUrl: "https://caldav.fastmail.com/dav/",
    credentialHint:
      "Use your Fastmail address and an app password scoped to Calendars (Settings → Privacy & Security → App passwords).",
  },
];

export function calDavProviderById(id: string): CalDavProviderConfig | undefined {
  return CALDAV_PROVIDERS.find((p) => p.id === id);
}

/**
 * RFC 6764 discovery URL for an arbitrary domain.
 *
 * `https://<domain>/.well-known/caldav` is the standard entry point, and a
 * conforming server redirects from there to its real DAV root — which is why
 * the client follows redirects. This is the path that makes Nextcloud, company
 * servers and self-hosted setups work without an entry in the table above.
 */
export function wellKnownCalDavUrl(domain: string): string {
  const host = domain.trim().toLowerCase().replace(/^@/, "");
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    throw new Error(`Not a usable mail domain for CalDAV discovery: ${domain}`);
  }
  return `https://${host}/.well-known/caldav`;
}

/** The domain half of an email address, for well-known discovery. */
export function domainFromAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at === -1) throw new Error(`Not an email address: ${address}`);
  return address.slice(at + 1);
}
