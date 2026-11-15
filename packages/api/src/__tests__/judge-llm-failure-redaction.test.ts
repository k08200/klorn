/**
 * A failed judge call carries no provider message to Sentry or the log.
 *
 * The mail judge catches whatever createCompletion throws: the exhausted-chain
 * wrapper (its `cause` is the provider's own error, which Sentry follows), a
 * raw provider error, or a JSON.parse failure quoting the model's reply. Any of
 * these can quote the mail being judged. The judge used to log the cause
 * chain's text on every attempt and hand Sentry the raw error on the last.
 *
 * The playground's onLlmError callback still gets the provider's words: it
 * shows a visitor the failure of the key and sample they supplied themselves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());
const captureError = vi.hoisted(() => vi.fn());

vi.mock("../llm/openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/openai.js")>();
  return { ...actual, createCompletion: createCompletionMock };
});
vi.mock("../sentry.js", () => ({ captureError }));

import { __resetJudgeCache } from "../judge/judge-cache.js";
import { EMPTY_JUDGE_CONTEXT, judgeEmail } from "../judge/poc-judge.js";
import { AllProvidersExhaustedError } from "../llm/openai.js";

const CANARY = "CANARY-judged-mail-51be";
/** JSON.parse quotes only the first characters of its input. */
const CANARY_PREFIX = CANARY.slice(0, 7);

const EMAIL = {
  from: "Dana Lee <dana@partner.example>",
  subject: "Contract redline",
  snippet: "Can you look at clause 4 before Friday?",
  body: "Can you look at clause 4 before Friday? The indemnity cap changed.",
};

function consoleSpies() {
  return [
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "log").mockImplementation(() => {}),
  ];
}

function consoleText(spies: ReturnType<typeof consoleSpies>): string {
  return spies
    .flatMap((spy) => spy.mock.calls.flat())
    .map((arg) => (arg instanceof Error ? `${String(arg)} ${String(arg.cause)}` : String(arg)))
    .join("\n");
}

function sentryText(): string {
  return JSON.stringify(
    captureError.mock.calls.map(([err, ctx]) => [
      String(err),
      (err as Error)?.message,
      String((err as Error)?.cause ?? ""),
      (err as Error)?.stack,
      ctx,
    ]),
  );
}

function judgeSentryCall() {
  const call = captureError.mock.calls.find(([, ctx]) => ctx?.tags?.scope === "poc-judge.llm");
  expect(call, "no poc-judge.llm Sentry event").toBeDefined();
  return call as [Error, { tags: Record<string, string>; extra: Record<string, unknown> }];
}

describe("judgeEmail — LLM failure reporting", () => {
  let spies: ReturnType<typeof consoleSpies>;

  beforeEach(() => {
    __resetJudgeCache();
    createCompletionMock.mockReset();
    captureError.mockReset();
    spies = consoleSpies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an exhausted chain is reported by class, status and type, not by the cause's words", async () => {
    const cause = Object.assign(new Error(`429 rate limited near: ${CANARY}`), {
      status: 429,
      type: "rate_limit_error",
    });
    createCompletionMock.mockRejectedValue(
      new AllProvidersExhaustedError("All AI providers are unavailable right now.", { cause }),
    );
    const onLlmError = vi.fn();

    await judgeEmail(EMAIL, "user-1", EMPTY_JUDGE_CONTEXT, undefined, undefined, onLlmError);

    const [err, ctx] = judgeSentryCall();
    expect(err.cause).toBeUndefined();
    expect(ctx.extra).toMatchObject({
      errorName: "AllProvidersExhaustedError",
      status: 429,
      providerErrorType: "rate_limit_error",
    });
    expect(sentryText()).not.toContain(CANARY);
    expect(consoleText(spies)).toContain("[JUDGE] LLM feature extraction attempt");
    expect(consoleText(spies)).not.toContain(CANARY);
    // The playground's own-key message is unchanged.
    expect(onLlmError).toHaveBeenCalledWith(expect.stringContaining("429 rate limited"));
  });

  it("a reply that is not JSON is reported without quoting the reply", async () => {
    // JSON.parse's message quotes the start of its input, so the canary leads.
    createCompletionMock.mockResolvedValue({
      choices: [{ message: { content: `${CANARY}: the mail asks for clause 4` } }],
    });

    await judgeEmail(EMAIL, "user-1", EMPTY_JUDGE_CONTEXT);

    const [, ctx] = judgeSentryCall();
    expect(ctx.extra).toMatchObject({ errorName: "SyntaxError" });
    expect(sentryText()).not.toContain(CANARY_PREFIX);
    expect(consoleText(spies)).not.toContain(CANARY_PREFIX);
  });
});
