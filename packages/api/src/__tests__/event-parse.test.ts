import { beforeEach, describe, expect, it, vi } from "vitest";

// Voice→calendar structuring: free text ("내일 3시 김대표 미팅") → a draft the
// client prefILLS into the New event modal. Parsing only — never writes.

const createCompletion = vi.fn();
vi.mock("../openai.js", () => ({
  createCompletion: (...args: unknown[]) => createCompletion(...args),
  JUDGE_MODEL: "google/gemini-2.5-flash",
}));

vi.mock("../llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(async () => ({ userModel: "anthropic/claude-sonnet-5" })),
}));

const captureError = vi.fn();
vi.mock("../sentry.js", () => ({ captureError: (...args: unknown[]) => captureError(...args) }));

const getUserTimeZone = vi.fn(async () => "Asia/Seoul");
vi.mock("../user-timezone.js", () => ({
  getUserTimeZone: (...args: unknown[]) => getUserTimeZone(...args),
}));

import { parseEventText } from "../event-parse.js";

function llmJson(obj: unknown) {
  return {
    choices: [{ message: { role: "assistant", content: JSON.stringify(obj) } }],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  };
}

const NOW = new Date("2026-07-06T10:00:00+09:00");

beforeEach(() => {
  createCompletion.mockReset();
  captureError.mockClear();
  getUserTimeZone.mockReset();
  getUserTimeZone.mockResolvedValue("Asia/Seoul");
});

describe("parseEventText", () => {
  it("returns the structured event from the model", async () => {
    createCompletion.mockResolvedValueOnce(
      llmJson({
        title: "김대표 미팅",
        startTime: "2026-07-07T15:00:00+09:00",
        endTime: "2026-07-07T16:00:00+09:00",
        location: "강남",
      }),
    );

    const event = await parseEventText("u1", "내일 3시 강남에서 김대표 미팅", NOW);
    expect(event).toEqual({
      title: "김대표 미팅",
      startTime: "2026-07-07T15:00:00+09:00",
      endTime: "2026-07-07T16:00:00+09:00",
      location: "강남",
    });
  });

  it("anchors the prompt to the provided now (relative dates resolvable)", async () => {
    createCompletion.mockResolvedValueOnce(
      llmJson({
        title: "x",
        startTime: "2026-07-07T15:00:00+09:00",
        endTime: "2026-07-07T16:00:00+09:00",
      }),
    );

    await parseEventText("u1", "내일 3시 미팅", NOW);

    const params = createCompletion.mock.calls[0]?.[0] as {
      model: string;
      messages: { role: string; content: string }[];
    };
    const promptText = params.messages.map((m) => m.content).join("\n");
    expect(promptText).toContain("2026-07-06");
    // Structuring rides the measured pin, NOT the user's chat model.
    expect(params.model).toBe("google/gemini-2.5-flash");
    const options = createCompletion.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.useUserModel).toBeUndefined();
  });

  it("anchors relative dates to the USER's timezone, not a hardcoded Asia/Seoul (#756)", async () => {
    // NOW is 2026-07-06 10:00 KST = 2026-07-05 21:00 in America/New_York.
    // A New-York user's "tomorrow" must resolve against 07-05, not Seoul's 07-06.
    getUserTimeZone.mockResolvedValue("America/New_York");
    createCompletion.mockResolvedValueOnce(
      llmJson({
        title: "x",
        startTime: "2026-07-06T15:00:00-04:00",
        endTime: "2026-07-06T16:00:00-04:00",
      }),
    );

    await parseEventText("u1", "tomorrow 3pm meeting", NOW);

    const params = createCompletion.mock.calls[0]?.[0] as {
      messages: { role: string; content: string }[];
    };
    const promptText = params.messages.map((m) => m.content).join("\n");
    expect(promptText).toContain("2026-07-05");
    expect(promptText).not.toContain("2026-07-06");
    expect(promptText).toContain("America/New_York");
    expect(promptText).toContain("-04:00 offset");
  });

  it("returns null when the model reports unparseable", async () => {
    createCompletion.mockResolvedValueOnce(llmJson({ unparseable: true }));
    expect(await parseEventText("u1", "으으음 그러니까", NOW)).toBeNull();
  });

  it("returns null (and captures) on malformed model output", async () => {
    createCompletion.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "not json at all" } }],
    });
    expect(await parseEventText("u1", "내일 미팅", NOW)).toBeNull();
    expect(captureError).toHaveBeenCalled();
  });

  it("returns null when datetimes are invalid", async () => {
    createCompletion.mockResolvedValueOnce(
      llmJson({ title: "미팅", startTime: "not-a-date", endTime: "2026-07-07T16:00:00+09:00" }),
    );
    expect(await parseEventText("u1", "내일 미팅", NOW)).toBeNull();
  });

  it("propagates LLM transport failures to the caller", async () => {
    createCompletion.mockRejectedValueOnce(new Error("provider down"));
    await expect(parseEventText("u1", "내일 미팅", NOW)).rejects.toThrow("provider down");
  });
});
