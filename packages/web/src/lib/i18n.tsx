"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import de from "./locales/de";
import en from "./locales/en";
import es from "./locales/es";
import fr from "./locales/fr";
import ja from "./locales/ja";
import ko from "./locales/ko";
import zh from "./locales/zh";
import { activeUiLocale, LEGACY_PROFILE_KEY, PROFILE_KEY, type UiLocale } from "./ui-locale";

/**
 * Shipped UI locales. Mirrors the server's NOTIFICATION_LANGUAGES so the app
 * a user reads and the notifications they receive can speak the same language
 * (packages/api/src/notify/notification-strings.ts).
 */
export type Locale = UiLocale;

// English is the source of truth for keys; every other locale is a full
// mirror, enforced in CI by .github/scripts/check-i18n-parity.mjs. Tables
// live one-per-file under ./locales.
const translations: Record<Locale, Record<string, string>> = { en, ko, ja, zh, es, fr, de };

/**
 * Dev-time echo of the CI parity guard. The guard
 * (.github/scripts/check-i18n-parity.mjs) is what actually blocks a merge;
 * this only shortens the feedback loop while editing locally.
 */
function verifyTranslationSymmetry(): void {
  const locales = Object.keys(translations) as Locale[];
  if (locales.length === 0) return;
  const base = locales[0];
  const baseKeys = new Set(Object.keys(translations[base]));

  for (const locale of locales.slice(1)) {
    const localeKeys = new Set(Object.keys(translations[locale]));
    const missing = [...baseKeys].filter((k) => !localeKeys.has(k));
    const extra = [...localeKeys].filter((k) => !baseKeys.has(k));
    if (missing.length > 0) {
      // biome-ignore lint/suspicious/noConsole: dev-time i18n validation
      console.warn(`[i18n] "${locale}" missing keys: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      // biome-ignore lint/suspicious/noConsole: dev-time i18n validation
      console.warn(`[i18n] "${locale}" has unexpected keys: ${extra.join(", ")}`);
    }
  }
}

if (process.env.NODE_ENV !== "production") {
  verifyTranslationSymmetry();
}

interface I18nContextType {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string>) => string;
}

const I18nContext = createContext<I18nContextType | null>(null);

function detectLocale(): Locale {
  // The check is against the locale LIST (ui-locale.ts), not a hardcoded
  // code: this used to read `language === "ko"`, which silently ignored every
  // language added after Korean.
  return activeUiLocale();
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    setLocaleState(detectLocale());

    // Re-detect when profile settings change in another tab/window…
    const onStorage = (e: StorageEvent) => {
      if (e.key === PROFILE_KEY || e.key === LEGACY_PROFILE_KEY) {
        setLocaleState(detectLocale());
      }
    };
    // …and in THIS tab (the storage event never fires in the writing tab, so
    // Settings dispatches this after saving the profile).
    const onProfileUpdated = () => setLocaleState(detectLocale());
    window.addEventListener("storage", onStorage);
    window.addEventListener("klorn-profile-updated", onProfileUpdated);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("klorn-profile-updated", onProfileUpdated);
    };
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string>): string => {
      let str = translations[locale]?.[key] || translations.en[key] || key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          // A function replacement: a value such as a file name may hold "$&".
          str = str.replace(`{${k}}`, () => v);
        }
      }
      return str;
    },
    [locale],
  );

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useT() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used within I18nProvider");
  return ctx;
}
