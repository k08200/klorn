import { describe, expect, it } from "vitest";
import { createTranslator } from "../../i18n";
import { en } from "../../i18n/locales/en";
import { ko } from "../../i18n/locales/ko";
import {
  lengthText,
  parseIsoPeriod,
  planLabel,
  planNameKey,
  pricePerText,
  subscriptionLengthOf,
} from "./plans-model";

describe("subscription length (App Store 3.1.2)", () => {
  it("reads RevenueCat's package type, else the ISO period", () => {
    expect(subscriptionLengthOf("MONTHLY", null)).toEqual({ unit: "month", count: 1 });
    expect(subscriptionLengthOf("ANNUAL", "P1M")).toEqual({ unit: "year", count: 1 });
    expect(subscriptionLengthOf("CUSTOM", "P1Y")).toEqual({ unit: "year", count: 1 });
    expect(subscriptionLengthOf("CUSTOM", "P3M")).toEqual({ unit: "month", count: 3 });
    expect(subscriptionLengthOf("LIFETIME", null)).toBeNull();
    expect(parseIsoPeriod("P7D")).toEqual({ unit: "week", count: 1 });
    expect(parseIsoPeriod("P12M")).toEqual({ unit: "year", count: 1 });
    expect(parseIsoPeriod("P3D")).toBeNull();
    expect(parseIsoPeriod("garbage")).toBeNull();
  });

  it("writes the length and the price per period", () => {
    const k = createTranslator("ko", ko);
    const e = createTranslator("en", en);
    const say = (tr: typeof k, x: ReturnType<typeof lengthText>) => tr.t(x.key, x.values);
    expect(say(k, lengthText({ unit: "month", count: 1 }))).toBe("1개월");
    expect(say(e, lengthText({ unit: "year", count: 1 }))).toBe("1 year");
    expect(say(e, lengthText({ unit: "month", count: 6 }))).toBe("6 months");
    expect(say(k, pricePerText({ unit: "month", count: 1 }, "₩14,000"))).toBe("월 ₩14,000");
    expect(say(e, pricePerText({ unit: "year", count: 1 }, "$99.99"))).toBe("$99.99 per year");
    expect(say(e, pricePerText({ unit: "month", count: 3 }, "$29.99"))).toBe(
      "$29.99 every 3 months",
    );
  });
});

describe("planNameKey (the plan row never shows a raw code)", () => {
  it("maps the server's plan codes and display names alike", () => {
    expect(planNameKey("FREE")).toBe("plans.name.free");
    expect(planNameKey("Free")).toBe("plans.name.free");
    expect(planNameKey("PRO")).toBe("plans.name.pro");
    expect(planNameKey("Team")).toBe("plans.name.team");
    expect(planNameKey("ENTERPRISE")).toBe("plans.name.enterprise");
  });

  it("leaves a name it does not know alone", () => {
    expect(planNameKey("Founders")).toBeNull();
    expect(planNameKey("constructor")).toBeNull();
    expect(planNameKey("")).toBeNull();
    expect(planNameKey(undefined)).toBeNull();
  });

  it("reads Free in the app's language", () => {
    const key = planNameKey("FREE");
    if (!key) throw new Error("expected a key");
    expect(createTranslator("en", en).t(key)).toBe("Free");
    expect(createTranslator("ko", ko).t(key)).toBe("무료");
  });

  it("labels a plan in the app's language, else as the server sent it", () => {
    const koT = createTranslator("ko", ko);
    expect(planLabel((k) => koT.t(k), "FREE")).toBe("무료");
    expect(planLabel((k) => koT.t(k), "Pro")).toBe("Pro");
    expect(planLabel((k) => koT.t(k), "Founders")).toBe("Founders");
    expect(planLabel((k) => koT.t(k), undefined)).toBeUndefined();
  });
});
