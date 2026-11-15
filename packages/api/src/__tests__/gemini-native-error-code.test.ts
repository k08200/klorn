/**
 * A Gemini HTTP error carries Google's machine-readable status as `code`, so
 * the failure facts tell a quota 429 (RESOURCE_EXHAUSTED) from another 429
 * without anyone reading the response body, which can quote the request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { llmFailureFacts } from "../llm/describe-failure.js";
import { createCompletionNonStreaming, geminiErrorStatus } from "../providers/gemini-native.js";
import { LLM_CANARY } from "./helpers/canary.js";

const QUOTA_BODY = JSON.stringify({
  error: {
    code: 429,
    message: `Quota exceeded while reading: ${LLM_CANARY}`,
    status: "RESOURCE_EXHAUSTED",
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("geminiErrorStatus", () => {
  it.each([
    ["an error envelope", QUOTA_BODY, "RESOURCE_EXHAUSTED"],
    ["the streaming endpoint's one-element array", `[${QUOTA_BODY}]`, "RESOURCE_EXHAUSTED"],
    ["a body without a status", JSON.stringify({ error: { code: 500 } }), null],
    ["a non-JSON body", "<html>Bad gateway</html>", null],
    ["an empty body", "", null],
  ])("reads %s", (_label, body, expected) => {
    expect(geminiErrorStatus(body)).toBe(expected);
  });
});

describe("a Gemini HTTP error", () => {
  it("exposes the status as its code, which the failure facts report without the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(QUOTA_BODY, { status: 429 })),
    );

    const err = await createCompletionNonStreaming(
      { model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] },
      "AQ.test-key",
    ).catch((caught: unknown) => caught);

    expect(err).toMatchObject({
      name: "GeminiHttp429Error",
      status: 429,
      code: "RESOURCE_EXHAUSTED",
    });
    const facts = llmFailureFacts(err);
    expect(facts).toMatchObject({
      errorName: "GeminiHttp429Error",
      status: 429,
      providerErrorCode: "RESOURCE_EXHAUSTED",
    });
    expect(JSON.stringify(facts)).not.toContain(LLM_CANARY);
  });
});
