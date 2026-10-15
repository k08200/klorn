"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import de from "./locales/de";
import en from "./locales/en";
import es from "./locales/es";
import fr from "./locales/fr";
import ja from "./locales/ja";
import ko from "./locales/ko";
import zh from "./locales/zh";

/**
 * Shipped UI locales. Mirrors the server's NOTIFICATION_LANGUAGES so the app
 * a user reads and the notifications they receive can speak the same language
 * (packages/api/src/notify/notification-strings.ts).
 */
export type Locale = "en" | "ko" | "ja" | "zh" | "es" | "fr" | "de";

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
const PROFILE_KEY = "klorn-profile";
const LEGACY_KEY_PREFIX = "ev" + "e";
const LEGACY_PROFILE_KEY = `${LEGACY_KEY_PREFIX}-profile`;

function getStoredProfile(): string | null {
  const stored = localStorage.getItem(PROFILE_KEY);
  if (stored) return stored;
  const legacyStored = localStorage.getItem(LEGACY_PROFILE_KEY);
  if (legacyStored) {
    localStorage.setItem(PROFILE_KEY, legacyStored);
    localStorage.removeItem(LEGACY_PROFILE_KEY);
  }
  return legacyStored;
}

/** Every locale that has a table — derived, so adding a file is enough. */
const LOCALES = Object.keys(translations) as Locale[];

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as string[]).includes(value);
}

function detectLocale(): Locale {
  // English is the default and every other locale is opt-in — a Japanese
  // browser still lands in English unless the user picks 日本語 in
  // Settings → Language. We intentionally do NOT follow navigator.language.
  //
  // The check is against the locale LIST, not a hardcoded code: this used to
  // read `language === "ko"`, which silently ignored every language added
  // after Korean.
  try {
    const stored = getStoredProfile();
    if (stored) {
      const { language } = JSON.parse(stored);
      if (isLocale(language)) return language;
    }
  } catch {
    // ignore a malformed profile
  }
  return "en";
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
