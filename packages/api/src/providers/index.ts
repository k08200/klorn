/**
 * Provider Registry — multi-provider LLM routing with automatic failover.
 *
 * Env providers (default order; LLM_PROVIDER_ORDER reorders them):
 *   1. Anthropic (primary) — ANTHROPIC_API_KEY, the official SDK behind a
 *      native adapter (anthropic-native.ts). Hosted Klorn runs on the Claude
 *      API alone (founder decision 2026-11-01). Commercial API terms —
 *      inputs/outputs are not used for training by default — which is what
 *      lets user mail go there under Limited Use.
 *   2. Gemini (optional) — Google AI Studio key, called via a native adapter
 *      (URL-param auth; newer `AQ.`-prefix keys are rejected by the
 *      OpenAI-compat endpoint's Bearer path). A free-tier key lets Google train
 *      on request data, which would break the privacy policy's Limited Use
 *      no-train commitment on a hosted deploy; self-hosters may choose it.
 *
 * Plus the self-host local provider (OPENAI_COMPAT_BASE_URL — Ollama, LM
 * Studio, vLLM…), which keeps its own OPENAI_COMPAT_PRIORITY edge, and the
 * per-request user keys (BYOK Anthropic key from Settings; Anthropic / OpenAI /
 * Gemini visitor keys in the playground), which always lead.
 *
 * Failover happens in createCompletion() on a key limit (403/429), credit
 * exhaustion (402) or overload (529): the next configured provider has its own
 * key and quota, so it recovers.
 *
 * LLM_PROVIDER_ORDER (e.g. "anthropic,gemini") orders the ENV providers.
 * Configured providers it does not list keep their default relative order
 * after the listed ones, so a typo can reorder the chain but never empty it.
 */

import crypto from "node:crypto";
import type OpenAI from "openai";
import OpenAISDK from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import {
  CLOUD_LLM_TIMEOUT_MS,
  LOCAL_LLM_TIMEOUT_MS,
  llmRequestTimeoutMs,
} from "../llm/llm-timeout.js";
import {
  RECOMMENDED_ANTHROPIC_MODEL,
  readAnthropicCallOptions,
  toAnthropicModelId,
} from "./anthropic-config.js";
import {
  createCompletionNonStreaming as geminiNonStreaming,
  createCompletionStreaming as geminiStreaming,
} from "./gemini-native.js";

export type ProviderName = "openai-compat" | "gemini" | "openai" | "anthropic";

/** Server-key providers whose order LLM_PROVIDER_ORDER controls. */
const ENV_PROVIDER_NAMES = ["anthropic", "gemini"] as const;
export type EnvProviderName = (typeof ENV_PROVIDER_NAMES)[number];

function isEnvProviderName(value: string): value is EnvProviderName {
  return (ENV_PROVIDER_NAMES as readonly string[]).includes(value);
}

function orderTokens(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The env-provider order: names listed in LLM_PROVIDER_ORDER first (unknown and
 * duplicate names dropped), then every remaining env provider in the default
 * order. Unconfigured providers are filtered out later by the chain itself.
 */
export function resolveEnvProviderOrder(raw: string | undefined): EnvProviderName[] {
  const listed = [...new Set(orderTokens(raw).filter(isEnvProviderName))];
  return [...listed, ...ENV_PROVIDER_NAMES.filter((name) => !listed.includes(name))];
}

/** Names in LLM_PROVIDER_ORDER that are not env providers (boot warning). */
export function unknownEnvProviderNames(raw: string | undefined): string[] {
  return orderTokens(raw).filter((token) => !isEnvProviderName(token));
}

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
  /**
   * Direct Anthropic key (sk-ant-…) → api.anthropic.com. The Settings BYOK
   * slot (getUserLlmCredentials) and a playground visitor key.
   */
  anthropicApiKey?: string | null;
  /** Legacy Settings BYOK slot (clear-only) and a playground visitor key. */
  geminiApiKey?: string | null;
  /** Direct OpenAI key (sk-…/sk-proj-…) → api.openai.com. Playground BYOK. */
  openAiApiKey?: string | null;
  quotaScope?: string | null;
  /**
   * When true, the provider chain contains ONLY the explicitly supplied
   * visitor keys — never the server's env-level Anthropic/Gemini/compat
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

/**
 * Direct OpenAI provider — a visitor's own OpenAI key (sk-… / sk-proj-…)
 * against api.openai.com. Used only by the playground BYOK path; there is no
 * env-level OpenAI provider. Strips an "openai/" prefix so a vendor-prefixed
 * id (openai/gpt-4o-mini) still works.
 */
function buildOpenAI(apiKey: string, scope: string, maxRetries?: number): Provider | null {
  if (!apiKey) return null;
  const client = new OpenAISDK({
    apiKey,
    baseURL: "https://api.openai.com/v1",
    timeout: llmRequestTimeoutMs(CLOUD_LLM_TIMEOUT_MS),
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
  const client = new OpenAISDK({
    apiKey,
    baseURL: baseUrl,
    timeout: llmRequestTimeoutMs(LOCAL_LLM_TIMEOUT_MS),
  });
  return {
    name: "openai-compat",
    quotaKey: "openai-compat:env",
    client,
    defaultModel,
    // Small local models' function-calling is unreliable; opt in explicitly
    // when the chosen model/server handles tools well.
    supportsTools: process.env.OPENAI_COMPAT_SUPPORTS_TOOLS === "true",
    // Caller model IDs are Claude/Gemini-namespaced and meaningless to a local
    // server — the operator picked ONE local model, always use it.
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

interface AnthropicSession {
  adapter: typeof import("./anthropic-native.js");
  client: ReturnType<typeof import("./anthropic-native.js").createAnthropicClient>;
}

interface AnthropicBuildOptions {
  /** `env` for the server key; `user:<scope>` for a playground visitor key. */
  scope: string;
  /** Only the server's own key may name the operator's workspace. */
  workspaceId: string | null;
  /** undefined = SDK default; 0 for a visitor so a 429 fails fast. */
  maxRetries?: number;
}

/**
 * Native Anthropic provider. The env key serves the server; the playground
 * passes a visitor's own key (BYOK) with its own quota scope, no workspace
 * header (ANTHROPIC_WORKSPACE_ID names Klorn's workspace, never a visitor's)
 * and no SDK retries. Non-Claude pins are served by ANTHROPIC_MODEL (default
 * claude-haiku-5-5), the way Gemini serves a non-Gemini pin with
 * GEMINI_FALLBACK_MODEL; Claude pins, native or vendor-prefixed
 * (`anthropic/claude-…`), are honoured.
 */
function buildAnthropic(
  apiKey = process.env.ANTHROPIC_API_KEY,
  build: AnthropicBuildOptions = {
    scope: "env",
    workspaceId: process.env.ANTHROPIC_WORKSPACE_ID?.trim() || null,
  },
): Provider | null {
  if (!apiKey) return null;
  const defaultModel = process.env.ANTHROPIC_MODEL || RECOMMENDED_ANTHROPIC_MODEL;
  const options = readAnthropicCallOptions(process.env);
  // The SDK (+~20 MB RSS) loads on the first call, not at boot.
  let session: Promise<AnthropicSession> | null = null;
  const connect = (): Promise<AnthropicSession> => {
    session ??= import("./anthropic-native.js").then((adapter) => ({
      adapter,
      client: adapter.createAnthropicClient(
        apiKey,
        llmRequestTimeoutMs(CLOUD_LLM_TIMEOUT_MS),
        build.workspaceId,
        build.maxRetries,
      ),
    }));
    return session;
  };
  return {
    name: "anthropic",
    quotaKey: `anthropic:${build.scope}`,
    client: null, // native adapter, not the OpenAI SDK
    defaultModel,
    supportsTools: true,
    resolveModel: (m) => toAnthropicModelId(m, defaultModel),
    call: async (params, model) => {
      const { adapter, client } = await connect();
      return (params as { stream?: boolean }).stream
        ? adapter.streamAnthropicCompletion(client, params, model, options)
        : await adapter.createAnthropicCompletion(client, params, model, options);
    },
  };
}

const providers: Record<ProviderName, Provider | null> = {
  "openai-compat": buildOpenAICompat(),
  anthropic: buildAnthropic(),
  gemini: buildGemini(process.env.GEMINI_API_KEY),
  // No env-level direct OpenAI provider. Direct OpenAI is a playground
  // BYOK-only path (per-request key).
  openai: null,
};

const configuredEnvProviders = resolveEnvProviderOrder(process.env.LLM_PROVIDER_ORDER).filter(
  (name) => providers[name] !== null,
);

if (configuredEnvProviders.length === 0 && !providers["openai-compat"]) {
  console.error(
    "[providers] No LLM provider configured — every chat request will fail. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_COMPAT_BASE_URL (local Ollama/LM Studio/vLLM) in your env.",
  );
} else {
  const ignored = unknownEnvProviderNames(process.env.LLM_PROVIDER_ORDER);
  if (ignored.length > 0) {
    console.warn(
      `[providers] LLM_PROVIDER_ORDER names unknown provider(s) ${ignored.join(", ")} — ignored. Known: ${ENV_PROVIDER_NAMES.join(", ")}.`,
    );
  }
  console.log(`[providers] Env provider order: ${configuredEnvProviders.join(" → ")}`);
  if (providers.anthropic) {
    console.log(
      `[providers] Anthropic provider active (default model ${providers.anthropic.defaultModel})${
        configuredEnvProviders[0] === "anthropic"
          ? " — PRIMARY"
          : " — failover only; set LLM_PROVIDER_ORDER=anthropic,... to make it primary"
      }`,
    );
  }
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
  if (!providers.anthropic) {
    console.warn("[providers] ANTHROPIC_API_KEY not set — Claude lane disabled");
  }
  if (configuredEnvProviders.length === 1 && !providers["openai-compat"]) {
    // A single key is a deliberate shape (hosted Klorn runs on the Claude API
    // alone), so don't phrase it as a missing key. State the consequence
    // instead: with a single provider there is nothing to fail over to, so a
    // 402/403/429 on that key degrades every judge call to the keyword
    // fallback (which caps confidence at 0.55 and cannot reach the PUSH floor
    // of 0.7).
    console.warn(
      `[providers] Single provider configured (${configuredEnvProviders[0]} only) — no failover: a 402/403/429 on this key degrades every LLM surface until it clears. A second lane needs another provider (${configuredEnvProviders[0] === "anthropic" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY"} or OPENAI_COMPAT_BASE_URL).`,
    );
  }
  if (providers.gemini) {
    console.log("[providers] Gemini provider active");
  }
}

/** Get a provider by name, or null if not configured */
export function getProvider(name: ProviderName): Provider | null {
  return providers[name];
}

/**
 * Is ANY server-side LLM configured (an env provider or the local compat
 * endpoint)? The answer to "should this LLM feature run at all?" for surfaces
 * that otherwise degrade to a non-LLM path (auto-reply templates, the
 * autonomous agent). It must follow the real chain: the old guard checked one
 * provider's key, and a deploy on a different provider silently lost those
 * features with no error.
 */
export function hasLlmProvider(): boolean {
  return getProviderChain().length > 0;
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
    credentials.anthropicApiKey
      ? buildAnthropic(credentials.anthropicApiKey, {
          scope: userScope,
          workspaceId: null,
          maxRetries: visitorRetries,
        })
      : null,
    credentials.geminiApiKey ? buildGemini(credentials.geminiApiKey, userScope) : null,
    credentials.openAiApiKey
      ? buildOpenAI(credentials.openAiApiKey, userScope, visitorRetries)
      : null,
  ].map((p): Provider | null => (p ? { ...p, ownedByUser: true } : null));

  // playgroundOnly fails closed: a public visitor's request must NEVER reach
  // the server's env keys or local compat model. Without this guard a bad
  // visitor key falls through to the env providers and spends Klorn's money —
  // a zero-auth billing-theft vector.
  if (credentials.playgroundOnly) {
    return visitorProviders.filter((p): p is Provider => p !== null);
  }

  // User-credential providers are built ONLY from explicitly supplied keys.
  // Passing undefined through would hit the builders' env-default params and
  // register the env key a second time under a `user` quotaKey — duplicate
  // tries and a cooldown bypass for the same underlying key.
  const envProviders = resolveEnvProviderOrder(process.env.LLM_PROVIDER_ORDER).map(
    (name) => providers[name],
  );
  const chain = [
    ...(compatLast ? [] : [compat]),
    ...visitorProviders,
    ...envProviders,
    ...(compatLast ? [compat] : []),
  ].filter((p): p is Provider => p !== null);

  const seen = new Set<string>();
  return chain.filter((provider) => {
    if (seen.has(provider.quotaKey)) return false;
    seen.add(provider.quotaKey);
    return true;
  });
}
