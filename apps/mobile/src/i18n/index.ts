/**
 * i18n core — pure, no React. Seven app languages; the default is the device
 * locale (navigator.languages, which the Capacitor WebView takes from the OS),
 * overridable in Accounts. This is the APP language only — notification
 * language is a server setting and reply language follows the mail
 * (docs/product-vocabulary.md, "Two different language settings").
 */
import type { MessageKey, Messages } from "./locales/en";

export const LOCALES = ["en", "ko", "ja", "zh", "es", "fr", "de"] as const;
export type Locale = (typeof LOCALES)[number];
export type { MessageKey, Messages };

/**
 * Catalogs load on demand, one chunk per language: startup bundles none of
 * them and awaits only the active one (main.tsx, before the first render), so
 * no key ever flashes untranslated; switching language loads the next one.
 * There is no English fallback at runtime — the parity test pins every key in
 * every catalog, so a lookup can only miss on a key that does not exist.
 */
const LOADERS: Record<Locale, () => Promise<Messages>> = {
  en: () => import("./locales/en").then((m) => m.en),
  ko: () => import("./locales/ko").then((m) => m.ko),
  ja: () => import("./locales/ja").then((m) => m.ja),
  zh: () => import("./locales/zh").then((m) => m.zh),
  es: () => import("./locales/es").then((m) => m.es),
  fr: () => import("./locales/fr").then((m) => m.fr),
  de: () => import("./locales/de").then((m) => m.de),
};

const loaded = new Map<Locale, Messages>();
const loading = new Map<Locale, Promise<Messages>>();

/** The catalog if it is already loaded (synchronous; null otherwise). */
export function loadedCatalog(locale: Locale): Messages | null {
  return loaded.get(locale) ?? null;
}

/** Load (once) and cache a language's catalog. */
export function loadCatalog(locale: Locale): Promise<Messages> {
  const ready = loaded.get(locale);
  if (ready) return Promise.resolve(ready);
  let pending = loading.get(locale);
  if (!pending) {
    pending = LOADERS[locale]().then(
      (messages) => {
        loaded.set(locale, messages);
        loading.delete(locale);
        return messages;
      },
      (err: unknown) => {
        loading.delete(locale);
        throw err;
      },
    );
    loading.set(locale, pending);
  }
  return pending;
}

/** Each language's own name, shown in the language picker (never translated). */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  ko: "한국어",
  ja: "日本語",
  zh: "简体中文",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
};

/** BCP 47 tag handed to Intl for each app language. */
export const INTL_TAGS: Record<Locale, string> = {
  en: "en",
  ko: "ko-KR",
  ja: "ja-JP",
  zh: "zh-CN",
  es: "es",
  fr: "fr",
  de: "de",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** First supported language among the device's preferred tags, else English. */
export function matchLocale(tags: readonly string[]): Locale {
  for (const tag of tags) {
    const primary = tag.toLowerCase().split(/[-_]/)[0];
    if (isLocale(primary)) return primary;
  }
  return "en";
}

export function deviceLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  return matchLocale(tags.filter(Boolean));
}

export type Params = Record<string, string | number>;

const PLACEHOLDER = /\{(\w+)\}/g;

export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Names inside `{…}` in a message — the parity test compares these per key. */
export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1] ?? "").sort();
}

/** Keys with plural forms, by their base (`today.replies` for `today.replies.one`/`.other`). */
export type PluralBase = MessageKey extends infer K
  ? K extends `${infer Base}.other`
    ? Base
    : never
  : never;

export interface Translator {
  locale: Locale;
  intlTag: string;
  t(key: MessageKey, params?: Params): string;
  /** Plural-aware: picks `<base>.<rule>` (falling back to `.other`), with `{count}`. */
  tn(base: PluralBase, count: number, params?: Params): string;
}

export function createTranslator(locale: Locale, messages: Messages): Translator {
  const intlTag = INTL_TAGS[locale];
  const rules = new Intl.PluralRules(intlTag);
  const lookup = (key: string): string => (messages as Record<string, string>)[key] ?? key;
  return {
    locale,
    intlTag,
    t: (key, params) => interpolate(lookup(key), params),
    tn: (base, count, params) => {
      const rule = rules.select(count);
      const key = rule === "one" ? `${base}.one` : `${base}.other`;
      return interpolate(lookup(key), { count, ...params });
    },
  };
}
