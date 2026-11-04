/**
 * Eval-only fetch tap: per-call latency and token usage for every provider
 * request, so a benchmark cell is priced from measured numbers. Records
 * model, status, timings and token counts only: never request or response
 * content, never headers (no API key).
 *
 * Install it before the first LLM call; the provider SDK clients are created
 * lazily on first use and pick up the wrapped global fetch.
 */
import { estimateModelCostUsd } from "../llm/model-fallback.js";

export interface CallRecord {
  model: string;
  status: number;
  ms: number;
  /** All prompt tokens, cache reads and writes included. */
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

type Rec = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null ? (v as Rec) : {});

/** Anthropic Messages or OpenAI chat-completions response body → usage. */
export function usageFromBody(body: unknown): Omit<CallRecord, "status" | "ms"> | null {
  const b = rec(body);
  const usage = rec(b.usage);
  if (Object.keys(usage).length === 0) return null;
  const model = typeof b.model === "string" ? b.model : "unknown";
  if ("input_tokens" in usage) {
    const read = num(usage.cache_read_input_tokens);
    const write = num(usage.cache_creation_input_tokens);
    return {
      model,
      promptTokens: num(usage.input_tokens) + read + write,
      completionTokens: num(usage.output_tokens),
      cacheReadTokens: read,
      cacheWriteTokens: write,
    };
  }
  const details = rec(usage.prompt_tokens_details);
  return {
    model,
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    cacheReadTokens: num(details.cached_tokens),
    cacheWriteTokens: num(details.cache_write_tokens),
  };
}

export function callCostUsd(call: CallRecord): number {
  return estimateModelCostUsd(call.model, call.promptTokens, call.completionTokens, {
    readTokens: call.cacheReadTokens,
    writeTokens: call.cacheWriteTokens,
  });
}

const LLM_URL_RE =
  /^https:\/\/(api\.anthropic\.com\/v1\/messages|openrouter\.ai\/api\/v1\/chat\/completions|generativelanguage\.googleapis\.com\/)/;

export interface CallTap {
  calls: CallRecord[];
  /** Wait for in-flight body reads before summarising. */
  settle(): Promise<void>;
}

export function installCallTap(): CallTap {
  const original = globalThis.fetch;
  const calls: CallRecord[] = [];
  const pending = new Set<Promise<void>>();
  globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const started = performance.now();
    const response = await original(input, init);
    if (!LLM_URL_RE.test(url)) return response;
    const read = response
      .clone()
      .json()
      .then((body: unknown) => {
        const usage = usageFromBody(body);
        calls.push({
          ...(usage ?? {
            model: "unknown",
            promptTokens: 0,
            completionTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          }),
          status: response.status,
          ms: performance.now() - started,
        });
      })
      .catch((err: unknown) => {
        // A non-JSON body (e.g. an HTML 502) still counts as a call; say why its usage is 0.
        const why = err instanceof Error ? err.name : "unknown error";
        console.warn(
          `[call-tap] status ${response.status}: response body unreadable (${why}); usage recorded as 0`,
        );
        calls.push({
          model: "unknown",
          status: response.status,
          ms: performance.now() - started,
          promptTokens: 0,
          completionTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
      });
    pending.add(read);
    void read.finally(() => pending.delete(read));
    return response;
  };
  return {
    calls,
    settle: async () => {
      await Promise.all([...pending]);
    },
  };
}
