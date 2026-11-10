import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { kv } from "../platform/kv";
import {
  createTranslator,
  deviceLocale,
  isLocale,
  type Locale,
  loadCatalog,
  loadedCatalog,
  type Messages,
  type Translator,
} from "./index";

const OVERRIDE_KEY = "klorn-locale";

interface I18nValue extends Translator {
  /** null = follow the device. */
  override: Locale | null;
  setOverride(locale: Locale | null): void;
}

const I18nContext = createContext<I18nValue | null>(null);

/**
 * Before the first render (main.tsx): read the stored override and load the
 * active language's catalog, so the first frame is already translated. A
 * catalog is a local chunk of the bundle; should it fail anyway, English.
 */
export async function prepareI18n(): Promise<{ override: Locale | null }> {
  let override: Locale | null = null;
  try {
    const stored = await kv.getItem(OVERRIDE_KEY);
    if (isLocale(stored)) override = stored;
  } catch {
    // Storage unavailable — follow the device.
  }
  await loadCatalog(override ?? deviceLocale()).catch(() => loadCatalog("en"));
  return { override };
}

interface Active {
  locale: Locale;
  messages: Messages;
}

function cached(locale: Locale): Active | null {
  const own = loadedCatalog(locale);
  if (own) return { locale, messages: own };
  const en = loadedCatalog("en");
  return en ? { locale: "en", messages: en } : null;
}

export function I18nProvider({
  initialOverride = null,
  children,
}: {
  initialOverride?: Locale | null;
  children: ReactNode;
}) {
  const [device, setDevice] = useState<Locale>(() => deviceLocale());
  const [override, setOverrideState] = useState<Locale | null>(initialOverride);
  const wanted = override ?? device;
  // The language on screen. A switch keeps the current one until the next
  // catalog has loaded, so text never blanks or shows keys in between.
  const [active, setActive] = useState<Active | null>(() => cached(wanted));

  useEffect(() => {
    const onChange = () => setDevice(deviceLocale());
    window.addEventListener("languagechange", onChange);
    return () => window.removeEventListener("languagechange", onChange);
  }, []);

  const shown = active?.locale ?? null;
  useEffect(() => {
    if (shown === wanted) return;
    let alive = true;
    loadCatalog(wanted)
      .then((messages): Active => ({ locale: wanted, messages }))
      // Nothing on screen yet and the chunk failed: English rather than nothing.
      .catch(() =>
        shown ? null : loadCatalog("en").then((messages): Active => ({ locale: "en", messages })),
      )
      .then((next) => {
        if (alive && next) setActive(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [wanted, shown]);

  const value = useMemo<I18nValue | null>(() => {
    if (!active) return null;
    return {
      ...createTranslator(active.locale, active.messages),
      override,
      setOverride(next) {
        setOverrideState(next);
        if (next) void kv.setItem(OVERRIDE_KEY, next);
        else void kv.removeItem(OVERRIDE_KEY);
      },
    };
  }, [active, override]);

  const intlTag = value?.intlTag;
  useEffect(() => {
    if (intlTag) document.documentElement.lang = intlTag;
  }, [intlTag]);

  // Only when mounted without prepareI18n(): nothing renders before a catalog.
  if (!value) return null;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n outside I18nProvider");
  return value;
}
