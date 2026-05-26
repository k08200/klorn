/**
 * Batch Tool Execution — Run independent tool calls in parallel with bounded concurrency.
 *
 * Used by both chat routes and autonomous agent to execute multiple
 * tool calls from a single LLM turn concurrently instead of sequentially.
 *
 * Safety: Only tools that are independent (no shared state mutation between them)
 * should be batched. The caller is responsible for partitioning tool calls.
 */

import { Semaphore } from "./semaphore.js";
import { executeToolCall } from "./tool-executor.js";

/** Default max concurrent tool executions */
const DEFAULT_CONCURRENCY = 5;

const semaphore = new Semaphore(DEFAULT_CONCURRENCY);

interface ToolCallInput {
  id: string;
  userId: string;
  functionName: string;
  args: Record<string, unknown>;
}

interface ToolCallResult {
  tool_call_id: string;
  content: string;
}

/**
 * Execute multiple tool calls in parallel with bounded concurrency.
 * Returns results in the same order as inputs.
 */
export async function executeBatch(calls: ToolCallInput[]): Promise<ToolCallResult[]> {
  if (calls.length === 0) return [];
  if (calls.length === 1) {
    const c = calls[0];
    const content = await executeToolCall(c.userId, c.functionName, c.args);
    return [{ tool_call_id: c.id, content }];
  }

  return semaphore.all(
    calls.map(
      (c) => () =>
        executeToolCall(c.userId, c.functionName, c.args).then((content) => ({
          tool_call_id: c.id,
          content,
        })),
    ),
  );
}

/**
 * Tools that are safe to execute in parallel (read-only or idempotent).
 * These have no cross-tool dependencies and won't cause race conditions.
 */
const BATCHABLE_TOOLS = new Set([
  // Read-only
  "list_emails",
  "read_email",
  "list_events",
  "check_conflicts",
  "web_search",
  "get_weather",
  "get_news",
  "get_current_time",
  "recall",
  "list_skills",
  "get_briefing",
  "get_upcoming_meetings",
  "get_system_info",
  "get_running_apps",
  "get_clipboard",
  "calculate",
  "translate",
  "convert_currency",
  // Idempotent writes (creating independent resources)
  "mark_read",
  "classify_emails",
]);

/** Check if a tool is safe to batch with others */
export function isBatchable(toolName: string): boolean {
  return BATCHABLE_TOOLS.has(toolName);
}
