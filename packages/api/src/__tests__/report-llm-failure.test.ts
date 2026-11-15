/**
 * The shared reporting path for LLM failures: what Sentry and the console may
 * carry when a model call, or the parse of its reply, fails.
 *
 * A provider error can quote the request (someone's mail, Slack or KakaoTalk
 * text on a BYOK call), a Gemini error carries the raw response body, an
 * exhausted chain carries the provider error as `cause` (Sentry and Node both
 * follow it), and JSON.parse's SyntaxError quotes the start of the model's
 * reply. None of that may leave; the class, status, provider code and an
 * operator label may.
 */
import Anthropic from "@anthropic-ai/sdk";
import { RateLimitError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { isLlmFailure, llmFailureFacts } from "../llm/describe-failure.js";
import { AllProvidersExhaustedError } from "../llm/openai.js";
import { captureLlmFailure, logLlmFailure } from "../llm/report-llm-failure.js";
import { DataWipeFenceError } from "../privacy/data-wipe-fence.js";
import { captureError } from "../sentry.js";
import { callText, LLM_CANARY, reachableText } from "./helpers/canary.js";

function rateLimited(): RateLimitError {
  return new RateLimitError(
    429,
    { message: `quota exceeded for: ${LLM_CANARY}`, type: "rate_limit_error" },
    `429 quota exceeded for: ${LLM_CANARY}`,
    new Headers(),
  );
}

function exhaustedOver(cause: unknown): AllProvidersExhaustedError {
  return new AllProvidersExhaustedError("All AI providers are unavailable", { cause });
}

function geminiHttp(status: number, body: string): Error {
  return Object.assign(new Error(`Gemini ${status}: ${body}`), {
    name: `GeminiHttp${status}Error`,
    status,
  });
}

function syntaxErrorOfReply(): SyntaxError {
  try {
    JSON.parse(`${LLM_CANARY} is what the model said`);
  } catch (err) {
    return err as SyntaxError;
  }
  throw new Error("JSON.parse accepted a non-JSON reply");
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(captureError).mockClear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe("the canary premise", () => {
  it("is carried by every failure shape the reporters receive", () => {
    // If a shape stopped carrying the canary, the tests below would pass
    // vacuously.
    expect(reachableText(rateLimited())).toContain(LLM_CANARY);
    expect(reachableText(exhaustedOver(rateLimited()))).toContain(LLM_CANARY);
    expect(reachableText(geminiHttp(400, LLM_CANARY))).toContain(LLM_CANARY);
    expect(reachableText(syntaxErrorOfReply())).toContain(LLM_CANARY);
  });
});

describe("captureLlmFailure", () => {
  const shapes: Array<[string, () => unknown]> = [
    ["an SDK error quoting the request", rateLimited],
    ["an exhausted chain over it (cause)", () => exhaustedOver(rateLimited())],
    ["a Gemini error carrying the response body", () => geminiHttp(400, LLM_CANARY)],
    ["JSON.parse's SyntaxError quoting the reply", syntaxErrorOfReply],
    ["a thrown string", () => `raw ${LLM_CANARY}`],
  ];

  it.each(shapes)("sends Sentry no provider or model text for %s", (_label, make) => {
    captureLlmFailure("[TEST] model call failed", make(), {
      tags: { scope: "test.scope" },
      extra: { emailId: "e1" },
    });

    expect(captureError).toHaveBeenCalledTimes(1);
    expect(callText(vi.mocked(captureError))).not.toContain(LLM_CANARY);
  });

  it("keeps the scope tag and caller context, and adds the failure facts", () => {
    const err = exhaustedOver(rateLimited());

    captureLlmFailure("[TEST] model call failed", err, {
      tags: { scope: "test.scope", userId: "u1" },
      extra: { emailId: "e1", provider: "anthropic" },
    });

    const [sent, context] = vi.mocked(captureError).mock.calls[0] ?? [];
    expect(sent).toBeInstanceOf(Error);
    expect((sent as Error).message).toBe("[TEST] model call failed (AllProvidersExhaustedError)");
    expect((sent as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(context).toEqual({
      tags: { scope: "test.scope", userId: "u1" },
      extra: { emailId: "e1", provider: "anthropic", ...llmFailureFacts(err) },
    });
  });

  it("does not let caller extras overwrite the facts", () => {
    captureLlmFailure("[TEST] model call failed", rateLimited(), {
      tags: { scope: "test.scope" },
      extra: { status: "spoofed" },
    });

    const context = vi.mocked(captureError).mock.calls[0]?.[1];
    expect(context?.extra?.status).toBe(429);
  });

  it("keeps the throw site's stack frames, without the message", () => {
    function failingModelCall(): never {
      throw Object.assign(new Error(`429 quota exceeded for:\n${LLM_CANARY}`), { status: 429 });
    }
    let thrown: unknown;
    try {
      failingModelCall();
    } catch (err) {
      thrown = err;
    }

    captureLlmFailure("[TEST] model call failed", thrown, { tags: { scope: "test.scope" } });

    const sent = vi.mocked(captureError).mock.calls[0]?.[0] as Error;
    expect(sent.stack?.split("\n")[0]).toBe("Error: [TEST] model call failed (Error)");
    expect(sent.stack).toContain("failingModelCall");
    expect(sent.stack).not.toContain(LLM_CANARY);
  });

  it("drops the frames when message lines that look like frames cannot be told apart", () => {
    const err = new Error(`provider said:\n    at ${LLM_CANARY} (/srv/app.js:1:1)`);
    void err.stack; // V8 writes the header now, from this message
    err.message = "rewritten after the stack was read";

    captureLlmFailure("[TEST] model call failed", err, { tags: { scope: "test.scope" } });

    expect(callText(vi.mocked(captureError))).not.toContain(LLM_CANARY);
  });

  it("strips a multi-line message whose lines look like frames", () => {
    const err = new Error(`provider said:\n    at ${LLM_CANARY} (/srv/app.js:1:1)`);

    captureLlmFailure("[TEST] model call failed", err, { tags: { scope: "test.scope" } });

    expect(callText(vi.mocked(captureError))).not.toContain(LLM_CANARY);
  });

  it("skips a data-wipe fence rejection, as captureError does for the raw error", () => {
    captureLlmFailure("[TEST] model call failed", new DataWipeFenceError(), {
      tags: { scope: "test.scope" },
    });

    expect(captureError).not.toHaveBeenCalled();
  });
});

describe("logLlmFailure", () => {
  it.each([
    ["warn", () => warn],
    ["error", () => error],
  ] as const)("prints the label and the facts at %s, never the message", (level, spy) => {
    logLlmFailure("[TEST] model call failed", exhaustedOver(rateLimited()), { level });

    expect(spy()).toHaveBeenCalledTimes(1);
    const line = String(spy().mock.calls[0]?.[0]);
    expect(line).toBe(
      "[TEST] model call failed: AllProvidersExhaustedError 429, cause=RateLimitError, type=rate_limit_error, message 32 chars",
    );
    expect(spy().mock.calls[0]).toHaveLength(1);
    expect(callText(warn) + callText(error)).not.toContain(LLM_CANARY);
  });

  it("names the row ids it is given", () => {
    logLlmFailure("[TEST] model call failed", rateLimited(), {
      ids: { userId: "u1", emailId: null },
    });

    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /^\[TEST\] model call failed \(userId=u1, emailId=-\): RateLimitError 429, /,
    );
    expect(callText(warn)).not.toContain(LLM_CANARY);
  });

  it("defaults to warn", () => {
    logLlmFailure("[TEST] model call failed", syntaxErrorOfReply());

    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(callText(warn)).not.toContain(LLM_CANARY);
  });
});

describe("isLlmFailure", () => {
  it.each([
    ["an OpenAI SDK error", rateLimited()],
    [
      "an Anthropic SDK error",
      new Anthropic.BadRequestError(
        400,
        { type: "error", error: { type: "invalid_request_error", message: "x" } },
        "x",
        new Headers(),
      ),
    ],
    ["a Gemini HTTP error", geminiHttp(429, "{}")],
    ["an exhausted chain", exhaustedOver(new Error("x"))],
    ["a wrapper whose cause is an SDK error", new Error("402 credit", { cause: rateLimited() })],
    ["JSON.parse's SyntaxError", syntaxErrorOfReply()],
  ])("recognizes %s", (_label, err) => {
    expect(isLlmFailure(err)).toBe(true);
  });

  it.each([
    ["a plain Error", new Error("boom")],
    ["a TypeError", new TypeError("x is undefined")],
    ["a database error", Object.assign(new Error("Unique constraint"), { code: "P2002" })],
    ["a string", "boom"],
    ["null", null],
  ])("leaves %s alone", (_label, err) => {
    expect(isLlmFailure(err)).toBe(false);
  });
});

describe("llmFailureFacts, defense in depth", () => {
  it("drops a provider code that is shaped like a credential", () => {
    const geminiKey = `AIzaSy${"Q".repeat(33)}`;
    const err = Object.assign(new Error("x"), { status: 400, code: geminiKey });

    const facts = llmFailureFacts(err);

    expect(facts.providerErrorCode).toBeNull();
    expect(JSON.stringify(facts)).not.toContain(geminiKey);
  });
});
