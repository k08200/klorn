import { describe, expect, it } from "vitest";
import { redactQuotaKey } from "../openai.js";

describe("redactQuotaKey", () => {
  it("strips a user UUID after :user: so chat errors do not leak the inbox owner", () => {
    expect(redactQuotaKey("openrouter:user:82e753f2-3e5e-4b73-8473-2a6e7c649a3f")).toBe(
      "openrouter:user",
    );
    expect(redactQuotaKey("gemini:user:abc123")).toBe("gemini:user");
  });

  it("leaves env-scoped quota keys alone — those name a shared key, not a user", () => {
    expect(redactQuotaKey("openrouter:env")).toBe("openrouter:env");
    expect(redactQuotaKey("gemini:env")).toBe("gemini:env");
  });

  it("only strips the immediate user-id segment, not anything that happens to follow", () => {
    expect(redactQuotaKey("openrouter:user:abc:extra")).toBe("openrouter:user:extra");
  });
});
