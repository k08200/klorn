/**
 * Anthropic provider settings that need no SDK: the default model, the env
 * knobs and model-id translation. Kept apart from anthropic-native.ts so the
 * provider registry can resolve models and read config at boot WITHOUT loading
 * @anthropic-ai/sdk (measured +19.5 MB RSS) on deployments that never set
 * ANTHROPIC_API_KEY; the adapter is imported on first call.
 */

/** Cheapest current Claude model; the default when a pin is not a Claude id. */
export const RECOMMENDED_ANTHROPIC_MODEL = "claude-haiku-5-5";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AnthropicEffort = (typeof EFFORTS)[number];

export interface AnthropicCallOptions {
  /** Prompt-cache TTL for the system breakpoint; null = caching off. */
  readonly cacheTtl: "5m" | "1h" | null;
  /** `output_config.effort`; null = model default (not sent). */
  readonly effort: AnthropicEffort | null;
  /**
   * JSON mode as a FORCED tool call (default; no thinking, cheapest) or, when
   * false, tool_choice auto so the model may think first. Absent = forced.
   */
  readonly forceJsonTool?: boolean;
}

/**
 * Env knobs, validated so a typo degrades to the default instead of 400ing
 * every call: ANTHROPIC_PROMPT_CACHE=false, ANTHROPIC_CACHE_TTL=1h,
 * ANTHROPIC_EFFORT=low|medium|high|xhigh|max, ANTHROPIC_JSON_TOOL_CHOICE=auto.
 */
export function readAnthropicCallOptions(
  env: Record<string, string | undefined>,
): AnthropicCallOptions {
  const off = ["false", "0", "off", "no"].includes(
    (env.ANTHROPIC_PROMPT_CACHE ?? "").trim().toLowerCase(),
  );
  const ttl = (env.ANTHROPIC_CACHE_TTL ?? "").trim().toLowerCase();
  const effort = (env.ANTHROPIC_EFFORT ?? "").trim().toLowerCase();
  return {
    cacheTtl: off ? null : ttl === "1h" ? "1h" : "5m",
    effort: (EFFORTS as readonly string[]).includes(effort) ? (effort as AnthropicEffort) : null,
    forceJsonTool: (env.ANTHROPIC_JSON_TOOL_CHOICE ?? "").trim().toLowerCase() !== "auto",
  };
}

/**
 * Translate a caller's model pin into a native Claude id. Native ids pass
 * through; OpenRouter ids (`anthropic/claude-haiku-4.5`) become native
 * (`claude-haiku-4-5`); anything else is served by `fallback`, exactly as the
 * Gemini provider serves a non-Gemini pin with its own default.
 */
export function toAnthropicModelId(requested: string, fallback: string): string {
  const id = (typeof requested === "string" ? requested : "").trim().split(":")[0] ?? "";
  if (/^claude-/i.test(id)) return id;
  const routed = id.match(/^anthropic\/(claude-[a-z0-9.-]+)$/i);
  if (routed) return routed[1].replace(/\./g, "-");
  return fallback;
}
