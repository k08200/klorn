/**
 * Tolerant JSON parsing for LLM completion content.
 *
 * The judge/classifier prompts ask for raw JSON and set
 * `response_format: { type: "json_object" }`. The hosted models honour that
 * and return bare JSON, but smaller models (local OpenAI-compatible servers,
 * cheap fallback SKUs) can ignore both the instruction and the response_format
 * hint and wrap their output in a ```json … ``` markdown fence. A bare
 * `JSON.parse` then throws on the leading backtick, the caller degrades to its
 * no-LLM keyword fallback, and every such email silently drops to the QUEUE
 * floor. Stripping the fence here keeps those models usable.
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
