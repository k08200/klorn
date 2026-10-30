/**
 * Native Anthropic adapter: OpenAI-chat-shape in, Messages API out, and back.
 *
 * The rest of the codebase speaks OpenAI chat.completions. These tests pin the
 * translation rules that keep the judge, the summarizer and the chat tool loop
 * working unchanged when Anthropic serves them:
 *  - response_format JSON → a forced tool call (Claude Haiku 5.5 rejects
 *    assistant prefill with a 400, and a forced tool skips thinking)
 *  - system prompts carry a cache breakpoint (prompt caching)
 *  - sampling params are dropped (Claude Haiku 5.5: "omit temperature, top_p")
 *  - usage is reported in the OpenAI shape the cost ledgers read
 *  - the prepaid-credit error becomes a 402 so failover treats it as credit
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";
import { isCreditError, isKeyLimitError } from "../llm/model-fallback.js";
import {
  ANTHROPIC_CONTENT,
  type AnthropicCallOptions,
  acceptsForcedToolChoice,
  buildAnthropicRequest,
  createAnthropicCompletion,
  DEFAULT_MAX_TOKENS,
  JSON_RESPONSE_TOOL,
  normalizeAnthropicError,
  readAnthropicCallOptions,
  streamAnthropicCompletion,
  THINKING_HEADROOM_TOKENS,
  toAnthropicModelId,
  toChatCompletion,
} from "../providers/anthropic-native.js";

const CACHE_5M: AnthropicCallOptions = { cacheTtl: "5m", effort: null };
const NO_CACHE: AnthropicCallOptions = { cacheTtl: null, effort: null };

// biome-ignore lint/suspicious/noExplicitAny: tests build loose OpenAI-shape params
type Loose = any;

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: "hello", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
      inference_geo: null,
      output_tokens_details: null,
    },
    ...overrides,
  } as unknown as Message;
}

describe("toAnthropicModelId", () => {
  it("passes native Claude ids through", () => {
    expect(toAnthropicModelId("claude-haiku-5-5", "fallback")).toBe("claude-haiku-5-5");
    expect(toAnthropicModelId("claude-haiku-4-5-20251001", "fallback")).toBe(
      "claude-haiku-4-5-20251001",
    );
  });

  it("translates OpenRouter-namespaced Claude ids to native ids", () => {
    expect(toAnthropicModelId("anthropic/claude-haiku-4.5", "fallback")).toBe("claude-haiku-4-5");
    expect(toAnthropicModelId("anthropic/claude-sonnet-5", "fallback")).toBe("claude-sonnet-5");
    expect(toAnthropicModelId("anthropic/claude-sonnet-5.5:beta", "fallback")).toBe(
      "claude-sonnet-5-5",
    );
  });

  it("serves any non-Claude pin with the provider's own model", () => {
    expect(toAnthropicModelId("google/gemini-2.5-flash", "claude-haiku-5-5")).toBe(
      "claude-haiku-5-5",
    );
    expect(toAnthropicModelId("", "claude-haiku-5-5")).toBe("claude-haiku-5-5");
  });
});

describe("readAnthropicCallOptions", () => {
  it("defaults to 5-minute prompt caching and no effort override", () => {
    expect(readAnthropicCallOptions({})).toEqual({
      cacheTtl: "5m",
      effort: null,
      forceJsonTool: true,
    });
  });

  it("accepts a 1h TTL, an off switch, and a valid effort", () => {
    expect(readAnthropicCallOptions({ ANTHROPIC_CACHE_TTL: "1h" }).cacheTtl).toBe("1h");
    expect(readAnthropicCallOptions({ ANTHROPIC_PROMPT_CACHE: "false" }).cacheTtl).toBeNull();
    expect(readAnthropicCallOptions({ ANTHROPIC_EFFORT: "low" }).effort).toBe("low");
  });

  it("ignores values the API would reject instead of 400ing every call", () => {
    expect(readAnthropicCallOptions({ ANTHROPIC_CACHE_TTL: "2h" }).cacheTtl).toBe("5m");
    expect(readAnthropicCallOptions({ ANTHROPIC_EFFORT: "turbo" }).effort).toBeNull();
  });
});

describe("buildAnthropicRequest", () => {
  it("moves system messages into a cached system block", () => {
    const { body } = buildAnthropicRequest(
      {
        model: "x",
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "hi" },
        ],
      } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    );
    expect(body.system).toEqual([
      { type: "text", text: "rules", cache_control: { type: "ephemeral" } },
    ]);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(body.model).toBe("claude-haiku-5-5");
  });

  it("sets the 1h TTL on the breakpoint when configured", () => {
    const { body } = buildAnthropicRequest(
      {
        model: "x",
        messages: [
          { role: "system", content: "a" },
          { role: "system", content: "b" },
          { role: "user", content: "hi" },
        ],
      } as Loose,
      "claude-haiku-5-5",
      { cacheTtl: "1h", effort: null },
    );
    // Only the FIRST system block carries the breakpoint. By convention it is
    // the stable prompt; later system blocks carry per-request context (the
    // chat engine's per-email view), which would never be re-read and would
    // only pay the write premium — and park mail-derived text in the cache.
    expect(body.system).toEqual([
      { type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "b" },
    ]);
  });

  it("adds no cache breakpoint when caching is off", () => {
    const { body } = buildAnthropicRequest(
      {
        model: "x",
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "hi" },
        ],
      } as Loose,
      "claude-haiku-5-5",
      NO_CACHE,
    );
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  it("drops sampling params and maps stop to stop_sequences", () => {
    const { body } = buildAnthropicRequest(
      {
        model: "x",
        temperature: 0,
        top_p: 0.9,
        stop: "END",
        messages: [{ role: "user", content: "hi" }],
      } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    );
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body.stop_sequences).toEqual(["END"]);
  });

  it("turns response_format json_object into a forced tool call, without thinking headroom", () => {
    const { body, jsonMode } = buildAnthropicRequest(
      {
        model: "x",
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: "score this" }],
      } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    );
    expect(jsonMode).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0]).toMatchObject({
      name: JSON_RESPONSE_TOOL,
      input_schema: { type: "object" },
    });
    expect(body.tool_choice).toEqual({ type: "tool", name: JSON_RESPONSE_TOOL });
    // A forced tool call starts with the tool call and has no thinking block,
    // so the caller's cap is the whole output budget.
    expect(body.max_tokens).toBe(1024);
  });

  it("uses the caller's schema for response_format json_schema", () => {
    const schema = { type: "object", properties: { a: { type: "number" } }, required: ["a"] };
    const { body } = buildAnthropicRequest(
      {
        model: "x",
        response_format: { type: "json_schema", json_schema: { name: "s", schema } },
        messages: [{ role: "user", content: "x" }],
      } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    );
    expect(body.tools?.[0]).toMatchObject({ name: JSON_RESPONSE_TOOL, input_schema: schema });
  });

  it("keeps the caller's tools and does not force JSON when both are present", () => {
    const { body, jsonMode } = buildAnthropicRequest(
      {
        model: "x",
        response_format: { type: "json_object" },
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
        messages: [{ role: "user", content: "x" }],
      } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    );
    expect(jsonMode).toBe(false);
    expect(body.tools?.map((t) => (t as { name: string }).name)).toEqual(["lookup"]);
  });

  it("adds thinking headroom to a plain text call (adaptive thinking counts toward max_tokens)", () => {
    const capped = buildAnthropicRequest(
      { model: "x", max_tokens: 500, messages: [{ role: "user", content: "x" }] } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    );
    expect(capped.body.max_tokens).toBe(500 + THINKING_HEADROOM_TOKENS);

    const uncapped = buildAnthropicRequest(
      { model: "x", messages: [{ role: "user", content: "x" }] } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    );
    expect(uncapped.body.max_tokens).toBe(DEFAULT_MAX_TOKENS + THINKING_HEADROOM_TOKENS);
  });

  it("maps OpenAI function tools and every tool_choice form", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_mail",
          description: "Read mail",
          parameters: { type: "object", properties: { id: { type: "string" } } },
        },
      },
    ];
    const build = (tool_choice: unknown, extra: Record<string, unknown> = {}) =>
      buildAnthropicRequest(
        {
          model: "x",
          tools,
          tool_choice,
          ...extra,
          messages: [{ role: "user", content: "x" }],
        } as Loose,
        "claude-haiku-5-5",
        CACHE_5M,
      ).body;

    expect(build("auto").tools).toEqual([
      {
        name: "get_mail",
        description: "Read mail",
        input_schema: { type: "object", properties: { id: { type: "string" } } },
      },
    ]);
    expect(build("auto").tool_choice).toEqual({ type: "auto" });
    expect(build("required").tool_choice).toEqual({ type: "any" });
    expect(build("none").tool_choice).toEqual({ type: "none" });
    expect(build({ type: "function", function: { name: "get_mail" } }).tool_choice).toEqual({
      type: "tool",
      name: "get_mail",
    });
    expect(build("auto", { parallel_tool_calls: false }).tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
    // A caller-forced tool also skips thinking — no headroom.
    expect(build("required", { max_tokens: 300 }).max_tokens).toBe(300);
  });

  it("round-trips an assistant tool call and its results into tool_use / tool_result blocks", () => {
    const { body } = buildAnthropicRequest(
      {
        model: "x",
        messages: [
          { role: "user", content: "what is on my calendar?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "toolu_1",
                type: "function",
                function: { name: "calendar", arguments: '{"day":"today"}' },
              },
              {
                id: "toolu_2",
                type: "function",
                function: { name: "mail", arguments: "not json" },
              },
            ],
          },
          { role: "tool", tool_call_id: "toolu_1", content: "2 meetings" },
          { role: "tool", tool_call_id: "toolu_2", content: "0 mails" },
        ],
      } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    );
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "what is on my calendar?" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "calendar", input: { day: "today" } },
          // Unparseable arguments must not crash the turn — an empty input does.
          { type: "tool_use", id: "toolu_2", name: "mail", input: {} },
        ],
      },
      {
        // Consecutive tool results share ONE user turn (the API alternates roles).
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "2 meetings" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "0 mails" },
        ],
      },
    ]);
  });

  it("replays an assistant turn verbatim when it carries the original Anthropic blocks", () => {
    const original = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "toolu_9", name: "calendar", input: {} },
    ];
    const assistant = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "toolu_9", type: "function", function: { name: "calendar", arguments: "{}" } },
      ],
      [ANTHROPIC_CONTENT]: original,
    };
    const { body } = buildAnthropicRequest(
      {
        model: "x",
        messages: [
          { role: "user", content: "x" },
          assistant,
          { role: "tool", tool_call_id: "toolu_9", content: "ok" },
        ],
      } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    );
    // Thinking blocks must go back unmodified with tool results.
    expect(body.messages[1]).toEqual({ role: "assistant", content: original });
  });

  it("converts image parts and merges consecutive user messages", () => {
    const { body } = buildAnthropicRequest(
      {
        model: "x",
        messages: [
          { role: "user", content: "first" },
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
              { type: "image_url", image_url: { url: "data:image/jpeg;name=a.jpg;base64,BBBB" } },
              // A remote URL would make Anthropic fetch it (tracking pixel /
              // signed-URL leak). Never forwarded; the model is told an image
              // was omitted rather than left to invent OCR output.
              { type: "image_url", image_url: { url: "https://example.com/a.jpg" } },
            ],
          },
        ],
      } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    );
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "what is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
          { type: "text", text: "[image omitted]" },
        ],
      },
    ]);
  });

  it("drops empty text blocks (the API rejects them)", () => {
    const { body } = buildAnthropicRequest(
      {
        model: "x",
        messages: [
          { role: "user", content: "x" },
          { role: "assistant", content: "" },
          { role: "user", content: "y" },
        ],
      } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    );
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "x" },
          { type: "text", text: "y" },
        ],
      },
    ]);
  });

  it("sends output_config.effort only when an effort is configured", () => {
    const params = { model: "x", messages: [{ role: "user", content: "x" }] } as Loose;
    expect(buildAnthropicRequest(params, "m", CACHE_5M).body).not.toHaveProperty("output_config");
    expect(
      buildAnthropicRequest(params, "m", { cacheTtl: "5m", effort: "low" }).body.output_config,
    ).toEqual({ effort: "low" });
  });
});

describe("toChatCompletion", () => {
  it("joins text blocks and ignores thinking blocks", () => {
    const completion = toChatCompletion(
      message({
        content: [
          { type: "thinking", thinking: "", signature: "s" },
          { type: "text", text: "Hello ", citations: null },
          { type: "text", text: "world", citations: null },
        ] as Message["content"],
      }),
      false,
    );
    expect(completion.choices[0].message.content).toBe("Hello world");
    expect(completion.choices[0].finish_reason).toBe("stop");
    expect(completion.object).toBe("chat.completion");
  });

  it("returns the forced JSON tool's input as the message content", () => {
    const completion = toChatCompletion(
      message({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t", name: JSON_RESPONSE_TOOL, input: { urgency: 0.9 } },
        ] as Message["content"],
      }),
      true,
    );
    expect(JSON.parse(completion.choices[0].message.content ?? "")).toEqual({ urgency: 0.9 });
    expect(completion.choices[0].message.tool_calls).toBeUndefined();
    expect(completion.choices[0].finish_reason).toBe("stop");
  });

  it("maps tool_use blocks to tool_calls and keeps the raw blocks off the wire", () => {
    const blocks = [
      { type: "text", text: "Checking.", citations: null },
      { type: "tool_use", id: "toolu_1", name: "calendar", input: { day: "today" } },
    ] as Message["content"];
    const completion = toChatCompletion(
      message({ stop_reason: "tool_use", content: blocks }),
      false,
    );
    const msg = completion.choices[0].message;
    expect(msg.content).toBe("Checking.");
    expect(msg.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "calendar", arguments: '{"day":"today"}' },
      },
    ]);
    expect(completion.choices[0].finish_reason).toBe("tool_calls");
    expect((msg as unknown as Record<symbol, unknown>)[ANTHROPIC_CONTENT]).toEqual(blocks);
    // A symbol key never reaches another provider's JSON request body.
    expect(JSON.stringify(msg)).not.toContain('toolu_1","name');
  });

  it("reports usage in the OpenAI shape, total input including cache reads and writes", () => {
    const completion = toChatCompletion(
      message({
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_creation_input_tokens: 700,
          cache_read_input_tokens: 1200,
          cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 200 },
        } as unknown as Message["usage"],
      }),
      false,
    );
    expect(completion.usage).toEqual({
      prompt_tokens: 2000,
      completion_tokens: 40,
      total_tokens: 2040,
      prompt_tokens_details: {
        cached_tokens: 1200,
        cache_write_tokens: 700,
        cache_write_1h_tokens: 200,
      },
    });
  });

  it("maps max_tokens to length and a refusal to content_filter with empty content", () => {
    expect(
      toChatCompletion(message({ stop_reason: "max_tokens" }), false).choices[0].finish_reason,
    ).toBe("length");
    const refused = toChatCompletion(message({ stop_reason: "refusal", content: [] }), false);
    expect(refused.choices[0].finish_reason).toBe("content_filter");
    expect(refused.choices[0].message.content).toBe("");
  });
});

describe("normalizeAnthropicError", () => {
  const creditBody = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    },
  };

  it("turns the prepaid-credit 400 into a 402 credit error", () => {
    const original = Anthropic.APIError.generate(400, creditBody, undefined, new Headers());
    const normalized = normalizeAnthropicError(original) as Error & { status: number };
    expect(normalized.status).toBe(402);
    expect(normalized.name).toBe("AnthropicCreditExhaustedError");
    expect(isCreditError(normalized)).toBe(true);
    expect(normalized.cause).toBe(original);
  });

  it("leaves rate limits and other errors untouched", () => {
    const limited = Anthropic.APIError.generate(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens" } },
      undefined,
      new Headers(),
    );
    expect(normalizeAnthropicError(limited)).toBe(limited);
    expect(isKeyLimitError(limited)).toBe(true);

    const badRequest = Anthropic.APIError.generate(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "max_tokens: too big" } },
      undefined,
      new Headers(),
    );
    expect(normalizeAnthropicError(badRequest)).toBe(badRequest);
  });
});

describe("createAnthropicCompletion (real SDK, fake transport)", () => {
  function clientReturning(status: number, body: unknown, seen: unknown[] = []) {
    return new Anthropic({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: (async (_url: string, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
  }

  it("sends the translated request and returns an OpenAI-shape completion", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = clientReturning(
      200,
      message({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t", name: JSON_RESPONSE_TOOL, input: { ok: true } },
        ] as Message["content"],
      }),
      seen,
    );
    const completion = await createAnthropicCompletion(
      client,
      {
        model: "google/gemini-2.5-flash",
        temperature: 0,
        max_tokens: 256,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Respond with JSON." },
          { role: "user", content: "x" },
        ],
      } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    );
    expect(completion.choices[0].message.content).toBe('{"ok":true}');
    expect(seen[0].model).toBe("claude-haiku-5-5");
    expect(seen[0]).not.toHaveProperty("temperature");
    expect(seen[0].max_tokens).toBe(256);
  });

  it("throws the normalized credit error so failover can act on it", async () => {
    const client = clientReturning(400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API.",
      },
    });
    await expect(
      createAnthropicCompletion(
        client,
        { model: "x", messages: [{ role: "user", content: "x" }] } as Loose,
        "claude-haiku-5-5",
        CACHE_5M,
      ),
    ).rejects.toMatchObject({ status: 402, name: "AnthropicCreditExhaustedError" });
  });
});

describe("streamAnthropicCompletion", () => {
  it("yields text deltas then a finish chunk", async () => {
    const events = [
      { type: "message_start", message: message({ content: [] }) },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "", citations: null },
      },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ];
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const client = new Anthropic({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: (async () =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })) as unknown as typeof fetch,
    });

    const chunks: Array<{ content?: string | null; finish: string | null }> = [];
    for await (const chunk of streamAnthropicCompletion(
      client,
      { model: "x", stream: true, messages: [{ role: "user", content: "x" }] } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    )) {
      chunks.push({
        content: chunk.choices[0].delta.content,
        finish: chunk.choices[0].finish_reason,
      });
    }
    expect(chunks).toEqual([
      { content: "Hel", finish: null },
      { content: "lo", finish: null },
      { content: undefined, finish: "stop" },
    ]);
  });
});

describe("models that reject a forced tool_choice (review fix)", () => {
  // platform.claude.com/docs/en/api/errors, "Forced tool use not supported":
  // Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1 400 on tool_choice any/tool.
  it.each([
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-fable-5-1",
    "claude-mythos-5-1",
  ])("%s: JSON mode asks for the tool with auto + an instruction, with thinking headroom", (model) => {
    const { body, jsonMode } = buildAnthropicRequest(
      {
        model: "x",
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Score it." },
          { role: "user", content: "x" },
        ],
      } as Loose,
      model,
      CACHE_5M,
    );
    expect(acceptsForcedToolChoice(model)).toBe(false);
    expect(jsonMode).toBe(true);
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.max_tokens).toBe(1024 + THINKING_HEADROOM_TOKENS);
    const system = body.system as Array<{ text: string }>;
    expect(system.at(-1)?.text).toContain(JSON_RESPONSE_TOOL);
  });

  it("downgrades a caller's forced choice to auto on those models", () => {
    const { body } = buildAnthropicRequest(
      {
        model: "x",
        tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }],
        tool_choice: "required",
        messages: [{ role: "user", content: "x" }],
      } as Loose,
      "claude-sonnet-5-5",
      CACHE_5M,
    );
    expect(body.tool_choice).toEqual({ type: "auto" });
  });

  it("still forces the tool on Haiku 5.5 (it accepts forced tool use)", () => {
    expect(acceptsForcedToolChoice("claude-haiku-5-5")).toBe(true);
    expect(acceptsForcedToolChoice("claude-sonnet-5")).toBe(true);
  });

  it("accepts a JSON answer written as text when the model skips the tool", () => {
    const completion = toChatCompletion(
      message({
        content: [{ type: "text", text: '{"a":1}', citations: null }] as Message["content"],
      }),
      true,
    );
    expect(completion.choices[0].message.content).toBe('{"a":1}');
  });

  it("retries once without forcing when an unknown model rejects the forced choice", async () => {
    const seen: Array<Record<string, unknown>> = [];
    let call = 0;
    const client = new Anthropic({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: (async (_url: string, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body ?? "{}")));
        call += 1;
        const body =
          call === 1
            ? {
                type: "error",
                error: {
                  type: "invalid_request_error",
                  message: 'tool_choice: type "tool" and "any" are not supported for this model.',
                },
              }
            : message({
                stop_reason: "tool_use",
                content: [
                  { type: "tool_use", id: "t", name: JSON_RESPONSE_TOOL, input: { ok: 1 } },
                ] as Message["content"],
              });
        return new Response(JSON.stringify(body), {
          status: call === 1 ? 400 : 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    const completion = await createAnthropicCompletion(
      client,
      {
        model: "x",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: "x" }],
      } as Loose,
      "claude-future-9",
      CACHE_5M,
    );
    expect(completion.choices[0].message.content).toBe('{"ok":1}');
    expect(seen.map((b) => (b.tool_choice as { type: string }).type)).toEqual(["tool", "auto"]);
  });
});

describe("silent-degradation guards (review fixes)", () => {
  it("returns no content for an empty JSON answer so the caller retries loudly", () => {
    const completion = toChatCompletion(
      message({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t", name: JSON_RESPONSE_TOOL, input: {} },
        ] as Message["content"],
      }),
      true,
    );
    expect(completion.choices[0].message.content).toBe("");
  });

  it("drops a tool call cut off by max_tokens instead of executing it with empty args", () => {
    const completion = toChatCompletion(
      message({
        stop_reason: "max_tokens",
        content: [
          { type: "tool_use", id: "toolu_1", name: "calendar", input: {} },
        ] as Message["content"],
      }),
      false,
    );
    expect(completion.choices[0].message.tool_calls).toBeUndefined();
    expect(completion.choices[0].finish_reason).toBe("length");
  });

  it.each([
    "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
    "You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
  ])("treats a spend-limit 400 as credit exhaustion: %s", (text) => {
    const original = Anthropic.APIError.generate(
      400,
      { type: "error", error: { type: "invalid_request_error", message: text } },
      undefined,
      new Headers(),
    );
    const normalized = normalizeAnthropicError(original) as Error & { status: number };
    expect(normalized.status).toBe(402);
    expect(isCreditError(normalized)).toBe(true);
  });

  it("refuses a streaming call that carries tools instead of dropping the tool calls", async () => {
    const client = new Anthropic({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
    });
    const stream = streamAnthropicCompletion(
      client,
      {
        model: "x",
        stream: true,
        tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }],
        messages: [{ role: "user", content: "x" }],
      } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    );
    await expect(
      (async () => {
        for await (const _ of stream) {
          // drain
        }
      })(),
    ).rejects.toThrow(/streaming.*tool/i);
  });
});

describe("ANTHROPIC_JSON_TOOL_CHOICE=auto (let the model think before answering)", () => {
  it("reads the switch; anything else keeps the forced default", () => {
    expect(readAnthropicCallOptions({ ANTHROPIC_JSON_TOOL_CHOICE: "auto" }).forceJsonTool).toBe(
      false,
    );
    expect(readAnthropicCallOptions({}).forceJsonTool).toBe(true);
    expect(readAnthropicCallOptions({ ANTHROPIC_JSON_TOOL_CHOICE: "bogus" }).forceJsonTool).toBe(
      true,
    );
  });

  it("asks for the JSON tool with tool_choice auto + thinking headroom even on Haiku 5.5", () => {
    const { body, jsonMode } = buildAnthropicRequest(
      {
        model: "x",
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Score it." },
          { role: "user", content: "x" },
        ],
      } as Loose,
      "claude-haiku-5-5",
      { cacheTtl: "5m", effort: null, forceJsonTool: false },
    );
    expect(jsonMode).toBe(true);
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.max_tokens).toBe(1024 + THINKING_HEADROOM_TOKENS);
  });

  it("leaves a caller's own tool_choice alone (the switch is about JSON mode only)", () => {
    const { body } = buildAnthropicRequest(
      {
        model: "x",
        tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }],
        tool_choice: "required",
        messages: [{ role: "user", content: "x" }],
      } as Loose,
      "claude-haiku-5-5",
      { cacheTtl: "5m", effort: null, forceJsonTool: false },
    );
    expect(body.tool_choice).toEqual({ type: "any" });
  });
});

describe("JSON tool answers wrapped in an extra key (measured: 12/55 Haiku calls with thinking)", () => {
  const answer = (input: unknown) =>
    toChatCompletion(
      message({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t", name: JSON_RESPONSE_TOOL, input },
        ] as Message["content"],
      }),
      true,
    ).choices[0].message.content;

  it("unwraps {input: {...}} — left wrapped, every expected key reads as missing and scores 0", () => {
    expect(JSON.parse(answer({ input: { urgency: 0.9, reason: "x" } }) ?? "")).toEqual({
      urgency: 0.9,
      reason: "x",
    });
  });

  it("unwraps a JSON string under a wrapper key", () => {
    expect(JSON.parse(answer({ json: '{"urgency":0.9}' }) ?? "")).toEqual({ urgency: 0.9 });
  });

  it("leaves a genuine single-key answer alone", () => {
    expect(JSON.parse(answer({ summary: { text: "hi" } }) ?? "")).toEqual({
      summary: { text: "hi" },
    });
  });

  it("returns no content for a wrapper around nothing usable", () => {
    expect(answer({ input: {} })).toBe("");
    expect(answer({ input: "not json" })).toBe("");
  });

  it("tells the model, in the schema, to put the keys at the top level", () => {
    const { body } = buildAnthropicRequest(
      {
        model: "x",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: "x" }],
      } as Loose,
      "claude-haiku-5-5",
      CACHE_5M,
    );
    const schema = (body.tools?.[0] as { input_schema: { description?: string } }).input_schema;
    expect(schema.description).toMatch(/top level/i);
  });
});
