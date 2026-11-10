import { describe, expect, it } from "vitest";
import { normalizeTimeZoneMode, parseTimeZoneInput } from "../time-zone.js";

describe("parseTimeZoneInput (client-supplied zone validation)", () => {
  it("accepts real IANA names and returns them trimmed", () => {
    expect(parseTimeZoneInput("Asia/Seoul")).toBe("Asia/Seoul");
    expect(parseTimeZoneInput("  America/Los_Angeles ")).toBe("America/Los_Angeles");
    expect(parseTimeZoneInput("UTC")).toBe("UTC");
    expect(parseTimeZoneInput("America/Argentina/Buenos_Aires")).toBe(
      "America/Argentina/Buenos_Aires",
    );
  });

  it("rejects names Intl does not know", () => {
    expect(parseTimeZoneInput("Mars/Olympus_Mons")).toBeNull();
    expect(parseTimeZoneInput("not/a-zone")).toBeNull();
  });

  it("rejects raw offsets, which are not IANA zones", () => {
    expect(parseTimeZoneInput("+09:00")).toBeNull();
    expect(parseTimeZoneInput("-0700")).toBeNull();
  });

  it("rejects non-strings, empty and oversized input", () => {
    expect(parseTimeZoneInput(undefined)).toBeNull();
    expect(parseTimeZoneInput(null)).toBeNull();
    expect(parseTimeZoneInput(9)).toBeNull();
    expect(parseTimeZoneInput("")).toBeNull();
    expect(parseTimeZoneInput("   ")).toBeNull();
    expect(parseTimeZoneInput(`Asia/${"x".repeat(80)}`)).toBeNull();
  });

  it("rejects the client's 'auto' sentinel — it is a mode, not a zone", () => {
    expect(parseTimeZoneInput("auto")).toBeNull();
  });
});

describe("normalizeTimeZoneMode", () => {
  it("reads null/undefined/unknown as AUTO (no saved choice)", () => {
    expect(normalizeTimeZoneMode(null)).toBe("AUTO");
    expect(normalizeTimeZoneMode(undefined)).toBe("AUTO");
    expect(normalizeTimeZoneMode("weird")).toBe("AUTO");
    expect(normalizeTimeZoneMode("AUTO")).toBe("AUTO");
  });

  it("keeps an explicit manual choice", () => {
    expect(normalizeTimeZoneMode("MANUAL")).toBe("MANUAL");
  });
});
