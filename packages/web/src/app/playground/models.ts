/**
 * The playground's model menu — one typed source for ids, groups and prices.
 *
 * Founder decision 2026-10-30 (LOCKED, option A): list current flagship and
 * small models from the four vendors, and make NO accuracy claim except the
 * one Klorn measured: google/gemini-2.5-flash, 54/56 on Klorn's fixed 56-email
 * test (packages/api/eval/README.md, the production judge pin). Every other
 * model is listed as is.
 *
 * Prices are USD per 1M tokens (input / output) as listed in the OpenRouter
 * model catalog, checked 2026-10-30. They are shown for orientation only and
 * go stale — re-check against https://openrouter.ai/api/v1/models when the
 * list is touched. Every id below was confirmed live in that snapshot.
 *
 * Native ids follow the provider adapters in packages/api/src/providers:
 *   - Anthropic: toAnthropicModelId turns `anthropic/claude-x-5.5` into
 *     `claude-x-5-5` (dots → dashes), the spelling the native API takes.
 *   - OpenAI: buildOpenAI strips the `openai/` prefix.
 *   - Google: buildGemini strips the `google/` prefix.
 * Pinned by packages/api/src/__tests__/web-playground-models.test.ts.
 */

export type PlaygroundProvider = "openrouter" | "anthropic" | "openai" | "gemini";

export const PLAYGROUND_PROVIDERS: readonly PlaygroundProvider[] = [
  "openrouter",
  "anthropic",
  "openai",
  "gemini",
];

export type ModelGroup = "klorn" | "anthropic" | "google" | "openai" | "xai";

export interface PlaygroundModel {
  /** OpenRouter id (vendor/model). */
  readonly id: string;
  readonly group: ModelGroup;
  /** USD per 1M input tokens, OpenRouter list price (2026-10-30). */
  readonly inPerM: number;
  /** USD per 1M output tokens, OpenRouter list price (2026-10-30). */
  readonly outPerM: number;
  /** The single measured claim; only the model Klorn uses carries it. */
  readonly measured?: { readonly correct: number; readonly total: number };
}

export const PRICES_CHECKED_ON = "2026-10-30";

/** The model Klorn's own judge runs on. */
export const KLORN_MODEL_ID = "google/gemini-2.5-flash";

export const OPENROUTER_MODELS: readonly PlaygroundModel[] = [
  {
    id: KLORN_MODEL_ID,
    group: "klorn",
    inPerM: 0.3,
    outPerM: 2.5,
    measured: { correct: 54, total: 56 },
  },
  { id: "anthropic/claude-fable-5.1", group: "anthropic", inPerM: 10, outPerM: 50 },
  { id: "anthropic/claude-opus-5.5", group: "anthropic", inPerM: 4, outPerM: 20 },
  { id: "anthropic/claude-sonnet-5.5", group: "anthropic", inPerM: 2, outPerM: 10 },
  { id: "anthropic/claude-haiku-5.5", group: "anthropic", inPerM: 0.1, outPerM: 0.5 },
  { id: "google/gemini-4-argon", group: "google", inPerM: 2, outPerM: 10 },
  { id: "google/gemini-3.8-flash", group: "google", inPerM: 0.825, outPerM: 4.125 },
  { id: "openai/gpt-6.1-terra", group: "openai", inPerM: 1, outPerM: 5 },
  { id: "openai/gpt-6.1-sol", group: "openai", inPerM: 2, outPerM: 10 },
  { id: "openai/gpt-6-luna", group: "openai", inPerM: 0.1, outPerM: 0.5 },
  { id: "x-ai/grok-4.7", group: "xai", inPerM: 2, outPerM: 6 },
];

/** OpenRouter id → the provider's own API spelling (see header). */
export function toNativeModelId(provider: PlaygroundProvider, openRouterId: string): string {
  const [, name = openRouterId] = openRouterId.split("/");
  if (provider === "anthropic") return name.replace(/\./g, "-");
  if (provider === "openrouter") return openRouterId;
  return name;
}

const VENDOR_GROUPS: Record<Exclude<PlaygroundProvider, "openrouter">, readonly ModelGroup[]> = {
  anthropic: ["anthropic"],
  openai: ["openai"],
  // The Klorn model is a Google model, so the Google tab leads with it.
  gemini: ["klorn", "google"],
};

/** The models a provider tab offers, each with the id that provider takes. */
export function modelsFor(provider: PlaygroundProvider): readonly PlaygroundModel[] {
  if (provider === "openrouter") return OPENROUTER_MODELS;
  const groups = VENDOR_GROUPS[provider];
  return OPENROUTER_MODELS.filter((m) => groups.includes(m.group)).map((m) => ({
    ...m,
    id: toNativeModelId(provider, m.id),
  }));
}

/**
 * Default per tab: the measured Klorn model where the tab can run it; on the
 * Anthropic and OpenAI tabs the cheapest listed model (a cost default, not a
 * quality claim).
 */
export function defaultModelFor(provider: PlaygroundProvider): string {
  if (provider === "openrouter") return KLORN_MODEL_ID;
  if (provider === "gemini") return toNativeModelId("gemini", KLORN_MODEL_ID);
  const list = modelsFor(provider);
  const cheapest = list.reduce((a, b) => (b.inPerM + b.outPerM < a.inPerM + a.outPerM ? b : a));
  return cheapest.id;
}

/** Same shape the API enforces (routes/playground.ts PLAYGROUND_MODEL_ID_PATTERN). */
export const MODEL_ID_RE =
  /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)?(:[A-Za-z0-9._-]+)?$/;
export const MODEL_ID_MAX = 120;

export function isValidModelId(id: string): boolean {
  return id.length > 0 && id.length <= MODEL_ID_MAX && MODEL_ID_RE.test(id);
}

/**
 * The native Anthropic and Gemini adapters serve a pin from another vendor
 * with their own default model, so the result would name a model that never
 * ran. Those two tabs only accept their own family (routes/playground.ts
 * enforces the same rule).
 */
export function modelFitsProvider(provider: PlaygroundProvider, id: string): boolean {
  if (provider === "anthropic") return /^(anthropic\/)?claude-/i.test(id);
  if (provider === "gemini") return /^(google\/)?gemini/i.test(id);
  return true;
}

/** "$0.30 / $2.50" — the list price per 1M tokens, input / output. */
export function formatPrice(model: PlaygroundModel): string {
  const usd = (n: number) => {
    const cents = Math.round((n + Number.EPSILON) * 100) / 100;
    return Number.isInteger(cents) ? `$${cents}` : `$${cents.toFixed(2)}`;
  };
  return `${usd(model.inPerM)} / ${usd(model.outPerM)}`;
}

/** The short model name shown under a result ("gemini-2.5-flash"). */
export function shortModelName(id: string): string {
  return id.split("/").pop() ?? id;
}

/** Key shape hint per provider (placeholder text only, never a real key). */
export const KEY_PLACEHOLDER: Record<PlaygroundProvider, string> = {
  openrouter: "sk-or-…",
  anthropic: "sk-ant-…",
  openai: "sk-…",
  gemini: "AIza…",
};

export const PROVIDER_LABEL: Record<PlaygroundProvider, string> = {
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google",
};

/** Where a visitor creates a key for each provider. */
export const KEY_URL: Record<PlaygroundProvider, string> = {
  openrouter: "https://openrouter.ai/keys",
  anthropic: "https://platform.claude.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey",
};
