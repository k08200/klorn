/**
 * Provider → SourceBadge glyph and spoken name (productization plan §1/§2).
 *
 * Keys are the wire values: `InboxProvider` from @klorn/contract (GOOGLE /
 * NAVER / ICLOUD / OUTLOOK / IMAP, the app-password presets DAUM … ZOHOPRO)
 * plus KLORN for the native mailbox. Glyphs
 * are neutral monograms — never brand colours or logos. Clients must treat an
 * unknown provider as a generic mail source (contract email.ts), so anything
 * not listed gets a neutral "@" glyph — not IMAP's, which would misname it.
 */

export interface SourceGlyph {
  /** Visible monogram, 1–4 characters. */
  glyph: string;
  /** Name used in the accessible label ("From Google"). */
  name: string;
}

const GENERIC: SourceGlyph = { glyph: "@", name: "another mail account" };

const SOURCE_GLYPHS: Readonly<Record<string, SourceGlyph>> = {
  GOOGLE: { glyph: "G", name: "Google" },
  OUTLOOK: { glyph: "M", name: "Microsoft" },
  NAVER: { glyph: "N", name: "Naver" },
  ICLOUD: { glyph: "iC", name: "iCloud" },
  IMAP: { glyph: "IMAP", name: "IMAP" },
  KLORN: { glyph: "K", name: "Klorn" },
  DAUM: { glyph: "D", name: "Daum" },
  KAKAO: { glyph: "Ka", name: "Kakao" },
  YAHOO: { glyph: "Y", name: "Yahoo" },
  AOL: { glyph: "AOL", name: "AOL" },
  FASTMAIL: { glyph: "F", name: "Fastmail" },
  // Same service, two kinds of mailbox: the name tells them apart.
  ZOHO: { glyph: "Z", name: "Zoho" },
  ZOHOPRO: { glyph: "Z", name: "Zoho (organization)" },
};

/** Case-insensitive lookup; unknown or empty → generic. */
export function sourceGlyph(provider: string | null | undefined): SourceGlyph {
  if (!provider) return GENERIC;
  return SOURCE_GLYPHS[provider.toUpperCase()] ?? GENERIC;
}

/** "From Google · work@" — the badge's accessible name. */
export function sourceLabel(provider: string | null | undefined, nickname?: string | null): string {
  const base = `From ${sourceGlyph(provider).name}`;
  const nick = nickname?.trim();
  return nick ? `${base} · ${nick}` : base;
}
