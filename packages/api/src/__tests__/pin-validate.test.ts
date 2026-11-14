/**
 * validateTierPin (mail/pin-validate.ts), shared by every pin writer and the
 * Rules DSL: a value longer than an RFC 5321 path is refused BEFORE any
 * regular expression runs, so a megabyte value posted to /rules/pins cannot
 * hold the event loop (the address/domain patterns are quadratic on a
 * crafted failing input).
 */

import { describe, expect, it } from "vitest";
import { PIN_VALUE_MAX_CHARS, validateTierPin } from "../mail/pin-validate.js";

function cpuMs(fn: () => void): number {
  const started = process.cpuUsage();
  fn();
  const { user, system } = process.cpuUsage(started);
  return (user + system) / 1000;
}

describe("validateTierPin length cap", () => {
  it("is the RFC 5321 path limit", () => {
    expect(PIN_VALUE_MAX_CHARS).toBe(254);
  });

  it("refuses an over-long value with too-long, for both scopes", () => {
    const long = `${"a".repeat(250)}@b.co`;
    expect(validateTierPin({ scope: "sender", value: long, tier: "PUSH" })).toMatchObject({
      code: "too-long",
    });
    expect(
      validateTierPin({ scope: "domain", value: `${"a".repeat(255)}.co`, tier: "PUSH" }),
    ).toMatchObject({ code: "too-long" });
  });

  it("refuses a value that only grows past the limit when lowercased", () => {
    const value = `${"İ".repeat(130)}@x.com`;
    expect(validateTierPin({ scope: "sender", value, tier: "PUSH" })).toMatchObject({
      code: "too-long",
    });
  });

  it("answers a crafted megabyte value in bounded time", () => {
    const evil = `a@${".".repeat(1_000_000)} x`;
    let result: ReturnType<typeof validateTierPin> | undefined;
    const ms = cpuMs(() => {
      result = validateTierPin({ scope: "sender", value: evil, tier: "PUSH" });
      validateTierPin({ scope: "domain", value: evil, tier: "PUSH" });
    });
    expect(result).toMatchObject({ code: "too-long" });
    expect(ms).toBeLessThan(200);
  });

  it("stays fast on the worst input under the cap", () => {
    const evil = `a@${".".repeat(240)} x`;
    expect(
      cpuMs(() => validateTierPin({ scope: "sender", value: evil, tier: "PUSH" })),
    ).toBeLessThan(50);
  });

  it("still accepts a normal address and domain", () => {
    expect(validateTierPin({ scope: "sender", value: " Boss@X.co ", tier: "PUSH" })).toEqual({
      ok: { scope: "sender", value: "boss@x.co", tier: "PUSH" },
    });
    expect(validateTierPin({ scope: "domain", value: "@X.io", tier: "INFO" })).toEqual({
      ok: { scope: "domain", value: "x.io", tier: "INFO" },
    });
  });
});
