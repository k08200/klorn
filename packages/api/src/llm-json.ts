/**
 * Tolerant JSON parsing for LLM completion content.
 *
 * The judge/classifier prompts ask for raw JSON and set
 * `response_format: { type: "json_object" }`. The paid default model
 * (gemini-2.5-flash) honors that and returns bare JSON. But the OpenRouter
 * `:free` fallback chain (e.g. meta-llama/llama-3.3-70b-instruct:free) ignores
 * both the instruction and the response_format hint and wraps its output in a
 * ```json … ``` markdown fence. A bare `JSON.parse` then throws on the leading
 * backtick, the caller degrades to its no-LLM keyword fallback, and every
 * fallback-served email silently drops to the QUEUE floor — the fallback-drift
 * failure mode that only appears once a `:free` SKU takes over from the paid
 * model. Stripping the fence here makes the fallback chain actually usable
 * instead of cosmetically present.
 */
export function parseLlmJson<T = unknown>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty completion content");
  // Strip a single anchored leading ```lang fence and trailing ``` fence.
  // Anchored to start/end only, so backticks inside JSON string values are
  // left intact.
  const unfenced = trimmed
    .replace(/^```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?\s*```$/, "")
    .trim();
  return JSON.parse(unfenced) as T;
}
