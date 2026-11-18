/**
 * The shipped-language set (en, ko, zh — founder decision 2026-11-17) and the
 * fold every server copy table outside notify/ reads through. A retired
 * ja/es/fr/de value still stored somewhere, or any language Klorn does not
 * ship, must read as English rather than as a blank or a throw.
 */

import { describe, expect, it } from "vitest";
import { UI_LOCALES } from "../../../web/src/lib/ui-locale";
import {
  isShippedLanguage,
  OUTPUT_LANGUAGE_NAME,
  SHIPPED_LANGUAGES,
  toShippedLanguage,
} from "../shipped-languages.js";

describe("SHIPPED_LANGUAGES", () => {
  it("is exactly English, Korean and Simplified Chinese", () => {
    expect([...SHIPPED_LANGUAGES]).toEqual(["en", "ko", "zh"]);
  });

  it("matches the web app's UI_LOCALES", () => {
    expect([...UI_LOCALES]).toEqual([...SHIPPED_LANGUAGES]);
  });

  it("names an output language for every shipped code", () => {
    expect(OUTPUT_LANGUAGE_NAME).toEqual({
      en: "English",
      ko: "Korean",
      zh: "Simplified Chinese",
    });
  });
});

describe("toShippedLanguage", () => {
  it.each(["en", "ko", "zh"])("keeps %s", (code) => {
    expect(toShippedLanguage(code)).toBe(code);
  });

  it.each([
    ["ko-KR", "ko"],
    ["zh-Hans", "zh"],
    ["zh_Hans", "zh"],
    ["zh-TW", "zh"],
    ["ZH-cn", "zh"],
    [" en-US ", "en"],
  ])("folds the regional tag %s onto %s", (raw, expected) => {
    expect(toShippedLanguage(raw)).toBe(expected);
  });

  it.each([
    "ja",
    "es",
    "fr",
    "de",
    "ja-JP",
    "pt-BR",
    "",
    "nonsense",
  ])("reads the unshipped %s as English", (raw) => {
    expect(toShippedLanguage(raw)).toBe("en");
  });

  it("reads null, undefined and non-strings as English", () => {
    expect(toShippedLanguage(null)).toBe("en");
    expect(toShippedLanguage(undefined)).toBe("en");
    expect(toShippedLanguage(42 as unknown as string)).toBe("en");
  });
});

describe("isShippedLanguage", () => {
  it("accepts only the bare shipped codes", () => {
    expect(isShippedLanguage("zh")).toBe(true);
    expect(isShippedLanguage("zh-Hans")).toBe(false);
    expect(isShippedLanguage("ja")).toBe(false);
    expect(isShippedLanguage(undefined)).toBe(false);
  });
});
