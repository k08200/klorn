import { describe, expect, it } from "vitest";
import { isKeyLimitError } from "../model-fallback.js";

describe("model fallback error classification", () => {
  it("treats provider 429s as quota/rate-limit errors", () => {
    expect(isKeyLimitError({ status: 429, message: "Provider returned error" })).toBe(true);
    expect(isKeyLimitError(new Error("429 Provider returned error"))).toBe(true);
  });

  it("keeps generic 403 auth failures out of quota fallback", () => {
    expect(isKeyLimitError({ status: 403, message: "Invalid API key" })).toBe(false);
    expect(isKeyLimitError(new Error("403 Forbidden"))).toBe(false);
  });
});
