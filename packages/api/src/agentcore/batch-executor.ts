/**
 * Batch Tool Executor — Execute multiple tool calls concurrently with semaphore control.
 *
 * Limits concurrency to prevent overloading external APIs while still
 * benefiting from parallelism when multiple independent tools are called.
 */

import { executeToolCall } from "./tool-executor.js";

/** Maximum concurrent tool executions per batch */
const MAX_CONCURRENT_TOOLS = 3;

export interface BatchToolCall {
  id: string;
  functionName: string;
  args: Record<string, unknown>;
}

export interface BatchToolResult {
  id: string;
  result: string;
  error?: string;
}

/**
 * Execute multiple tool calls concurrently with a semaphore limit.
 * Returns results in the same order as the input calls.
 */
export async function executeBatchToolCalls(
  userId: string,
  calls: BatchToolCall[],
): Promise<BatchToolResult[]> {
  if (calls.length === 0) return [];
  if (calls.length === 1) {
    try {
      const result = await executeToolCall(userId, calls[0].functionName, calls[0].args);
      return [{ id: calls[0].id, result }];
    } catch (err) {
      return [
        {
          id: calls[0].id,
          result: "",
          error: err instanceof Error ? err.message : "Unknown error",
        },
      ];
    }
  }

  // Semaphore-based concurrency control
  let running = 0;
  const resolvers: Array<() => void> = [];
  const results: BatchToolResult[] = new Array(calls.length);

  function release() {
    running--;
    const next = resolvers.shift();
    if (next) next();
  }

  async function acquire(): Promise<void> {
    if (running < MAX_CONCURRENT_TOOLS) {
      running++;
      return;
    }
    return new Promise<void>((resolve) => resolvers.push(resolve)).then(() => {
      running++;
    });
  }

  const tasks = calls.map(async (call, i) => {
    await acquire();
    try {
      const result = await executeToolCall(userId, call.functionName, call.args);
      results[i] = { id: call.id, result };
    } catch (err) {
      results[i] = {
        id: call.id,
        result: "",
        error: err instanceof Error ? err.message : "Unknown error",
      };
    } finally {
      release();
    }
  });

  await Promise.all(tasks);
  return results;
}
