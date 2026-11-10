import { describe, expect, it } from "vitest";
import {
  createTranslator,
  LOCALES,
  type Locale,
  loadCatalog,
  loadedCatalog,
  type Messages,
  matchLocale,
  placeholdersOf,
} from "./index";
import { de } from "./locales/de";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { zh } from "./locales/zh";

// The app loads catalogs on demand (index.ts); the tests read them directly.
const CATALOGS: Record<Locale, Messages> = { en, ko, ja, zh, es, fr, de };
const translator = (locale: Locale) => createTranslator(locale, CATALOGS[locale]);

describe("i18n parity across the 7 locales", () => {
  const keys = Object.keys(en).sort();

  it.each(LOCALES)("%s has exactly the English keys", (locale) => {
    expect(Object.keys(CATALOGS[locale]).sort()).toEqual(keys);
  });

  it.each(LOCALES)("%s keeps every placeholder and leaves nothing empty", (locale) => {
    for (const key of keys) {
      const value = (CATALOGS[locale] as Record<string, string>)[key] ?? "";
      expect(value.trim(), `${locale} ${key}`).not.toBe("");
      expect(placeholdersOf(value), `${locale} ${key}`).toEqual(
        placeholdersOf((en as Record<string, string>)[key] ?? ""),
      );
    }
  });

  it.each(LOCALES)("%s follows the product vocabulary", (locale) => {
    for (const [key, value] of Object.entries(CATALOGS[locale])) {
      // Retired v1 lanes never appear in copy; neither do retired screen names.
      expect(value, `${locale} ${key}`).not.toMatch(/\b(AUTO|CALL)\b/);
      expect(value, `${locale} ${key}`).not.toMatch(/firewall|decision queue/i);
    }
  });

  it("lane names are never translated", () => {
    for (const locale of LOCALES) {
      const t = translator(locale);
      expect(t.t("today.brief.emptyTitle")).toContain("PUSH");
      expect(t.tn("today.lanes.count", 14, { lane: "QUEUE" })).toContain("QUEUE");
    }
  });
});

describe("translator", () => {
  it("defaults to the device locale, else English", () => {
    expect(matchLocale(["ko-KR", "en-US"])).toBe("ko");
    expect(matchLocale(["zh-Hant-TW"])).toBe("zh");
    expect(matchLocale(["pt-BR", "de-AT"])).toBe("de");
    expect(matchLocale(["pt-BR"])).toBe("en");
    expect(matchLocale([])).toBe("en");
  });

  it("interpolates and pluralises", () => {
    const en = translator("en");
    expect(en.tn("today.replies", 1)).toBe("1 email needs a reply");
    expect(en.tn("today.replies", 2)).toBe("2 emails need a reply");
    expect(en.t("today.summary.both", { replies: "a", meetings: "b" })).toBe(
      "a, and you have b today.",
    );
    const ko = translator("ko");
    expect(
      ko.t("today.summary.both", {
        replies: ko.tn("today.replies", 2),
        meetings: ko.tn("today.meetings", 3),
      }),
    ).toBe("답장이 필요한 메일 2개, 회의가 3개 있어요.");
    expect(translator("fr").tn("today.meetings", 0)).toBe("0 réunion");
  });
});

describe("on-demand catalogs", () => {
  it.each(LOCALES)("%s loads its own catalog, once", async (locale) => {
    const first = loadCatalog(locale);
    expect(loadCatalog(locale)).toBe(first);
    expect(await first).toBe(CATALOGS[locale]);
    expect(loadedCatalog(locale)).toBe(CATALOGS[locale]);
  });

  it("returns the key itself for a key no catalog has (no English fallback needed)", () => {
    const t = translator("ko");
    expect(t.t("nope.missing" as never)).toBe("nope.missing");
  });
});
