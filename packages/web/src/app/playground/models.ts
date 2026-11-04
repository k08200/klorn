/**
 * The playground's model menu — one typed source for ids, groups and prices.
 *
 * Founder decision 2026-10-30 (LOCKED, option A): list current flagship and
 * small models from the vendors, and make NO accuracy claim except the one
 * Klorn measured on the model its own judge runs. Since the Claude-only switch
 * (2026-11-01) that is claude-haiku-5-5, measured through the native Anthropic
 * provider at 55 · 54 · 54 · 55 · 52 of 56 over five runs of Klorn's fixed
 * 56-email test (packages/api/eval/README.md, "Native Anthropic provider").
 * Every other model is listed as is.
 *
 * Each provider tab calls that vendor's own API with the visitor's own key, so
 * ids are the native spelling each API takes. A model reachable only through a
 * proxy (no native tab) is not listed.
 *
 * Prices are USD per 1M tokens (input / output), list prices recorded
 * 2026-10-30. Anthropic rows match packages/api/src/llm/model-fallback.ts
 * MODEL_RATES (Anthropic's pricing page, read 2026-10-24); the OpenAI and
 * Google rows were recorded from the OpenRouter catalog snapshot, which lists
 * provider prices. They are shown for orientation only and go stale.
 *
 * Pinned by packages/api/src/__tests__/web-playground-models.test.ts.
 */

export type PlaygroundProvider = "anthropic" | "openai" | "gemini";

export const PLAYGROUND_PROVIDERS: readonly PlaygroundProvider[] = [
  "anthropic",
  "openai",
  "gemini",
];

export type ModelGroup = "klorn" | "anthropic" | "google" | "openai";

/** Klorn's measured score: a range, because the model takes no temperature. */
export interface MeasuredScore {
  readonly low: number;
  readonly high: number;
  readonly total: number;
  readonly runs: number;
}

export interface PlaygroundModel {
  /** Native id, exactly as the provider's API takes it. */
  readonly id: string;
  readonly group: ModelGroup;
  /** USD per 1M input tokens, list price (2026-10-30). */
  readonly inPerM: number;
  /** USD per 1M output tokens, list price (2026-10-30). */
  readonly outPerM: number;
  /** The single measured claim; only the model Klorn uses carries it. */
  readonly measured?: MeasuredScore;
}

export const PRICES_CHECKED_ON = "2026-10-30";

/** The model Klorn's own judge runs on (render.yaml JUDGE_MODEL). */
export const KLORN_MODEL_ID = "claude-haiku-5-5";

/** Native catalog per provider tab. */
export const PLAYGROUND_MODELS: Readonly<Record<PlaygroundProvider, readonly PlaygroundModel[]>> = {
  anthropic: [
    {
      id: KLORN_MODEL_ID,
      group: "klorn",
      inPerM: 0.1,
      outPerM: 0.5,
      measured: { low: 52, high: 55, total: 56, runs: 5 },
    },
    { id: "claude-fable-5-1", group: "anthropic", inPerM: 10, outPerM: 50 },
    { id: "claude-opus-5-5", group: "anthropic", inPerM: 4, outPerM: 20 },
    { id: "claude-sonnet-5-5", group: "anthropic", inPerM: 2, outPerM: 10 },
  ],
  openai: [
    { id: "gpt-6.1-terra", group: "openai", inPerM: 1, outPerM: 5 },
    { id: "gpt-6.1-sol", group: "openai", inPerM: 2, outPerM: 10 },
    { id: "gpt-6-luna", group: "openai", inPerM: 0.1, outPerM: 0.5 },
  ],
  gemini: [
    { id: "gemini-4-argon", group: "google", inPerM: 2, outPerM: 10 },
    { id: "gemini-3.8-flash", group: "google", inPerM: 0.825, outPerM: 4.125 },
  ],
};

/** The models a provider tab offers, each with the id that provider takes. */
export function modelsFor(provider: PlaygroundProvider): readonly PlaygroundModel[] {
  return PLAYGROUND_MODELS[provider];
}

/**
 * Default per tab: the measured Klorn model where the tab can run it
 * (Anthropic); elsewhere the cheapest listed model (a cost default, not a
 * quality claim).
 */
export function defaultModelFor(provider: PlaygroundProvider): string {
  const list = modelsFor(provider);
  const klorn = list.find((m) => m.measured);
  if (klorn) return klorn.id;
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

/** The short model name shown under a result ("claude-haiku-5-5"). */
export function shortModelName(id: string): string {
  return id.split("/").pop() ?? id;
}

/** Key shape hint per provider (placeholder text only, never a real key). */
export const KEY_PLACEHOLDER: Record<PlaygroundProvider, string> = {
  anthropic: "sk-ant-…",
  openai: "sk-…",
  gemini: "AIza…",
};

export const PROVIDER_LABEL: Record<PlaygroundProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google",
};

/** Where a visitor creates a key for each provider. */
export const KEY_URL: Record<PlaygroundProvider, string> = {
  anthropic: "https://platform.claude.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey",
};
