import { beforeEach, describe, expect, it, vi } from "vitest";

// The chat surface is locked to Klorn features: only whitelisted read tools
// reach the model, create_event becomes a confirm-card draft (never executed),
// and anything else — including a hallucinated send_email — is refused
// fail-closed without touching executeToolCall.

const createCompletion = vi.fn();
vi.mock("../llm/openai.js", () => ({
  createCompletion: (...args: unknown[]) => createCompletion(...args),
  AGENT_MODEL: "pinned/agent-model",
}));

const executeToolCall = vi.fn(async () => JSON.stringify({ ok: true }));
vi.mock("../agentcore/tool-executor.js", () => ({
  executeToolCall: (...args: unknown[]) => executeToolCall(...args),
  ALL_TOOLS: [
    "list_emails",
    "read_email",
    "classify_emails",
    "send_email",
    "mark_read",
    "list_events",
    "create_event",
    "delete_event",
    "check_calendar_conflicts",
    "generate_briefing",
    "get_current_time",
    "remember",
    "calculate",
  ].map((name) => ({
    type: "function" as const,
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  })),
}));

vi.mock("../llm/llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(async () => ({ userModel: "anthropic/claude-sonnet-5" })),
}));

const trackTokenUsage = vi.fn(async () => {});
vi.mock("../billing/token-usage.js", () => ({
  trackTokenUsage: (...args: unknown[]) => trackTokenUsage(...args),
}));

const captureError = vi.fn();
vi.mock("../sentry.js", () => ({ captureError: (...args: unknown[]) => captureError(...args) }));

import { CHAT_TOOL_NAMES, runChatTurn } from "../agentcore/chat-engine.js";

function textResponse(content: string) {
  return {
    choices: [{ message: { role: "assistant", content, tool_calls: undefined } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function toolCallResponse(name: string, args: Record<string, unknown>, id = "call-1") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

beforeEach(() => {
  createCompletion.mockReset();
  executeToolCall.mockClear();
  trackTokenUsage.mockClear();
  captureError.mockClear();
});

describe("CHAT_TOOL_NAMES", () => {
  it("contains exactly the Klorn-scoped surface", () => {
    expect([...CHAT_TOOL_NAMES].sort()).toEqual(
      [
        "check_calendar_conflicts",
        "classify_emails",
        "create_event",
        "generate_briefing",
        "get_current_time",
        "list_emails",
        "list_events",
        "read_email",
      ].sort(),
    );
  });
});

describe("runChatTurn", () => {
  it("hands the model only whitelisted tools", async () => {
    createCompletion.mockResolvedValueOnce(textResponse("hello"));
    await runChatTurn({ userId: "u1", history: [], userText: "hi" });

    const params = createCompletion.mock.calls[0]?.[0] as {
      tools: { function: { name: string } }[];
    };
    const names = params.tools.map((t) => t.function.name);
    expect(names).toContain("list_emails");
    expect(names).toContain("get_current_time");
    expect(names).not.toContain("send_email");
    expect(names).not.toContain("mark_read");
    expect(names).not.toContain("delete_event");
    expect(names).not.toContain("remember");
    expect(names).not.toContain("calculate");
  });

  it("uses the user's conversational model (useUserModel)", async () => {
    createCompletion.mockResolvedValueOnce(textResponse("hello"));
    await runChatTurn({ userId: "u1", history: [], userText: "hi" });

    expect(createCompletion.mock.calls[0]?.[0]).toMatchObject({
      model: "anthropic/claude-sonnet-5",
    });
    expect(createCompletion.mock.calls[0]?.[1]).toMatchObject({
      userId: "u1",
      useUserModel: true,
      priority: "foreground",
    });
  });

  it("refuses a non-whitelisted tool call fail-closed without executing it", async () => {
    createCompletion
      .mockResolvedValueOnce(
        toolCallResponse("send_email", { to: "a@b.c", subject: "x", body: "y" }),
      )
      .mockResolvedValueOnce(textResponse("I cannot send email from chat."));

    const result = await runChatTurn({ userId: "u1", history: [], userText: "send it" });

    expect(executeToolCall).not.toHaveBeenCalled();
    expect(result.reply).toBe("I cannot send email from chat.");
  });

  it("executes whitelisted read tools via executeToolCall", async () => {
    createCompletion
      .mockResolvedValueOnce(toolCallResponse("list_emails", { max_results: 5, query: "from:kim" }))
      .mockResolvedValueOnce(textResponse("You have 5 emails from Kim."));

    const result = await runChatTurn({ userId: "u1", history: [], userText: "find kim mail" });

    expect(executeToolCall).toHaveBeenCalledWith("u1", "list_emails", {
      max_results: 5,
      query: "from:kim",
    });
    expect(result.reply).toBe("You have 5 emails from Kim.");
  });

  it("intercepts create_event into an eventDraft and never executes it", async () => {
    createCompletion
      .mockResolvedValueOnce(
        toolCallResponse("create_event", {
          summary: "김대표 미팅",
          start_time: "2026-07-07T15:00:00+09:00",
          end_time: "2026-07-07T16:00:00+09:00",
          location: "강남",
        }),
      )
      .mockResolvedValueOnce(textResponse("일정 초안을 확인해 주세요."));

    const result = await runChatTurn({
      userId: "u1",
      history: [],
      userText: "내일 3시 김대표 미팅",
    });

    expect(executeToolCall).not.toHaveBeenCalled();
    expect(result.eventDraft).toEqual({
      title: "김대표 미팅",
      startTime: "2026-07-07T15:00:00+09:00",
      endTime: "2026-07-07T16:00:00+09:00",
      location: "강남",
    });
    expect(result.reply).toBe("일정 초안을 확인해 주세요.");
  });

  it("drops a create_event draft with invalid args instead of crashing", async () => {
    createCompletion
      .mockResolvedValueOnce(toolCallResponse("create_event", { summary: "미팅" }))
      .mockResolvedValueOnce(textResponse("시간을 알려주세요."));

    const result = await runChatTurn({ userId: "u1", history: [], userText: "미팅 잡아줘" });

    expect(result.eventDraft).toBeNull();
    expect(result.reply).toBe("시간을 알려주세요.");
  });

  it("stops after 3 LLM rounds even if the model keeps calling tools", async () => {
    createCompletion.mockResolvedValue(toolCallResponse("list_events", { max_results: 5 }));

    const result = await runChatTurn({ userId: "u1", history: [], userText: "loop" });

    expect(createCompletion).toHaveBeenCalledTimes(3);
    expect(typeof result.reply).toBe("string");
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it("returns an error result (not a throw) when the LLM fails", async () => {
    createCompletion.mockRejectedValueOnce(new Error("provider down"));

    const result = await runChatTurn({ userId: "u1", history: [], userText: "hi" });

    expect(result.error).toContain("provider down");
    expect(result.eventDraft).toBeNull();
    expect(result.reply.length).toBeGreaterThan(0);
    expect(captureError).toHaveBeenCalled();
  });

  it("keeps a failing tool from killing the turn", async () => {
    executeToolCall.mockRejectedValueOnce(new Error("gmail 500"));
    createCompletion
      .mockResolvedValueOnce(toolCallResponse("list_emails", {}))
      .mockResolvedValueOnce(textResponse("Sorry, mail lookup failed."));

    const result = await runChatTurn({ userId: "u1", history: [], userText: "mail?" });

    expect(result.reply).toBe("Sorry, mail lookup failed.");
    expect(result.error).toBeUndefined();
  });
});
