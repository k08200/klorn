import type { DailyCostCapCode } from "./openai.js";

/** HTTP status every surface answers when the daily cost cap refuses a call. */
export const COST_CAP_HTTP_STATUS = 429;

/**
 * The body every surface answers with when the daily cost cap refuses an LLM
 * call: the error's own user-facing message plus a stable code clients branch
 * on, so the cap is never mistaken for a transient "try again" failure.
 */
export interface CostCapRefusal {
  error: string;
  code: DailyCostCapCode;
}

/**
 * The refusal for `err` when it is a DailyCostCapExceededError, else null.
 * Matched by name, not instanceof — the codebase-wide convention, so a test
 * double of llm/openai.js still matches — and an error without a known code
 * reads as the generic cap. A type-only import keeps this module free of the
 * provider stack, so the global error handler can use it.
 */
export function costCapRefusal(err: unknown): CostCapRefusal | null {
  if (!(err instanceof Error) || err.name !== "DailyCostCapExceededError") return null;
  const code = (err as { code?: unknown }).code;
  return {
    error: err.message,
    code: code === "DAILY_COST_CAP_FREE" ? "DAILY_COST_CAP_FREE" : "DAILY_COST_CAP",
  };
}
