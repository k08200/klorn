import { describe, expect, it, vi } from "vitest";

vi.mock("../agentcore/tool-executor.js", () => ({
  executeToolCall: vi.fn(async (_userId: string, fnName: string, args: Record<string, unknown>) => {
    return JSON.stringify({ tool: fnName, args, success: true });
  }),
}));

const { executeBatch, isBatchable } = await import("../agentcore/batch-tools.js");

describe("executeBatch", () => {
  it("returns empty array for empty input", async () => {
    const results = await executeBatch([]);
    expect(results).toEqual([]);
  });

  it("executes single tool call", async () => {
    const results = await executeBatch([
      { id: "call-1", userId: "u1", functionName: "list_emails", args: {} },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].tool_call_id).toBe("call-1");
    expect(JSON.parse(results[0].content)).toMatchObject({ tool: "list_emails", success: true });
  });

  it("executes multiple tool calls in parallel", async () => {
    const results = await executeBatch([
      { id: "call-1", userId: "u1", functionName: "list_emails", args: {} },
      { id: "call-2", userId: "u1", functionName: "list_events", args: {} },
      { id: "call-3", userId: "u1", functionName: "get_weather", args: { city: "Seoul" } },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0].tool_call_id).toBe("call-1");
    expect(results[1].tool_call_id).toBe("call-2");
    expect(results[2].tool_call_id).toBe("call-3");
  });

  it("preserves order even when tasks complete at different times", async () => {
    const { executeToolCall } = await import("../agentcore/tool-executor.js");
    const mock = vi.mocked(executeToolCall);
    mock.mockImplementation(async (_u, fn) => {
      const delays: Record<string, number> = { slow: 30, fast: 5 };
      await new Promise((r) => setTimeout(r, delays[fn] || 0));
      return JSON.stringify({ tool: fn });
    });

    const results = await executeBatch([
      { id: "a", userId: "u1", functionName: "slow", args: {} },
      { id: "b", userId: "u1", functionName: "fast", args: {} },
    ]);

    expect(results[0].tool_call_id).toBe("a");
    expect(results[1].tool_call_id).toBe("b");
  });
});

describe("isBatchable", () => {
  it("returns true for read-only tools", () => {
    expect(isBatchable("list_emails")).toBe(true);
    expect(isBatchable("list_events")).toBe(true);
    expect(isBatchable("web_search")).toBe(true);
    expect(isBatchable("get_weather")).toBe(true);
    expect(isBatchable("recall")).toBe(true);
    expect(isBatchable("list_skills")).toBe(true);
  });

  it("returns true for idempotent writes", () => {
    expect(isBatchable("mark_read")).toBe(true);
    expect(isBatchable("classify_emails")).toBe(true);
  });

  it("returns false for non-batchable tools", () => {
    expect(isBatchable("send_email")).toBe(false);
    expect(isBatchable("delete_email")).toBe(false);
    expect(isBatchable("propose_action")).toBe(false);
    expect(isBatchable("unknown_tool")).toBe(false);
  });
});
