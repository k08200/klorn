/**
 * Shipped-language contract. The type system already forces every copy table
 * to carry every language (that is what `Record<NotificationLanguage, …>` and
 * `satisfies` buy). What tsc cannot see is the RUNTIME behaviour a user
 * actually meets: regional tags folding onto a shipped base, unshipped codes
 * degrading to English instead of rendering blanks, and no table entry left
 * as an untranslated copy of the English string.
 */

import { describe, expect, it } from "vitest";
import { STATIC_TIER_REASONS } from "../judge/tier-reason-strings.js";
import {
  NOTIFICATION_LANGUAGES,
  notificationCopy,
  resolveNotificationLanguage,
  URGENT_EMAIL_TITLES,
} from "../notify/notification-strings.js";

describe("shipped languages", () => {
  it("ships the seven launch languages", () => {
    expect([...NOTIFICATION_LANGUAGES]).toEqual(["en", "ko", "ja", "zh", "es", "fr", "de"]);
  });

  it("folds regional tags onto a shipped base and degrades the rest to English", () => {
    expect(resolveNotificationLanguage("zh-Hans")).toBe("zh");
    expect(resolveNotificationLanguage("zh_TW")).toBe("zh");
    expect(resolveNotificationLanguage("ja-JP")).toBe("ja");
    expect(resolveNotificationLanguage("es-419")).toBe("es");
    expect(resolveNotificationLanguage("DE")).toBe("de");
    // Not shipped → English, never a blank or a throw.
    expect(resolveNotificationLanguage("pt-BR")).toBe("en");
    expect(resolveNotificationLanguage(null)).toBe("en");
    expect(resolveNotificationLanguage("")).toBe("en");
  });

  it("gives every language real copy, not an English placeholder", () => {
    const en = notificationCopy("en");
    for (const lang of NOTIFICATION_LANGUAGES) {
      const copy = notificationCopy(lang);
      expect(copy.unknownSender.trim()).not.toBe("");
      expect(copy.newMail.trim()).not.toBe("");
      // Every tool the English table names must exist in this language too.
      for (const tool of Object.keys(en.tools)) {
        expect(copy.tools[tool]?.title.trim()).toBeTruthy();
      }
      if (lang === "en") continue;
      // A table copied from English wholesale is a missing translation that
      // type-checks. The digest sentence is the canary: it is long enough
      // that a genuine translation cannot coincide with the English one.
      expect(copy.urgentDigest(3, "Alice", "Subject")).not.toBe(
        en.urgentDigest(3, "Alice", "Subject"),
      );
    }
  });

  it("translates the urgent-mail title and the no-subject stand-in into every language", () => {
    const en = notificationCopy("en");
    expect(en.urgentMailTitle).toBe("Urgent email");
    expect(en.noSubject).toBe("(no subject)");
    for (const lang of NOTIFICATION_LANGUAGES) {
      if (lang === "en") continue;
      const copy = notificationCopy(lang);
      expect(copy.urgentMailTitle.trim(), lang).not.toBe("");
      expect(copy.urgentMailTitle, lang).not.toBe(en.urgentMailTitle);
      expect(copy.noSubject, lang).not.toBe(en.noSubject);
    }
  });

  it("dedupes urgent mail by every title it was ever written under", () => {
    // The legacy titles keep rows written before localization counting.
    expect(URGENT_EMAIL_TITLES).toContain("Urgent email");
    expect(URGENT_EMAIL_TITLES).toContain("긴급 이메일");
    for (const lang of NOTIFICATION_LANGUAGES) {
      expect(URGENT_EMAIL_TITLES).toContain(notificationCopy(lang).urgentMailTitle);
    }
    expect(new Set(URGENT_EMAIL_TITLES).size).toBe(URGENT_EMAIL_TITLES.length);
  });

  it("translates every static tier reason into every language", () => {
    for (const [key, byLang] of Object.entries(STATIC_TIER_REASONS)) {
      for (const lang of NOTIFICATION_LANGUAGES) {
        const text = (byLang as Record<string, string>)[lang];
        expect(text, `${key}.${lang}`).toBeTruthy();
        if (lang === "en") continue;
        expect(text, `${key}.${lang} is still the English string`).not.toBe(
          (byLang as Record<string, string>).en,
        );
      }
    }
  });
});
