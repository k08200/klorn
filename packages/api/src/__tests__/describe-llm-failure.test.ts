import Anthropic from "@anthropic-ai/sdk";
import { AuthenticationError, BadRequestError, InternalServerError, RateLimitError } from "openai";
import { describe, expect, it } from "vitest";
import {
  describeLlmFailure,
  formatLlmFailureFacts,
  llmFailureFacts,
} from "../llm/describe-failure.js";
import { AllProvidersExhaustedError } from "../llm/openai.js";

/**
 * The regression this file pins: every OpenAI-SDK error reported as "Error".
 *
 * The SDK's error classes extend Error without assigning `name`, so `err.name`
 * is the inherited "Error" for a 401 dead key, a 400 bad request and a 503
 * upstream alike. The reply-draft route surfaced exactly that string, and the
 * founder spent a day unable to tell a dead key from a code fault (2026-08-10).
 */
describe("describeLlmFailure", () => {
  it("reports the HTTP status for an SDK error whose name is the useless inherited 'Error'", () => {
    const err = new AuthenticationError(401, { error: { message: "x" } }, "x", undefined);

    // Guard the premise: if the SDK ever starts setting `name`, this assertion
    // fails and the helper below can be simplified away.
    expect(err.name).toBe("Error");
    expect(describeLlmFailure(err)).toBe("AuthenticationError 401");
  });

  it("distinguishes a bad request from a dead key", () => {
    const bad = new BadRequestError(400, { error: { message: "x" } }, "x", undefined);
    const upstream = new InternalServerError(503, { error: { message: "x" } }, "x", undefined);

    expect(describeLlmFailure(bad)).toBe("BadRequestError 400");
    expect(describeLlmFailure(upstream)).toBe("InternalServerError 503");
  });

  it("keeps a real, self-assigned error name and adds no status", () => {
    expect(describeLlmFailure(new AllProvidersExhaustedError("all down"))).toBe(
      "AllProvidersExhaustedError",
    );
  });

  it("falls back to UnknownError for a non-Error throw", () => {
    expect(describeLlmFailure("boom")).toBe("UnknownError");
    expect(describeLlmFailure(undefined)).toBe("UnknownError");
  });

  it("surfaces no provider message — only the class and status are safe to echo", () => {
    const err = new AuthenticationError(
      401,
      { error: { message: "sk-or-v1-SECRET rejected" } },
      "sk-or-v1-SECRET rejected",
      undefined,
    );

    expect(describeLlmFailure(err)).not.toContain("SECRET");
  });
});

/**
 * What a failover signal may tell Sentry and the log about a provider failure.
 * A provider's message can quote the request — someone's mail, Slack or
 * KakaoTalk text on a BYOK call — so the facts are the class, the status, the
 * provider's machine-readable type and code, and the message's length.
 */
describe("llmFailureFacts", () => {
  const CANARY = "CANARY-mail-body-7f3a";

  it("reads the type and stable code off an Anthropic SDK error, never its message", () => {
    const err = new Anthropic.RateLimitError(
      429,
      {
        type: "error",
        error: {
          type: "rate_limit_error",
          message: `Too many tokens in: ${CANARY}`,
          details: { error_code: "output_tokens_per_minute" },
        },
      },
      `429 Too many tokens in: ${CANARY}`,
      new Headers(),
    );

    const facts = llmFailureFacts(err);

    expect(facts).toEqual({
      errorName: "RateLimitError",
      status: 429,
      providerErrorType: "rate_limit_error",
      providerErrorCode: "output_tokens_per_minute",
      messageLength: err.message.length,
    });
    expect(JSON.stringify(facts)).not.toContain(CANARY);
  });

  it("reads code and type off an OpenAI SDK error", () => {
    const err = new RateLimitError(
      429,
      { message: CANARY, type: "insufficient_quota", code: "insufficient_quota" },
      CANARY,
      new Headers(),
    );

    expect(llmFailureFacts(err)).toMatchObject({
      errorName: "RateLimitError",
      status: 429,
      providerErrorType: "insufficient_quota",
      providerErrorCode: "insufficient_quota",
    });
  });

  it("falls back to the cause for a wrapper such as the Anthropic credit-limit 402", () => {
    const cause = new Anthropic.BadRequestError(
      400,
      { type: "error", error: { type: "invalid_request_error", message: CANARY } },
      CANARY,
      new Headers(),
    );
    const wrapper = Object.assign(new Error(`402 credit exhausted — ${CANARY}`, { cause }), {
      name: "AnthropicCreditExhaustedError",
      status: 402,
    });

    const facts = llmFailureFacts(wrapper);

    expect(facts).toMatchObject({
      errorName: "AnthropicCreditExhaustedError",
      status: 402,
      providerErrorType: "invalid_request_error",
      providerErrorCode: null,
    });
    expect(JSON.stringify(facts)).not.toContain(CANARY);
  });

  it("drops a type or code that is free text rather than an enum-like token", () => {
    const err = Object.assign(new Error("boom"), {
      status: 400,
      type: `quoted: ${CANARY}`,
      code: "x".repeat(200),
    });

    expect(llmFailureFacts(err)).toMatchObject({
      providerErrorType: null,
      providerErrorCode: null,
    });
  });

  it("describes a non-Error throw without reading it", () => {
    expect(llmFailureFacts(CANARY)).toEqual({
      errorName: "UnknownError",
      status: null,
      providerErrorType: null,
      providerErrorCode: null,
      messageLength: 0,
    });
  });

  it("formats the facts as one log fragment with no message text", () => {
    const err = Object.assign(new Error(CANARY), { status: 429, type: "rate_limit_error" });

    const line = formatLlmFailureFacts(llmFailureFacts(err));

    expect(line).toBe(`Error 429, type=rate_limit_error, message ${CANARY.length} chars`);
    expect(line).not.toContain(CANARY);
  });
});
