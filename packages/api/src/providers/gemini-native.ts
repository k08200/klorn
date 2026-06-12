/**
 * Gemini native-API adapter — minimal OpenAI-chat-completions shim.
 *
 * Google's OpenAI-compatible endpoint requires `Authorization: Bearer` auth,
 * which rejects Google's newer `AQ.`-prefix keys ("Multiple authentication
 * credentials received"). The native generativelanguage.googleapis.com API
 * accepts those keys via `?key=` URL param, so we call it directly and
 * translate the response into the subset of the OpenAI chat.completions
 * shape that createCompletion + chat.ts consume.
 *
 * Scope is intentionally narrow — only what Eve's chat/briefing paths call:
 *   - non-streaming responses with a string content
 *   - streaming responses as AsyncIterable of chunks with `delta.content`
 *   - no tool / function calls (the caller falls back to tool-less mode for
 *     this provider — see createCompletion failover)
 */

import type OpenAI from "openai";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiChatParams {
  model: string;
  messages: Array<{ role: string; content: string | unknown }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    /** Implicit-cache hits (Gemini 2.5+). Absent on cache miss / older models. */
    cachedContentTokenCount?: number;
  };
}

/** Convert an OpenAI chat message array into Gemini's `contents` array. */
function toGeminiContents(messages: GeminiChatParams["messages"]): {
  systemInstruction: { parts: Array<{ text: string }> } | undefined;
  contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }>;
} {
  const systemTexts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemTexts.push(contentToText(m.content));
      continue;
    }
    // Gemini only understands "user" and "model" roles; collapse assistant/tool into model
    const role: "user" | "model" = m.role === "user" ? "user" : "model";
    contents.push({ role, parts: contentToGeminiParts(m.content) });
  }

  const systemInstruction = systemTexts.length
    ? { parts: [{ text: systemTexts.join("\n\n") }] }
    : undefined;
  return { systemInstruction, contents };
}

function contentToText(content: string | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

function contentToGeminiParts(content: string | unknown): GeminiPart[] {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: JSON.stringify(content) }];

  const parts: GeminiPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const typed = part as {
      type?: string;
      text?: unknown;
      image_url?: { url?: unknown };
    };
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push({ text: typed.text });
      continue;
    }
    if (typed.type === "image_url" && typeof typed.image_url?.url === "string") {
      const inline = dataUrlToInlineData(typed.image_url.url);
      if (inline) parts.push({ inlineData: inline });
    }
  }
  return parts.length > 0 ? parts : [{ text: JSON.stringify(content) }];
}

function dataUrlToInlineData(url: string): GeminiPart["inlineData"] | null {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function buildUrl(model: string, apiKey: string, streaming: boolean): string {
  const method = streaming ? "streamGenerateContent" : "generateContent";
  const base = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:${method}`;
  const query = new URLSearchParams({ key: apiKey });
  if (streaming) query.set("alt", "sse");
  return `${base}?${query.toString()}`;
}

async function callGemini(
  params: GeminiChatParams,
  apiKey: string,
  streaming: boolean,
): Promise<Response> {
  const { systemInstruction, contents } = toGeminiContents(params.messages);
  const body: Record<string, unknown> = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  const generationConfig: Record<string, unknown> = {};
  if (params.max_tokens) generationConfig.maxOutputTokens = params.max_tokens;
  if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  const res = await fetch(buildUrl(params.model, apiKey, streaming), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Gemini ${res.status}: ${text || "(no body)"}`) as Error & {
      status: number;
    };
    err.status = res.status;
    throw err;
  }

  return res;
}

function extractText(data: GeminiResponse): string {
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts) return "";
  return parts
    .map((p) => p.text || "")
    .filter(Boolean)
    .join("");
}

/** Non-streaming completion — returns an OpenAI-shape ChatCompletion. */
export async function createCompletionNonStreaming(
  params: GeminiChatParams,
  apiKey: string,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const res = await callGemini(params, apiKey, false);
  const data = (await res.json()) as GeminiResponse;
  const text = extractText(data);

  return {
    id: `gemini-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          refusal: null,
        },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
      // OpenAI-shape cache detail so the usage ledger records real hit rates.
      prompt_tokens_details: {
        cached_tokens: data.usageMetadata?.cachedContentTokenCount ?? 0,
      },
    },
  } as unknown as OpenAI.Chat.Completions.ChatCompletion;
}

/**
 * Streaming completion — yields OpenAI-shape chunks with `delta.content`.
 * Gemini streams Server-Sent Events where each event is a full GeminiResponse
 * with only the incremental text in `candidates[].content.parts[].text`.
 */
export async function* createCompletionStreaming(
  params: GeminiChatParams,
  apiKey: string,
): AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> {
  const res = await callGemini(params, apiKey, true);
  if (!res.body) return;

  const decoder = new TextDecoder();
  let buffer = "";
  const reader = res.body.getReader();
  const id = `gemini-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by blank line
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (!frame.startsWith("data:")) continue;
      const json = frame.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      let parsed: GeminiResponse;
      try {
        parsed = JSON.parse(json);
      } catch {
        continue;
      }
      const text = extractText(parsed);
      if (!text) continue;
      yield {
        id,
        object: "chat.completion.chunk",
        created,
        model: params.model,
        choices: [
          {
            index: 0,
            delta: { content: text, role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.Completions.ChatCompletionChunk;
    }
  }

  // Final chunk with finish_reason
  yield {
    id,
    object: "chat.completion.chunk",
    created,
    model: params.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
  } as unknown as OpenAI.Chat.Completions.ChatCompletionChunk;
}
