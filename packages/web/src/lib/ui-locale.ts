/**
 * The UI language the reader picked (Settings → Language), readable outside
 * React. i18n.tsx renders with it; apiFetch sends it as Accept-Language so
 * server-composed reasons arrive in the language the screen is in, not the
 * stored notification language (packages/api/src/notify/request-language.ts).
 *
 * English is the default and every other locale is opt-in — a Korean or
 * Chinese browser still lands in English unless the user picks 한국어 or
 * 中文（简体）. We intentionally do NOT follow navigator.language, so a browser
 * in a language Klorn does not ship (ja, es, fr, de, …) is English too.
 *
 * Shipped: en, ko and zh (Simplified Chinese). ja/es/fr/de were retired on
 * 2026-11-17; a profile still holding one of them fails isUiLocale and reads
 * as English.
 */

/** Mirrors the server's SHIPPED_LANGUAGES (packages/api/src/shipped-languages.ts). */
export const UI_LOCALES = ["en", "ko", "zh"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

export const PROFILE_KEY = "klorn-profile";
const LEGACY_KEY_PREFIX = "ev" + "e";
export const LEGACY_PROFILE_KEY = `${LEGACY_KEY_PREFIX}-profile`;

function storedProfile(): string | null {
  const stored = localStorage.getItem(PROFILE_KEY);
  if (stored) return stored;
  const legacyStored = localStorage.getItem(LEGACY_PROFILE_KEY);
  if (legacyStored) {
    localStorage.setItem(PROFILE_KEY, legacyStored);
    localStorage.removeItem(LEGACY_PROFILE_KEY);
  }
  return legacyStored;
}

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === "string" && (UI_LOCALES as readonly string[]).includes(value);
}

/** The active UI locale; "en" on the server, with no profile, or a malformed one. */
export function activeUiLocale(): UiLocale {
  if (typeof window === "undefined") return "en";
  try {
    const stored = storedProfile();
    if (stored) {
      const { language } = JSON.parse(stored) as { language?: unknown };
      if (isUiLocale(language)) return language;
    }
  } catch {
    // A malformed profile or blocked storage reads as the default.
  }
  return "en";
}
