/**
 * The languages Klorn ships: English, Korean and Simplified Chinese (zh =
 * zh-Hans). Mirrors the web app's UI_LOCALES (packages/web/src/lib/ui-locale.ts).
 *
 * Server copy tables outside notify/ are keyed by this union, so a table
 * missing one of the three fails the build. Any other code — a retired
 * ja/es/fr/de value stored before 2026-11-17, a foreign Accept-Language, a
 * regional tag this list does not ship — reads as English, never a throw.
 */
export const SHIPPED_LANGUAGES = ["en", "ko", "zh"] as const;
export type ShippedLanguage = (typeof SHIPPED_LANGUAGES)[number];

const DEFAULT_LANGUAGE: ShippedLanguage = "en";

export function isShippedLanguage(value: unknown): value is ShippedLanguage {
  return typeof value === "string" && (SHIPPED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Narrow a stored or requested code to a shipped language. Regional tags fold
 * onto their base ("zh-TW" / "zh_Hans" → zh, "ko-KR" → ko); anything else —
 * including a non-string from a request body — is English.
 */
export function toShippedLanguage(raw: unknown): ShippedLanguage {
  if (typeof raw !== "string" || !raw) return DEFAULT_LANGUAGE;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return isShippedLanguage(base) ? base : DEFAULT_LANGUAGE;
}

/** The language name an LLM prompt asks its output to be written in. */
export const OUTPUT_LANGUAGE_NAME: Readonly<Record<ShippedLanguage, string>> = {
  en: "English",
  ko: "Korean",
  zh: "Simplified Chinese",
};
