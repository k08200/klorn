/**
 * Provider Registry — multi-provider LLM routing with automatic failover.
 *
 * Providers (in priority order):
 *   1. OpenRouter (primary)   — OpenAI-compatible proxy with :free models
 *   2. Gemini     (secondary) — Google AI Studio free tier (1500 req/day)
 *
 * Failover happens in createCompletion() when OpenRouter returns a 403
 * "Key limit exceeded (weekly limit)" — the weekly limit is per-KEY, so
 * switching to another :free model on the same OpenRouter key does not help.
 * Gemini uses a completely separate key + quota, so it actually recovers.
 *
 * OpenRouter goes through the OpenAI SDK (Bearer-auth). Gemini is called via
 * a native adapter (URL-param auth) — newer `AQ.`-prefix Google keys are
 * rejected by the OpenAI-compat endpoint's Bearer auth path.
 */

import crypto from "node:crypto";
import type OpenAI from "openai";
import OpenAISDK from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import {
  createCompletionNonStreaming as geminiNonStreaming,
  createCompletionStreaming as geminiStreaming,
} from "./gemini-native.js";

export type ProviderName = "openrouter" | "gemini";

type ChatParams = ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming;
type ChatResult =
  | OpenAI.Chat.Completions.ChatCompletion
  | AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

export interface Provider {
  name: ProviderName;
  /** Stable non-secret key for per-API-key fallback cooldown state */
  quotaKey: string;
  /** Model used when caller's model can't be routed into this provider */
  defaultModel: string;
  /** Translate a caller-supplied model ID to this provider's namespace */
  resolveModel(requestedModel: string): string;
  /** Execute a chat completion with this provider */
  call(params: ChatParams, model: string): Promise<ChatResult>;
  /** Direct OpenAI SDK client — null for providers that don't expose one */
  client: OpenAI | null;
  /** True if this provider reliably supports OpenAI-style function calling */
  supportsTools: boolean;
}

export interface ProviderCredentials {
  openRouterApiKey?: string | null;
  geminiApiKey?: string | null;
  quotaScope?: string | null;
}

function buildOpenRouter(apiKey = process.env.OPENROUTER_API_KEY, scope = "env"): Provider | null {
  if (!apiKey) return null;
  const client = new OpenAISDK({ apiKey, baseURL: "https://openrouter.ai/api/v1" });
  return {
    name: "openrouter",
    quotaKey: `openrouter:${scope}`,
    client,
    defaultModel: process.env.FALLBACK_MODEL || "google/gemma-4-31b-it:free",
    supportsTools: true,
    resolveModel: (m) => m,
    call: async (params, model) => {
      const create = client.chat.completions.create.bind(client.chat.completions) as (
        ...args: unknown[]
      ) => Promise<ChatResult>;
      return await create({ ...params, model });
    },
  };
}

function buildGemini(apiKey = process.env.GEMINI_API_KEY, scope = "env"): Provider | null {
  if (!apiKey) return null;
  const defaultModel = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash";
  return {
    name: "gemini",
    quotaKey: `gemini:${scope}`,
    client: null, // uses native adapter, not OpenAI SDK
    defaultModel,
    // Gemini's OpenAI-compat tools support is unreliable; caller should strip
    // tools when routed here (createCompletion handles this).
    supportsTools: false,
    resolveModel: (m) => {
      if (m.startsWith("google/gemini")) return m.slice("google/".length).replace(/:free$/, "");
      if (!m.startsWith("gemini")) return defaultModel;
      return m.replace(/:free$/, "");
    },
    call: async (params, model) => {
      const shared = {
        model,
        messages: params.messages as Array<{ role: string; content: string | unknown }>,
        max_tokens: (params as { max_tokens?: number }).max_tokens,
        temperature: (params as { temperature?: number }).temperature,
      };
      if ((params as { stream?: boolean }).stream) {
        return geminiStreaming({ ...shared, stream: true }, apiKey);
      }
      return await geminiNonStreaming(shared, apiKey);
    },
  };
}

const providers: Record<ProviderName, Provider | null> = {
  openrouter: buildOpenRouter(process.env.OPENROUTER_API_KEY),
  gemini: buildGemini(process.env.GEMINI_API_KEY),
};

if (!providers.openrouter && !providers.gemini) {
  console.error(
    "[providers] NEITHER OPENROUTER_API_KEY NOR GEMINI_API_KEY is set — every chat request will fail. Set at least one in your env.",
  );
} else {
  if (!providers.openrouter) {
    console.warn("[providers] OPENROUTER_API_KEY not set — primary provider disabled");
  }
  if (!providers.gemini) {
    console.warn(
      "[providers] GEMINI_API_KEY not set — no secondary provider, weekly OpenRouter limits will surface as hard errors",
    );
  } else {
    console.log("[providers] Gemini secondary provider active (daily quota fallback)");
  }
}

/** Get a provider by name, or null if not configured */
export function getProvider(name: ProviderName): Provider | null {
  return providers[name];
}

/** Ordered list of providers to try, skipping any that aren't configured */
export function getProviderChain(credentials: ProviderCredentials = {}): Provider[] {
  const userScope = credentials.quotaScope ? `user:${credentials.quotaScope}` : "user";
  const chain = [
    buildOpenRouter(credentials.openRouterApiKey ?? undefined, userScope),
    buildGemini(credentials.geminiApiKey ?? undefined, userScope),
    providers.openrouter,
    providers.gemini,
  ].filter((p): p is Provider => p !== null);

  const seen = new Set<string>();
  return chain.filter((provider) => {
    if (seen.has(provider.quotaKey)) return false;
    seen.add(provider.quotaKey);
    return true;
  });
}
