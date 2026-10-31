/**
 * Native Anthropic adapter — OpenAI chat.completions shape in, Messages API
 * out, and back again, so every caller of createCompletion keeps working when
 * Claude serves it.
 *
 * Translation rules that matter (each one is a way a call would otherwise
 * fail or silently degrade):
 *  - `response_format` JSON → a FORCED tool call whose input is the answer.
 *    Claude Haiku 5.5 rejects an assistant prefill with a 400, and a forced
 *    tool call starts with the call itself (no thinking block), so the judge's
 *    small `max_tokens` is the whole output budget.
 *  - System prompts carry a cache breakpoint (prompt caching). Blocks shorter
 *    than the model's minimum (512 tokens on the 5.5 family) are simply not
 *    cached — the request still succeeds.
 *  - `temperature` / `top_p` are dropped: the 5.5 family says to omit them.
 *  - Non-forced calls get THINKING_HEADROOM_TOKENS on top of the caller's cap:
 *    adaptive thinking is on by default and counts toward `max_tokens`, so a
 *    500-token reply budget could otherwise end after the thinking block with
 *    no text at all.
 *  - Usage is reported in the OpenAI shape (prompt_tokens = ALL input tokens,
 *    cache reads/writes broken out) so the cost ledgers price it correctly.
 *  - The prepaid-credit 400 becomes a 402 so failover treats it as credit
 *    exhaustion instead of an operator fault (see normalizeAnthropicError).
 *
 * Tool calling is translated both ways (chat engine, autonomous agent).
 * Streaming covers text only — no caller streams today; same scope as the
 * Gemini adapter.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  ContentBlockParam,
  ImageBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  StopReason,
  TextBlockParam,
  Tool,
  ToolChoice,
  ToolUseBlock,
  Usage,
} from "@anthropic-ai/sdk/resources/messages";
import type OpenAI from "openai";
import type { AnthropicCallOptions } from "./anthropic-config.js";

export {
  type AnthropicCallOptions,
  type AnthropicEffort,
  RECOMMENDED_ANTHROPIC_MODEL,
  readAnthropicCallOptions,
  toAnthropicModelId,
} from "./anthropic-config.js";

/** Name of the forced tool that carries a JSON-mode answer. */
export const JSON_RESPONSE_TOOL = "submit_json";
/** `max_tokens` is required by the Messages API; used when the caller sets none. */
export const DEFAULT_MAX_TOKENS = 4096;
/** Extra output budget for adaptive thinking on non-forced calls. */
export const THINKING_HEADROOM_TOKENS = 2048;
/**
 * The original Anthropic content blocks of an assistant turn, attached to the
 * returned OpenAI message under a symbol. Callers that push the message back
 * into the conversation (the chat tool loop) round-trip it untouched, so the
 * thinking blocks go back unmodified with the tool results, as the API
 * requires. JSON.stringify skips symbol keys, so it never reaches another
 * provider's request body.
 */
export const ANTHROPIC_CONTENT: unique symbol = Symbol.for("klorn.anthropic.content");

// Loose views of the OpenAI params — the SDK unions are wider than what
// Klorn sends, and we only read.
interface LooseMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  [ANTHROPIC_CONTENT]?: unknown;
}
interface LooseParams {
  messages: LooseMessage[];
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  stop?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  response_format?: unknown;
}

type ChatParams =
  | OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
  | OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Plain text of an OpenAI message content (string or text parts). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function textBlock(text: string): TextBlockParam[] {
  return text.length > 0 ? [{ type: "text", text }] : [];
}

/**
 * Inline (data:) images only. A remote URL is never forwarded: Anthropic would
 * fetch it, which turns a mail-derived URL into a tracking pixel or leaks a
 * signed link. MIME parameters (`;name=…`) are tolerated.
 */
function imageBlock(url: string): ImageBlockParam | null {
  const data = url.match(/^data:(image\/[a-z0-9.+-]+)(?:;[^,;]*)*;base64,(.+)$/i);
  if (!data) return null;
  return {
    type: "image",
    source: { type: "base64", media_type: data[1].toLowerCase() as "image/png", data: data[2] },
  };
}

function userBlocks(content: unknown): ContentBlockParam[] {
  if (!Array.isArray(content)) return textBlock(contentText(content));
  return content.flatMap((part): ContentBlockParam[] => {
    if (!isRecord(part)) return [];
    if (part.type === "text" && typeof part.text === "string") return textBlock(part.text);
    const url = isRecord(part.image_url) ? part.image_url.url : undefined;
    if (part.type === "image_url" && typeof url === "string") {
      // Say an image was dropped rather than let the model invent its content.
      return [imageBlock(url) ?? { type: "text", text: "[image omitted]" }];
    }
    return [];
  });
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function assistantBlocks(message: LooseMessage): ContentBlockParam[] {
  const original = message[ANTHROPIC_CONTENT];
  if (Array.isArray(original)) return original as ContentBlockParam[];
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolUses = calls.flatMap((call): ContentBlockParam[] => {
    if (!isRecord(call) || typeof call.id !== "string" || !isRecord(call.function)) return [];
    const name = call.function.name;
    if (typeof name !== "string") return [];
    return [
      { type: "tool_use", id: call.id, name, input: parseToolArguments(call.function.arguments) },
    ];
  });
  return [...textBlock(contentText(message.content)), ...toolUses];
}

function toTurn(message: LooseMessage): MessageParam | null {
  switch (message.role) {
    case "system":
    case "developer":
      return null;
    case "assistant":
      return { role: "assistant", content: assistantBlocks(message) };
    case "tool":
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: String(message.tool_call_id ?? ""),
            content: contentText(message.content),
          },
        ],
      };
    default:
      return { role: "user", content: userBlocks(message.content) };
  }
}

/** Convert the conversation, merging consecutive same-role turns. */
function toMessages(messages: LooseMessage[]): MessageParam[] {
  return messages.reduce<MessageParam[]>((turns, message) => {
    const turn = toTurn(message);
    if (!turn || (turn.content as ContentBlockParam[]).length === 0) return turns;
    const previous = turns.at(-1);
    if (previous?.role !== turn.role) return [...turns, turn];
    const merged: MessageParam = {
      role: turn.role,
      content: [
        ...(previous.content as ContentBlockParam[]),
        ...(turn.content as ContentBlockParam[]),
      ],
    };
    return [...turns.slice(0, -1), merged];
  }, []);
}

/**
 * System blocks, with the cache breakpoint on the FIRST one. Convention across
 * callers: the first system message is the stable prompt; later ones carry
 * per-request context (the chat engine's per-email view). A breakpoint there
 * would pay the write premium on every call for a block never re-read — and
 * park mail-derived text in the cache.
 */
function toSystemBlocks(messages: LooseMessage[], ttl: "5m" | "1h" | null): TextBlockParam[] {
  const blocks = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .flatMap((m) => textBlock(contentText(m.content)));
  if (!ttl || blocks.length === 0) return blocks;
  const cacheControl =
    ttl === "1h"
      ? { type: "ephemeral" as const, ttl: "1h" as const }
      : { type: "ephemeral" as const };
  return [{ ...blocks[0], cache_control: cacheControl }, ...blocks.slice(1)];
}

function toTools(tools: unknown): Tool[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool): Tool[] => {
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) return [];
    const { name, description, parameters } = tool.function;
    if (typeof name !== "string") return [];
    return [
      {
        name,
        ...(typeof description === "string" ? { description } : {}),
        input_schema: (isRecord(parameters)
          ? parameters
          : { type: "object", properties: {} }) as Tool["input_schema"],
      },
    ];
  });
}

/**
 * Models that reject a forced tool_choice ("any" / a named tool) with a 400 —
 * thinking is always on for them. platform.claude.com/docs/en/api/errors,
 * "Forced tool use not supported" (read 2026-10-25). Unknown future models are
 * caught reactively by FORCED_TOOL_REJECTED below.
 */
const NO_FORCED_TOOL_MODELS = /^claude-(?:opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)(?:$|-)/i;
const FORCED_TOOL_REJECTED = /tool_choice: type "tool" and "any" are not supported/i;

export function acceptsForcedToolChoice(model: string): boolean {
  return !NO_FORCED_TOOL_MODELS.test(model);
}

function toToolChoice(
  choice: unknown,
  parallel: unknown,
  allowForced: boolean,
): ToolChoice | undefined {
  const disable = parallel === false ? { disable_parallel_tool_use: true } : {};
  if (choice === "none") return { type: "none" };
  const named =
    isRecord(choice) && isRecord(choice.function) && typeof choice.function.name === "string"
      ? choice.function.name
      : null;
  if ((choice === "required" || named) && !allowForced) return { type: "auto", ...disable };
  if (choice === "required") return { type: "any", ...disable };
  if (named) return { type: "tool", name: named, ...disable };
  if (choice === "auto" || parallel === false) return { type: "auto", ...disable };
  return undefined;
}

/** The JSON schema a response_format asks for, or null when it asks for none. */
const OPEN_ANSWER_SCHEMA = {
  type: "object",
  description:
    "Your answer object itself: the keys the instructions specify, at the top level. Do not wrap it in another key.",
};

function jsonResponseSchema(format: unknown): Record<string, unknown> | null {
  if (!isRecord(format)) return null;
  if (format.type === "json_object") return OPEN_ANSWER_SCHEMA;
  if (format.type === "json_schema" && isRecord(format.json_schema)) {
    return isRecord(format.json_schema.schema) ? format.json_schema.schema : OPEN_ANSWER_SCHEMA;
  }
  return null;
}

function stopSequences(stop: unknown): string[] {
  const list = Array.isArray(stop) ? stop : [stop];
  return list.filter((s): s is string => typeof s === "string" && s.length > 0);
}

/** Asks for the JSON tool when it cannot be forced (tool_choice auto). */
const JSON_TOOL_INSTRUCTION = `Answer by calling the ${JSON_RESPONSE_TOOL} tool exactly once; its input is your complete answer. Do not answer in plain text.`;

interface ToolSetup {
  tools: Tool[];
  toolChoice: ToolChoice | undefined;
  jsonMode: boolean;
  /** Extra system text, only when the JSON tool could not be forced. */
  instruction: string | null;
}

function toolSetup(loose: LooseParams, allowForced: boolean, forceJson: boolean): ToolSetup {
  const callerTools = toTools(loose.tools);
  const schema = jsonResponseSchema(loose.response_format);
  if (schema === null || callerTools.length > 0) {
    const toolChoice =
      callerTools.length > 0
        ? toToolChoice(loose.tool_choice, loose.parallel_tool_calls, allowForced)
        : undefined;
    return { tools: callerTools, toolChoice, jsonMode: false, instruction: null };
  }
  const jsonTool: Tool = {
    name: JSON_RESPONSE_TOOL,
    description:
      "Return your complete answer as this tool's input: the JSON object the instructions ask for, with exactly the keys they specify.",
    input_schema: schema as Tool["input_schema"],
  };
  return allowForced && forceJson
    ? {
        tools: [jsonTool],
        toolChoice: { type: "tool", name: JSON_RESPONSE_TOOL },
        jsonMode: true,
        instruction: null,
      }
    : {
        tools: [jsonTool],
        toolChoice: { type: "auto" },
        jsonMode: true,
        instruction: JSON_TOOL_INSTRUCTION,
      };
}

/**
 * Build the Messages API request for an OpenAI-shape chat call. Pure.
 * `allowForced` defaults to what the model is known to accept; the reactive
 * retry passes false after a forced-choice 400.
 */
export function buildAnthropicRequest(
  params: ChatParams,
  model: string,
  options: AnthropicCallOptions,
  allowForced = acceptsForcedToolChoice(model),
): { body: MessageCreateParamsNonStreaming; jsonMode: boolean } {
  const loose = params as unknown as LooseParams;
  const messages = Array.isArray(loose.messages) ? loose.messages : [];
  const { tools, toolChoice, jsonMode, instruction } = toolSetup(
    loose,
    allowForced,
    options.forceJsonTool !== false,
  );
  // A forced call (named tool or "any") has no thinking block.
  const forced = toolChoice?.type === "tool" || toolChoice?.type === "any";
  const cap =
    positiveInt(loose.max_tokens) ?? positiveInt(loose.max_completion_tokens) ?? DEFAULT_MAX_TOKENS;
  const system = [
    ...toSystemBlocks(messages, options.cacheTtl),
    ...(instruction ? textBlock(instruction) : []),
  ];
  const stops = stopSequences(loose.stop);

  const body: MessageCreateParamsNonStreaming = {
    model,
    max_tokens: forced ? cap : cap + THINKING_HEADROOM_TOKENS,
    messages: toMessages(messages),
    ...(system.length > 0 ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(stops.length > 0 ? { stop_sequences: stops } : {}),
    ...(options.effort ? { output_config: { effort: options.effort } } : {}),
  };
  return { body, jsonMode };
}

function finishReason(
  stop: StopReason | null,
  jsonMode: boolean,
): OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"] {
  switch (stop) {
    case "tool_use":
      return jsonMode ? "stop" : "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

function toUsage(usage: Usage): OpenAI.Completions.CompletionUsage {
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const prompt = (usage.input_tokens ?? 0) + read + write;
  const completion = usage.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: {
      cached_tokens: read,
      cache_write_tokens: write,
      cache_write_1h_tokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    },
  } as OpenAI.Completions.CompletionUsage;
}

function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

/**
 * The JSON answer of a JSON-mode call: the JSON tool's input, else (when the
 * model answered in text instead of calling it) the text. Returns "" — which
 * every JSON caller treats as a failed call and retries or reports — for an
 * answer cut off by max_tokens or an empty object, rather than handing over
 * something that parses and silently scores every missing key as 0.
 */
function jsonContent(toolUses: ToolUseBlock[], text: string, truncated: boolean): string {
  if (truncated) return "";
  const block = toolUses.find((b) => b.name === JSON_RESPONSE_TOOL);
  if (!block) return text;
  const input = unwrapAnswer(isRecord(block.input) ? block.input : {});
  return Object.keys(input).length > 0 ? JSON.stringify(input) : "";
}

/**
 * Key names a model wraps the whole answer in when the tool schema is open
 * (measured 2026-10-30: Haiku 5.5 with thinking sent `{"input": {…}}` on 12 of
 * 55 judge calls). Left wrapped, the caller finds none of its keys and scores
 * every feature 0 while recording the call as an LLM success.
 */
const ANSWER_WRAPPER_KEYS = new Set(["input", "json", "answer", "response", "result", "output"]);

function unwrapAnswer(input: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(input);
  if (keys.length !== 1 || !ANSWER_WRAPPER_KEYS.has(keys[0])) return input;
  const inner = input[keys[0]];
  if (isRecord(inner)) return inner;
  if (typeof inner !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(inner);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Convert a Messages API response into an OpenAI-shape ChatCompletion. Pure. */
export function toChatCompletion(
  message: Message,
  jsonMode: boolean,
): OpenAI.Chat.Completions.ChatCompletion {
  const truncated = message.stop_reason === "max_tokens";
  const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  // A tool call cut off by max_tokens carries partial or empty input: never
  // hand it to a caller that would execute it.
  const toolUses = truncated ? [] : message.content.filter(isToolUse);
  const content = jsonMode
    ? jsonContent(toolUses, text, truncated)
    : toolUses.length > 0 && !text
      ? null
      : text;
  const toolCalls = jsonMode
    ? []
    : toolUses.map((block) => ({
        id: block.id,
        type: "function" as const,
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      }));
  const assistant = {
    role: "assistant" as const,
    content,
    refusal: null,
    ...(toolCalls.length > 0
      ? { tool_calls: toolCalls, [ANTHROPIC_CONTENT]: message.content }
      : {}),
  };
  return {
    id: message.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: message.model,
    choices: [
      {
        index: 0,
        message: assistant as OpenAI.Chat.Completions.ChatCompletionMessage,
        finish_reason: finishReason(message.stop_reason, jsonMode),
        logprobs: null,
      },
    ],
    usage: toUsage(message.usage),
  };
}

/**
 * Money-out 400s: an empty prepaid balance ("Your credit balance is too
 * low…") and a spend limit the operator set ("You have reached your specified
 * [workspace] API usage limits…" — platform.claude.com/docs/en/api/errors says
 * spend limits answer 400 invalid_request_error).
 */
const CREDIT_OR_SPEND_LIMIT =
  /credit balance is too low|reached your specified (?:workspace )?API usage limits/i;

/**
 * Left as a 400 these read as an operator fault and are rethrown without
 * failover — every judge call would drop to the keyword fallback, the exact
 * silent-PUSH-outage shape of 2026-09. As a 402 they take the credit path:
 * cooldown, next provider, loud log. (A real 402 billing_error already is one.)
 */
/**
 * The API's own error text. The SDK's `message` is "400 {json…}" with inner
 * quotes escaped, so match against the parsed body when there is one.
 */
function apiErrorText(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const inner = body?.error?.message;
  return typeof inner === "string" ? inner : err.message;
}

export function normalizeAnthropicError(err: unknown): unknown {
  if (
    err instanceof Anthropic.APIError &&
    err.status === 400 &&
    CREDIT_OR_SPEND_LIMIT.test(apiErrorText(err))
  ) {
    const credit = new Error(`402 Anthropic credit or spend limit exhausted — ${err.message}`, {
      cause: err,
    }) as Error & { status: number };
    credit.name = "AnthropicCreditExhaustedError";
    credit.status = 402;
    return credit;
  }
  return err;
}

function isForcedToolRejection(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIError &&
    err.status === 400 &&
    FORCED_TOOL_REJECTED.test(apiErrorText(err))
  );
}

/**
 * The SDK client, with base URL and log level pinned rather than left to the
 * SDK's env pickup: a stray ANTHROPIC_BASE_URL would send both mail and key
 * elsewhere, and ANTHROPIC_LOG=debug logs request bodies — which are mail.
 */
export function createAnthropicClient(
  apiKey: string,
  timeoutMs: number,
  workspaceId: string | null = null,
  maxRetries?: number,
): Anthropic {
  return new Anthropic({
    apiKey,
    timeout: timeoutMs,
    // Never let the SDK pick up ANTHROPIC_AUTH_TOKEN from the environment: a
    // playground visitor's client would otherwise carry a server bearer token
    // next to the visitor's own key. Klorn authenticates by apiKey only.
    authToken: null,
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    baseURL: "https://api.anthropic.com",
    logLevel: "warn",
    // Personal and service-account keys that aren't scoped to one workspace
    // must name it on every request (platform.claude.com/docs/en/manage-claude/
    // authentication#select-a-workspace); workspace-scoped keys don't need it.
    ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}),
  });
}

/**
 * Non-streaming completion through the SDK. A model not yet known to reject
 * forced tool use gets one retry with tool_choice auto when it does.
 */
export async function createAnthropicCompletion(
  client: Anthropic,
  params: ChatParams,
  model: string,
  options: AnthropicCallOptions,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const first = buildAnthropicRequest(params, model, options);
  try {
    return toChatCompletion(await client.messages.create(first.body), first.jsonMode);
  } catch (err) {
    if (!isForcedToolRejection(err)) throw normalizeAnthropicError(err);
  }
  const retry = buildAnthropicRequest(params, model, options, false);
  try {
    return toChatCompletion(await client.messages.create(retry.body), retry.jsonMode);
  } catch (err) {
    throw normalizeAnthropicError(err);
  }
}

function chunk(
  id: string,
  model: string,
  delta: { content?: string; role?: "assistant" },
  finish: OpenAI.Chat.Completions.ChatCompletionChunk.Choice["finish_reason"],
): OpenAI.Chat.Completions.ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  };
}

/** Streaming completion — text deltas (or the JSON tool's input) only. */
export async function* streamAnthropicCompletion(
  client: Anthropic,
  params: ChatParams,
  model: string,
  options: AnthropicCallOptions,
): AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> {
  if (toTools((params as unknown as LooseParams).tools).length > 0) {
    // Tool-call deltas are not translated; failing loudly beats a stream that
    // ends in finish_reason "tool_calls" with no calls in it.
    throw new Error(
      "Anthropic streaming does not support tool calls — call createCompletion without stream",
    );
  }
  const { body, jsonMode } = buildAnthropicRequest(params, model, options);
  const id = `anthropic-${Date.now()}`;
  let finish: OpenAI.Chat.Completions.ChatCompletionChunk.Choice["finish_reason"] = "stop";
  try {
    const stream = await client.messages.create({ ...body, stream: true });
    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        const piece =
          event.delta.type === "text_delta"
            ? event.delta.text
            : jsonMode && event.delta.type === "input_json_delta"
              ? event.delta.partial_json
              : "";
        if (piece) yield chunk(id, model, { content: piece, role: "assistant" }, null);
      } else if (event.type === "message_delta" && event.delta.stop_reason) {
        finish = finishReason(event.delta.stop_reason, jsonMode);
      }
    }
  } catch (err) {
    throw normalizeAnthropicError(err);
  }
  yield chunk(id, model, {}, finish);
}
