import { describe, expect, it } from "vitest";
import { redactQuotaKey } from "../llm/openai.js";

describe("redactQuotaKey", () => {
  it("strips a user UUID after :user: so chat errors do not leak the inbox owner", () => {
    expect(redactQuotaKey("anthropic:user:82e753f2-3e5e-4b73-8473-2a6e7c649a3f")).toBe(
      "anthropic:user",
    );
    expect(redactQuotaKey("gemini:user:abc123")).toBe("gemini:user");
  });

  it("leaves env-scoped quota keys alone — those name a shared key, not a user", () => {
    expect(redactQuotaKey("anthropic:env")).toBe("anthropic:env");
    expect(redactQuotaKey("gemini:env")).toBe("gemini:env");
  });

  it("only strips the immediate user-id segment, not anything that happens to follow", () => {
    expect(redactQuotaKey("anthropic:user:abc:extra")).toBe("anthropic:user:extra");
  });
});
