/**
 * Billing dates (packages/web/src/lib/subscription.ts formatBillingDate) are
 * shown inside translated sentences — "The subscription ends on {date}" on
 * Settings → Team and Settings → Billing — so the date speaks the reader's
 * language too. It used to fall back to US English for every locale but
 * Korean, which put "Dec 14, 2026" inside German or Japanese copy.
 */

import { describe, expect, it } from "vitest";
import type { Locale } from "../../../web/src/lib/i18n";
import { formatBillingDate } from "../../../web/src/lib/subscription";

const LOCALES: readonly Locale[] = ["en", "ko", "ja", "zh", "es", "fr", "de"];
// Midday UTC: the same calendar day in every time zone the tests run in.
const ISO = "2026-12-14T12:00:00.000Z";
const OPTIONS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };

describe("billing dates in the reader's locale", () => {
  it("formats the date in each of the seven UI locales", () => {
    for (const locale of LOCALES) {
      expect(formatBillingDate(ISO, locale), locale).toBe(
        new Intl.DateTimeFormat(locale, OPTIONS).format(new Date(ISO)),
      );
    }
  });

  it("no longer answers US English for the non-English locales", () => {
    const english = formatBillingDate(ISO, "en");
    expect(english).toBe("Dec 14, 2026");
    for (const locale of LOCALES.filter((l) => l !== "en")) {
      expect(formatBillingDate(ISO, locale), locale).not.toBe(english);
    }
  });

  it("still answers null for a missing or unparseable date", () => {
    expect(formatBillingDate(null, "de")).toBeNull();
    expect(formatBillingDate(undefined, "ja")).toBeNull();
    expect(formatBillingDate("not a date", "fr")).toBeNull();
  });
});
