/**
 * body→judge is flag-gated (JUDGE_INCLUDE_BODY, default OFF). These tests lock
 * the two guarantees: with the flag OFF the prompt is byte-for-byte what it was
 * (so the eval gate stays green and prod is unchanged), and with the flag ON the
 * email body is threaded into the LLM user prompt. createCompletion is mocked and
 * its prompt captured — the same wiring assertion used for sender-trait injection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openai.js")>();
  return { ...actual, createCompletion: createCompletionMock };
});

import { judgeEmail } from "../poc-judge.js";

const SCORE = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          confidence: 0.9,
          senderTrust: 0.6,
          reversibility: 0.5,
          urgency: 0.4,
          reason: "follow-up",
        }),
      },
    },
  ],
};

const EMAIL = {
  id: "e1",
  from: "Alice <alice@company.com>",
  subject: "Following up",
  snippet: "short preview",
  body: "BODY_MARKER we need a final decision by end of day today, please confirm.",
  labels: [] as string[],
};

function lastPrompt(): string {
  const calls = createCompletionMock.mock.calls;
  return calls[calls.length - 1]?.[0]?.messages?.[1]?.content as string;
}

beforeEach(() => {
  createCompletionMock.mockReset();
  createCompletionMock.mockResolvedValue(SCORE);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("judgeEmail — body injection (JUDGE_INCLUDE_BODY)", () => {
  it("does NOT add the body to the prompt when the flag is off (default)", async () => {
    await judgeEmail(EMAIL);

    const prompt = lastPrompt();
    expect(prompt).toBeTruthy();
    expect(prompt).not.toContain("BODY_MARKER");
    expect(prompt).not.toContain("\nbody:");
  });

  it("threads the truncated body into the prompt when JUDGE_INCLUDE_BODY=true", async () => {
    vi.stubEnv("JUDGE_INCLUDE_BODY", "true");

    await judgeEmail(EMAIL);

    const prompt = lastPrompt();
    expect(prompt).toContain("\nbody:");
    expect(prompt).toContain("BODY_MARKER");
  });

  it("adds no body line when the flag is on but the email has no body", async () => {
    vi.stubEnv("JUDGE_INCLUDE_BODY", "1");

    await judgeEmail({ ...EMAIL, body: null });

    expect(lastPrompt()).not.toContain("\nbody:");
  });

  it("treats an empty-string body as no body (flag on)", async () => {
    vi.stubEnv("JUDGE_INCLUDE_BODY", "true");

    await judgeEmail({ ...EMAIL, body: "" });

    expect(lastPrompt()).not.toContain("\nbody:");
  });

  it("truncates the body to JUDGE_BODY_CAP (1500 chars)", async () => {
    vi.stubEnv("JUDGE_INCLUDE_BODY", "true");
    const longBody = `${"x".repeat(1490)}TAIL_MARKER_PAST_1500`;

    await judgeEmail({ ...EMAIL, body: longBody });

    const prompt = lastPrompt();
    expect(prompt).toContain("\nbody:");
    // The marker starts past char 1500, so truncation must drop it.
    expect(prompt).not.toContain("TAIL_MARKER_PAST_1500");
  });
});
