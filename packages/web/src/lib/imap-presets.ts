/**
 * The fixed-host app-password IMAP presets (provider phase 2): Daum, Kakao,
 * Yahoo, AOL, Fastmail, Zoho and Zoho organization mailboxes. One table drives
 * ONE Settings card component (components/imap-preset-section.tsx), the first
 * run's tile and sheet, and Account health's link to each card.
 *
 * The server owns the hosts and the flag (IMAP_PRESETS_ENABLED): this client
 * sends only an address and a password to `/api/<slug>-imap/*`, and a preset
 * whose routes answer 404 renders nothing. The list and its order match the
 * server's IMAP_PRESET_KEYS (pinned by api/src/__tests__/web-imap-presets.test.ts).
 */

import type { InboxProvider } from "@klorn/contract";

export type ImapPresetProvider = Extract<
  InboxProvider,
  "DAUM" | "KAKAO" | "YAHOO" | "AOL" | "FASTMAIL" | "ZOHO" | "ZOHOPRO"
>;

/** The route segment (`/api/<slug>-imap`) and the Settings section id (`account-<slug>`). */
export type ImapPresetSlug = Lowercase<ImapPresetProvider>;

export interface ImapPreset {
  provider: ImapPresetProvider;
  slug: ImapPresetSlug;
  /** Product name, not translated (Account health shows the same). */
  label: string;
  /** The provider's own instructions for the password Klorn needs. */
  helpUrl: string;
  emailPlaceholder: string;
  /**
   * i18n key: the one-line steps to get an app password. Every preset asks for
   * one, never the account password (Zoho too: its hint has two-factor turned on).
   */
  hintKey: string;
}

type PresetFields = Omit<ImapPreset, "provider" | "slug">;

/** Zoho's IMAP page covers both kinds of mailbox and the application-specific password. */
const ZOHO_HELP_URL = "https://www.zoho.com/mail/help/imap-access.html";

/** A Record so the compiler insists on every preset; insertion order is display order. */
const PRESETS: Readonly<Record<ImapPresetProvider, PresetFields>> = {
  DAUM: {
    label: "Daum Mail",
    helpUrl: "https://cs.daum.net/faq/service/43/category/9234/detail/24081",
    emailPlaceholder: "you@daum.net",
    hintKey: "imapPreset.hint.daum",
  },
  KAKAO: {
    label: "Kakao Mail",
    helpUrl: "https://cs.kakao.com/helps_html/1073209983",
    emailPlaceholder: "you@kakao.com",
    hintKey: "imapPreset.hint.kakao",
  },
  YAHOO: {
    label: "Yahoo Mail",
    helpUrl: "https://help.yahoo.com/kb/SLN15241.html",
    emailPlaceholder: "you@yahoo.com",
    hintKey: "imapPreset.hint.yahoo",
  },
  AOL: {
    label: "AOL Mail",
    helpUrl: "https://help.aol.com/articles/create-and-manage-app-password",
    emailPlaceholder: "you@aol.com",
    hintKey: "imapPreset.hint.aol",
  },
  FASTMAIL: {
    label: "Fastmail",
    helpUrl: "https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords",
    emailPlaceholder: "you@fastmail.com",
    hintKey: "imapPreset.hint.fastmail",
  },
  ZOHO: {
    label: "Zoho Mail",
    emailPlaceholder: "you@zohomail.com",
    hintKey: "imapPreset.hint.zoho",
    helpUrl: ZOHO_HELP_URL,
  },
  ZOHOPRO: {
    label: "Zoho Mail (organization)",
    emailPlaceholder: "you@example.com",
    hintKey: "imapPreset.hint.zohopro",
    helpUrl: ZOHO_HELP_URL,
  },
};

export const IMAP_PRESETS: readonly ImapPreset[] = (
  Object.keys(PRESETS) as ImapPresetProvider[]
).map((provider) => ({
  provider,
  slug: provider.toLowerCase() as ImapPresetSlug,
  ...PRESETS[provider],
}));

/** Product names for PROVIDER_LABEL (lib/account-health.ts). */
export const IMAP_PRESET_LABEL: Readonly<Record<ImapPresetProvider, string>> = {
  DAUM: PRESETS.DAUM.label,
  KAKAO: PRESETS.KAKAO.label,
  YAHOO: PRESETS.YAHOO.label,
  AOL: PRESETS.AOL.label,
  FASTMAIL: PRESETS.FASTMAIL.label,
  ZOHO: PRESETS.ZOHO.label,
  ZOHOPRO: PRESETS.ZOHOPRO.label,
};

/** The preset for a wire provider value; null for any other provider. */
export function imapPresetFor(provider: string): ImapPreset | null {
  return IMAP_PRESETS.find((preset) => preset.provider === provider) ?? null;
}
