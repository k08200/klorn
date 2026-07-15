import { db } from "../db.js";
import { estimateModelCostUsd } from "../model-fallback.js";
import { captureError } from "../sentry.js";

/** OpenAI-shaped usage block returned alongside a completion. */
export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * Persist one LLM call's token counts + estimated cost for cost monitoring.
 *
 * Fire-and-forget from the agent loop: a telemetry write must never break the
 * loop. But it must not vanish silently either — a swallowed failure loses ALL
 * cost/token observability with zero signal, so a failed write is logged and
 * captured (console + Sentry) rather than dropped.
 */
export async function trackTokenUsage(
  userId: string,
  usage: LlmUsage | undefined,
  modelName: string,
): Promise<void> {
  if (!usage) return;
  const prompt = usage.prompt_tokens || 0;
  const completion = usage.completion_tokens || 0;
  const total = usage.total_tokens || prompt + completion;
  const estimatedCost = estimateModelCostUsd(modelName, prompt, completion);
  try {
    await db.tokenUsage.create({
      data: {
        userId,
        model: modelName,
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: total,
        estimatedCost,
      },
    });
  } catch (err) {
    console.error(`[token-usage] failed to persist usage for ${userId}/${modelName}:`, err);
    captureError(err, {
      tags: { scope: "agent.track_token_usage" },
      extra: { userId, model: modelName },
    });
  }
}
