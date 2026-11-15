/**
 * The fixed-host app-password IMAP presets of provider phase 2 (Daum, Kakao, Yahoo,
 * AOL, Fastmail, Zoho). A leaf module with no imports, so the provider unions
 * (inbox-credentials.ts) and the per-provider lists that must name every IMAP
 * provider can share this one list without an import cycle. Each key is an
 * InboxProvider value (schema.prisma) and an IMAP_PROVIDERS entry
 * (imap-preset-providers.ts); the whole set is behind IMAP_PRESETS_ENABLED.
 *
 * No underscores: the key's lower case is the route slug (`/api/<slug>-imap`) the
 * web and Mac clients call. Display order of the provider grid.
 */
export const IMAP_PRESET_KEYS = [
  "DAUM",
  "KAKAO",
  "YAHOO",
  "AOL",
  "FASTMAIL",
  "ZOHO",
  "ZOHOPRO",
] as const;

export type ImapPresetKey = (typeof IMAP_PRESET_KEYS)[number];

export function isImapPresetKey(value: string): value is ImapPresetKey {
  return (IMAP_PRESET_KEYS as readonly string[]).includes(value);
}

/** The path segment of a preset's connect routes: `/api/<slug>-imap`. */
export function imapPresetRouteSlug(key: ImapPresetKey): string {
  return key.toLowerCase();
}
