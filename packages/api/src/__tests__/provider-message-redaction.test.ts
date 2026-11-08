/**
 * redactProviderMessage — the masked key shapes the old pattern let through.
 *
 * The operator log deliberately keeps a provider's wording verbatim (that is
 * what made the 2026-08 judge outage diagnosable), so the redactor standing in
 * front of it is the only thing between a provider's 401 body and
 * console.warn + captureError (judge/poc-judge.ts:530-534). Its old
 * /sk-[A-Za-z0-9_-]{8,}/ could not match OpenAI's masked echo form and had no
 * pattern for Google keys at all.
 */

import { describe, expect, it } from "vitest";
import { redactProviderMessage } from "../llm/model-fallback.js";

describe("redactProviderMessage", () => {
  it("redacts OpenAI's masked echo form", () => {
    const out = redactProviderMessage(
      new Error("401 Incorrect API key provided: sk-proj-****************abcd"),
    );
    expect(out).not.toContain("abcd");
  });

  it("redacts an unmasked OpenAI project key", () => {
    const out = redactProviderMessage(new Error("bad key sk-proj-AbCd1234EfGh5678IjKl"));
    expect(out).not.toContain("AbCd1234EfGh5678IjKl");
  });

  it("redacts a Google AIza… key — previously only the playground route knew this shape", () => {
    const out = redactProviderMessage(
      new Error("API key not valid: AIzaSyA0123456789abcdefghijklmnopqrstu"),
    );
    expect(out).not.toContain("SyA0123456789");
  });

  it("redacts a Google AQ.… key", () => {
    const out = redactProviderMessage(new Error("auth failed for AQ.Ab8RN6J0123456789abcdefghij"));
    expect(out).not.toContain("Ab8RN6J0123456789");
  });

  it("redacts a key riding in a request URL", () => {
    const out = redactProviderMessage(
      new Error(
        "fetch failed: https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=AQ.Ab8RN6Jsecret",
      ),
    );
    expect(out).not.toContain("AQ.Ab8RN6Jsecret");
  });

  it("still keeps the provider's actual wording — that is why this text is logged at all", () => {
    expect(
      redactProviderMessage(new Error("429 rate limit exceeded: 10 requests per minute")),
    ).toBe("429 rate limit exceeded: 10 requests per minute");
  });

  it("still redacts the legacy bearer and sk- forms it already handled", () => {
    expect(
      redactProviderMessage(new Error("Authorization: Bearer abcdef1234567890")),
    ).not.toContain("abcdef1234567890");
    expect(redactProviderMessage(new Error("sk-or-v1-supersecret-do-not-leak"))).not.toContain(
      "supersecret",
    );
  });

  it("still caps a giant provider body", () => {
    const out = redactProviderMessage(new Error("x".repeat(500)));
    expect(out?.length).toBeLessThanOrEqual(201);
  });

  it("still returns null for an empty message", () => {
    expect(redactProviderMessage(new Error(""))).toBeNull();
  });
});
