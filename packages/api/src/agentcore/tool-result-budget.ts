/**
 * Cap on raw tool output handed back to the LLM.
 *
 * Large outputs (full file dumps, long email bodies, giant search hits) can
 * blow up the next prompt's token budget and cause OpenAI context-overflow
 * errors. 100K chars ≈ 30K tokens — a reasonable ceiling for a single tool
 * result. Oversized results are truncated and marked so the model knows the
 * truncation happened and can ask for a narrower query.
 */
export const MAX_TOOL_RESULT_CHARS = 100_000;

export function capToolResult(raw: string): string {
  if (raw.length <= MAX_TOOL_RESULT_CHARS) return raw;
  const head = raw.slice(0, MAX_TOOL_RESULT_CHARS);
  return JSON.stringify({
    truncated: true,
    reason: "tool result exceeded size budget",
    original_chars: raw.length,
    max_chars: MAX_TOOL_RESULT_CHARS,
    content: head,
  });
}
