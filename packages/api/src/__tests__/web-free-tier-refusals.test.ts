// What a FREE user sees when the paywall is on: a paid route's 403
// ENTITLEMENT_REQUIRED becomes an upgrade notice, the assistant's daily cap
// becomes a localized line, and BYOK copy stops promising a key FREE cannot
// store. Run from the api suite because the web package has no unit-test
// runner (see web-auth-surfaces.test.ts).
import { describe, expect, it } from "vitest";
import { capCodeForMessage, capTurnFrom, dailyCapNotice } from "../../../web/src/lib/daily-cap";
import {
  byokLocked,
  isByokEntitlementRefusal,
  isEntitlementRefusal,
  isEntitlementResponse,
} from "../../../web/src/lib/entitlement";
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";

/** The Error apiFetch throws for a non-2xx answer. */
const apiError = (status: number, body: string) => new Error(`API ${status}: ${body}`);

const REFUSAL = JSON.stringify({
  error: "An active subscription is required to use this feature.",
  code: "ENTITLEMENT_REQUIRED",
});
const LEGACY_BYOK = JSON.stringify({ error: "BYOK requires an active subscription" });

describe("isEntitlementRefusal", () => {
  it("is true for a 403 whose body carries code ENTITLEMENT_REQUIRED", () => {
    expect(isEntitlementRefusal(apiError(403, REFUSAL))).toBe(true);
  });

  it("accepts the message string too, as the mail-account sections pass it", () => {
    expect(isEntitlementRefusal(`API 403: ${REFUSAL}`)).toBe(true);
  });

  it("is false for any other status, even with the code", () => {
    expect(isEntitlementRefusal(apiError(429, REFUSAL))).toBe(false);
    expect(isEntitlementRefusal(apiError(401, REFUSAL))).toBe(false);
  });

  it("is false for a 403 without the code (ownership, CSRF, read-only mirror)", () => {
    expect(isEntitlementRefusal(apiError(403, JSON.stringify({ error: "Forbidden" })))).toBe(false);
    expect(isEntitlementRefusal(apiError(403, "<html>Forbidden</html>"))).toBe(false);
    expect(isEntitlementRefusal(apiError(403, ""))).toBe(false);
  });

  it("is false for anything that is not an apiFetch error", () => {
    expect(isEntitlementRefusal(new TypeError("Failed to fetch"))).toBe(false);
    expect(isEntitlementRefusal(null)).toBe(false);
    expect(isEntitlementRefusal(undefined)).toBe(false);
    expect(isEntitlementRefusal({ code: "ENTITLEMENT_REQUIRED" })).toBe(false);
  });
});

describe("isEntitlementResponse (raw fetch callers)", () => {
  it("matches a parsed 403 body with the code", () => {
    expect(isEntitlementResponse(403, JSON.parse(REFUSAL))).toBe(true);
  });

  it("rejects another status, a body without the code, or no body", () => {
    expect(isEntitlementResponse(400, JSON.parse(REFUSAL))).toBe(false);
    expect(isEntitlementResponse(403, { error: "Forbidden" })).toBe(false);
    expect(isEntitlementResponse(403, null)).toBe(false);
  });
});

describe("isByokEntitlementRefusal", () => {
  it("matches the coded refusal", () => {
    expect(isByokEntitlementRefusal(apiError(403, REFUSAL))).toBe(true);
  });

  it("matches the older API's uncoded BYOK refusal", () => {
    expect(isByokEntitlementRefusal(apiError(403, LEGACY_BYOK))).toBe(true);
  });

  it("does not match a rejected key or another 403", () => {
    const rejected = JSON.stringify({ error: "That OpenRouter key was rejected by the provider." });
    expect(isByokEntitlementRefusal(apiError(400, rejected))).toBe(false);
    expect(isByokEntitlementRefusal(apiError(403, JSON.stringify({ error: "Forbidden" })))).toBe(
      false,
    );
  });
});

describe("byokLocked", () => {
  it("locks the key input only when the server says the user is not entitled", () => {
    expect(byokLocked({ entitled: false })).toBe(true);
  });

  it("stays open while the paywall is off, for an entitled user, or an older API", () => {
    expect(byokLocked({ entitled: true })).toBe(false);
    expect(byokLocked({})).toBe(false);
    expect(byokLocked(null)).toBe(false);
  });
});

describe("dailyCapNotice", () => {
  it("offers the upgrade only for the free cap", () => {
    expect(dailyCapNotice("DAILY_COST_CAP_FREE")).toEqual({
      messageKey: "dailyCap.free",
      upgrade: true,
    });
    expect(dailyCapNotice("DAILY_COST_CAP")).toEqual({
      messageKey: "dailyCap.paid",
      upgrade: false,
    });
  });

  it("is null when the field is absent or unknown (older API keeps today's bubble)", () => {
    expect(dailyCapNotice(undefined)).toBeNull();
    expect(dailyCapNotice(null)).toBeNull();
    expect(dailyCapNotice("RATE_LIMITED")).toBeNull();
  });
});

describe("capTurnFrom", () => {
  it("keeps the code and the reply a capped turn answered with", () => {
    expect(capTurnFrom({ reply: "cap message", errorCode: "DAILY_COST_CAP_FREE" })).toEqual({
      code: "DAILY_COST_CAP_FREE",
      reply: "cap message",
    });
  });

  it("is null for a normal turn or an older API without errorCode", () => {
    expect(capTurnFrom({ reply: "hello" })).toBeNull();
    expect(capTurnFrom({ reply: "hello", errorCode: "SOMETHING_ELSE" })).toBeNull();
    expect(capTurnFrom(undefined)).toBeNull();
  });
});

describe("capCodeForMessage", () => {
  const assistant = (content: string, metadata: Record<string, unknown> | null = null) => ({
    role: "ASSISTANT" as const,
    content,
    metadata,
  });
  const capTurn = { code: "DAILY_COST_CAP_FREE" as const, reply: "cap message" };

  it("marks the persisted assistant bubble that carries the capped turn's reply", () => {
    expect(capCodeForMessage(assistant("cap message"), capTurn)).toBe("DAILY_COST_CAP_FREE");
  });

  it("leaves every other bubble alone", () => {
    expect(capCodeForMessage(assistant("a normal answer"), capTurn)).toBeNull();
    expect(
      capCodeForMessage({ role: "USER", content: "cap message", metadata: null }, capTurn),
    ).toBe(null);
    expect(capCodeForMessage(assistant("cap message"), null)).toBeNull();
  });

  it("reads a code persisted on the message, so a reload keeps the localized line", () => {
    expect(capCodeForMessage(assistant("anything", { errorCode: "DAILY_COST_CAP" }), null)).toBe(
      "DAILY_COST_CAP",
    );
    expect(capCodeForMessage(assistant("anything", { errorCode: "NOPE" }), null)).toBeNull();
  });
});

const LOCALES = { de, en, es, fr, ja, ko, zh } as const;

describe("free-tier copy", () => {
  const NEW_KEYS = [
    "proFeature.title",
    "proFeature.upgrade",
    "proFeature.byok",
    "proFeature.drive",
    "dailyCap.free",
    "dailyCap.paid",
    "byok.bodyFree",
    "byok.assistantModelHelpFree",
    "candidates.qualityIssues.oneFailedFree",
    "candidates.qualityIssues.manyFailedFree",
    "calendar.error.delete",
    "billing.plan.free.feature.oneAccount",
    "billing.plan.free.feature.briefings",
    "billing.plan.pro.feature.calendarWrites",
    "billing.plan.pro.feature.moreAccounts",
    "billing.plan.pro.feature.autoReply",
    "billing.plan.pro.feature.byok",
  ];

  it("every new key exists in every locale", () => {
    for (const [code, table] of Object.entries(LOCALES)) {
      for (const key of NEW_KEYS) {
        expect(table[key], `${code} ${key}`).toBeTruthy();
      }
    }
  });

  it("FREE-facing BYOK copy never tells the user to add their own key", () => {
    for (const key of [
      "byok.bodyFree",
      "byok.assistantModelHelpFree",
      "candidates.qualityIssues.oneFailedFree",
      "candidates.qualityIssues.manyFailedFree",
    ]) {
      expect(en[key]).not.toMatch(/add your own/i);
    }
  });

  it("plan cards claim no monthly decision or token quota nobody enforces", () => {
    for (const table of Object.values(LOCALES)) {
      expect(table["billing.plan.free.limit"]).not.toMatch(/50|500/);
      expect(table["billing.plan.pro.limit"]).not.toMatch(/2K|10M|2,000/);
      expect(table["billing.faq.freeVsPro.a"]).not.toMatch(/500K|10M/);
    }
  });

  it("drops the plan lines that contradict how models are served now", () => {
    for (const key of [
      "billing.plan.free.feature.freeModels",
      "billing.plan.pro.feature.sonnet",
      "billing.plan.pro.feature.decisionLoop",
      "billing.plan.pro.feature.briefings",
      "billing.plan.pro.feature.webResearch",
    ]) {
      expect(en[key], key).toBeUndefined();
    }
  });

  it("no longer promises a founding price locked in for new signups", () => {
    for (const table of Object.values(LOCALES)) {
      expect(table["paywall.foundingPrice"]).toBeUndefined();
      expect(table["paywall.trialTerms"]).toBeUndefined();
    }
  });
});
