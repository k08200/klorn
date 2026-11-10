import { AuthenticationError, BadRequestError, InternalServerError } from "openai";
import { describe, expect, it } from "vitest";
import { describeLlmFailure } from "../llm/describe-failure.js";
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
