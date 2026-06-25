/**
 * Provider Registry — multi-provider LLM routing with automatic failover.
 *
 * Providers (in priority order):
 *   1. OpenRouter (primary)   — OpenAI-compatible proxy with :free models
 *   2. Gemini     (secondary) — Google AI Studio free tier (1500 req/day)
 *
 * Failover happens in createCompletion() when OpenRouter returns a 403/429
 * "Key limit exceeded" — the limit is per-KEY (daily, resets at UTC 00:00),
 * so switching to another :free model on the same OpenRouter key does not
 * help. Gemini uses a completely separate key + quota, so it recovers.
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

export type ProviderName = "openai-compat" | "openrouter" | "gemini" | "openai";

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
  /**
   * True when this provider was built from a user-supplied (BYOK) key rather
   * than the server's env key. A call served here spends the USER's provider
   * credit, not Klorn's — the cost ledgers must charge it $0 (see
   * trueUpCostLedgers / enforceCostGates). Absent/false ⇒ a shared env
   * provider, billed normally.
   */
  ownedByUser?: boolean;
}

export interface ProviderCredentials {
  openRouterApiKey?: string | null;
  geminiApiKey?: string | null;
  /** Direct OpenAI key (sk-…/sk-proj-…) → api.openai.com. Playground BYOK. */
  openAiApiKey?: string | null;
  quotaScope?: string | null;
  /**
   * When true, the provider chain contains ONLY the explicitly supplied
   * visitor keys — never the server's env-level OpenRouter/Gemini/compat
   * providers. This is the billing-theft guard for the public playground: a
   * visitor with a bad or exhausted key must fail closed, not silently fall
   * through to the server's own quota.
   */
  playgroundOnly?: boolean;
  /**
   * Per-user model override, resolved by getUserLlmCredentials: the user's
   * chosen model ONLY when it is curated AND they have a BYOK key, else
   * undefined. Rides with the credentials so createCompletion can apply it
   * centrally without new threading. undefined => keep the per-surface default.
   */
  userModel?: string;
}

function buildOpenRouter(
  apiKey = process.env.OPENROUTER_API_KEY,
  scope = "env",
  maxRetries?: number,
): Provider | null {
  if (!apiKey) return null;
  const client = new OpenAISDK({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  });
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

/**
 * Direct OpenAI provider — a visitor's own OpenAI key (sk-… / sk-proj-…)
 * against api.openai.com. Used only by the playground BYOK path; there is no
 * env-level OpenAI provider (the server routes through OpenRouter). Strips an
 * "openai/" prefix so an OpenRouter-style id (openai/gpt-4o-mini) still works.
 */
function buildOpenAI(apiKey: string, scope: string, maxRetries?: number): Provider | null {
  if (!apiKey) return null;
  const client = new OpenAISDK({
    apiKey,
    baseURL: "https://api.openai.com/v1",
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  });
  return {
    name: "openai",
    quotaKey: `openai:${scope}`,
    client,
    defaultModel: "gpt-4o-mini",
    supportsTools: true,
    resolveModel: (m) => m.replace(/^openai\//, ""),
    call: async (params, model) => {
      const create = client.chat.completions.create.bind(client.chat.completions) as (
        ...args: unknown[]
      ) => Promise<ChatResult>;
      return await create({ ...params, model });
    },
  };
}

/**
 * Self-host local provider — any OpenAI-compatible endpoint (Ollama,
 * LM Studio, vLLM, llama.cpp server, LiteLLM...). The privacy answer for
 * "does my email leave my machine?": set OPENAI_COMPAT_BASE_URL (e.g.
 * http://localhost:11434/v1 for Ollama) and classification runs against it
 * FIRST; cloud providers (if configured) remain as failover only.
 *
 * Deliberately env-only — there is no per-user credential path. Letting a
 * hosted-cloud user supply an arbitrary base URL would hand the server an
 * SSRF primitive (internal-network probing via "my Ollama"). Self-host
 * operators own their env; that's the only place this belongs.
 */
function buildOpenAICompat(): Provider | null {
  const baseUrl = process.env.OPENAI_COMPAT_BASE_URL;
  if (!baseUrl) return null;
  // Many local servers ignore auth entirely; the OpenAI SDK still requires
  // a non-empty key string.
  const apiKey = process.env.OPENAI_COMPAT_API_KEY || "local";
  const defaultModel = process.env.OPENAI_COMPAT_MODEL || "qwen3:8b";
  const client = new OpenAISDK({ apiKey, baseURL: baseUrl });
  return {
    name: "openai-compat",
    quotaKey: "openai-compat:env",
    client,
    defaultModel,
    // Small local models' function-calling is unreliable; opt in explicitly
    // when the chosen model/server handles tools well.
    supportsTools: process.env.OPENAI_COMPAT_SUPPORTS_TOOLS === "true",
    // Caller model IDs are OpenRouter/Gemini-namespaced and meaningless to a
    // local server — the operator picked ONE local model, always use it.
    resolveModel: () => defaultModel,
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
  "openai-compat": buildOpenAICompat(),
  openrouter: buildOpenRouter(process.env.OPENROUTER_API_KEY),
  gemini: buildGemini(process.env.GEMINI_API_KEY),
  // No env-level direct OpenAI provider — the server routes through OpenRouter.
  // Direct OpenAI is a playground BYOK-only path (per-request key).
  openai: null,
};

if (!providers.openrouter && !providers.gemini && !providers["openai-compat"]) {
  console.error(
    "[providers] No LLM provider configured — every chat request will fail. Set OPENROUTER_API_KEY, GEMINI_API_KEY, or OPENAI_COMPAT_BASE_URL (local Ollama/LM Studio/vLLM) in your env.",
  );
} else {
  if (providers["openai-compat"]) {
    const host = (() => {
      try {
        return new URL(process.env.OPENAI_COMPAT_BASE_URL ?? "").host;
      } catch {
        return process.env.OPENAI_COMPAT_BASE_URL;
      }
    })();
    console.log(
      `[providers] Local/OpenAI-compatible provider active at ${host} (model ${providers["openai-compat"].defaultModel}) — tried FIRST; cloud providers are failover only`,
    );
  }
  if (!providers.openrouter) {
    console.warn("[providers] OPENROUTER_API_KEY not set — primary provider disabled");
  }
  if (!providers.gemini) {
    console.warn(
      "[providers] GEMINI_API_KEY not set — no secondary provider, OpenRouter daily limits will surface as hard errors until UTC midnight",
    );
  } else {
    console.log("[providers] Gemini secondary provider active (daily quota fallback)");
  }
  // Cost guardrail — OpenRouter bills any `<vendor>/<model>` ID without a
  // `:free` suffix. A deploy that drops the suffix silently routes to the
  // paid catalog (the 2026-06-02 incident). Loudly warn at startup so the
  // founder doesn't discover it on the invoice.
  if (providers.openrouter) {
    warnIfPaidModel("CHAT_MODEL", process.env.CHAT_MODEL);
    warnIfPaidModel("AGENT_MODEL", process.env.AGENT_MODEL);
    warnIfPaidModel("VISION_MODEL", process.env.VISION_MODEL);
  }
}

export function isLikelyPaidOpenRouterModel(value: string): boolean {
  if (!value) return false;
  if (value.includes(":free")) return false;
  // Only flag vendor-prefixed IDs — bare `gemini-2.5-flash` is a Gemini-
  // direct route (free) and shouldn't trigger the OpenRouter warning.
  return /^[a-z0-9-]+\//i.test(value);
}

function warnIfPaidModel(envName: string, value: string | undefined): void {
  if (!value || !isLikelyPaidOpenRouterModel(value)) return;
  console.warn(
    `[providers] ${envName}="${value}" routes to OpenRouter's PAID catalog. ` +
      `Append ":free" (e.g. ${value}:free) or unset to use the in-code free default.`,
  );
}

/** Get a provider by name, or null if not configured */
export function getProvider(name: ProviderName): Provider | null {
  return providers[name];
}

/**
 * Ordered list of providers to try, skipping any that aren't configured.
 *
 * The local/OpenAI-compat provider leads the chain by default — a
 * self-hoster who configured a local endpoint wants their mail to stay in
 * their perimeter, with cloud as failover. Set OPENAI_COMPAT_PRIORITY=last
 * to flip that (local as the cheap fallback instead).
 */
export function getProviderChain(credentials: ProviderCredentials = {}): Provider[] {
  const userScope = credentials.quotaScope ? `user:${credentials.quotaScope}` : "user";
  const compatLast = process.env.OPENAI_COMPAT_PRIORITY === "last";
  const compat = providers["openai-compat"];

  // Playground BYOK calls disable the OpenAI SDK's built-in retry: a visitor's
  // 429/5xx must fail FAST with the raw reason, not burn 10-20s on exponential
  // backoff (then double it via the judge's own retry) before surfacing.
  const visitorRetries = credentials.playgroundOnly ? 0 : undefined;
  // Tagged ownedByUser so the cost ledgers can tell a call served on the
  // user's OWN key (Klorn spends $0) from an env-key fallthrough (Klorn pays).
  const visitorProviders = [
    credentials.openRouterApiKey
      ? buildOpenRouter(credentials.openRouterApiKey, userScope, visitorRetries)
      : null,
    credentials.geminiApiKey ? buildGemini(credentials.geminiApiKey, userScope) : null,
    credentials.openAiApiKey
      ? buildOpenAI(credentials.openAiApiKey, userScope, visitorRetries)
      : null,
  ].map((p): Provider | null => (p ? { ...p, ownedByUser: true } : null));

  // playgroundOnly fails closed: a public visitor's request must NEVER reach
  // the server's env keys or local compat model. Without this guard a bad
  // visitor key falls through to providers.openrouter (env) and spends Klorn's
  // money — a zero-auth billing-theft vector.
  if (credentials.playgroundOnly) {
    return visitorProviders.filter((p): p is Provider => p !== null);
  }

  // User-credential providers are built ONLY from explicitly supplied keys.
  // Passing undefined through would hit the builders' env-default params and
  // register the env key a second time under a `user` quotaKey — duplicate
  // tries and a cooldown bypass for the same underlying key.
  const chain = [
    ...(compatLast ? [] : [compat]),
    ...visitorProviders,
    providers.openrouter,
    providers.gemini,
    ...(compatLast ? [compat] : []),
  ].filter((p): p is Provider => p !== null);

  const seen = new Set<string>();
  return chain.filter((provider) => {
    if (seen.has(provider.quotaKey)) return false;
    seen.add(provider.quotaKey);
    return true;
  });
}
