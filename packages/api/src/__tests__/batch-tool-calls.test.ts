import { describe, expect, it, vi } from "vitest";

const executeToolCallMock = vi.fn(async (_userId: string, fn: string) => {
  if (fn === "fail_tool") throw new Error("Tool failed");
  return JSON.stringify({ tool: fn, ok: true });
});

vi.mock("../agentcore/tool-executor.js", () => ({
  executeToolCall: (...args: unknown[]) =>
    executeToolCallMock(...(args as [string, string, Record<string, unknown>])),
}));

import { executeBatchToolCalls } from "../agentcore/batch-executor.js";

describe("executeBatchToolCalls", () => {
  it("returns empty array for empty input", async () => {
    const results = await executeBatchToolCalls("u1", []);
    expect(results).toEqual([]);
  });

  it("executes single call", async () => {
    const results = await executeBatchToolCalls("u1", [
      { id: "c1", functionName: "list_tasks", args: {} },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("c1");
    expect(results[0].error).toBeUndefined();
  });

  it("executes multiple calls concurrently", async () => {
    const results = await executeBatchToolCalls("u1", [
      { id: "c1", functionName: "list_tasks", args: {} },
      { id: "c2", functionName: "list_notes", args: {} },
      { id: "c3", functionName: "list_contacts", args: {} },
    ]);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("handles errors in individual calls without failing others", async () => {
    const results = await executeBatchToolCalls("u1", [
      { id: "c1", functionName: "list_tasks", args: {} },
      { id: "c2", functionName: "fail_tool", args: {} },
      { id: "c3", functionName: "list_notes", args: {} },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0].error).toBeUndefined();
    expect(results[1].error).toBe("Tool failed");
    expect(results[2].error).toBeUndefined();
  });

  it("preserves order regardless of execution timing", async () => {
    const results = await executeBatchToolCalls("u1", [
      { id: "a", functionName: "t1", args: {} },
      { id: "b", functionName: "t2", args: {} },
      { id: "c", functionName: "t3", args: {} },
      { id: "d", functionName: "t4", args: {} },
      { id: "e", functionName: "t5", args: {} },
    ]);
    expect(results.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("respects semaphore limit (max 3 concurrent)", async () => {
    let maxConcurrent = 0;
    let current = 0;

    executeToolCallMock.mockImplementation(async () => {
      current++;
      if (current > maxConcurrent) maxConcurrent = current;
      await new Promise((r) => setTimeout(r, 10));
      current--;
      return "ok";
    });

    await executeBatchToolCalls("u1", [
      { id: "1", functionName: "t", args: {} },
      { id: "2", functionName: "t", args: {} },
      { id: "3", functionName: "t", args: {} },
      { id: "4", functionName: "t", args: {} },
      { id: "5", functionName: "t", args: {} },
      { id: "6", functionName: "t", args: {} },
    ]);

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });
});
