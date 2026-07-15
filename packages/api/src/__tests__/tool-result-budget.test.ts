import { describe, expect, it } from "vitest";
import { capToolResult, MAX_TOOL_RESULT_CHARS } from "../agentcore/tool-result-budget.js";

describe("capToolResult", () => {
  it("passes short results through unchanged", () => {
    const raw = JSON.stringify({ ok: true, data: "small" });
    expect(capToolResult(raw)).toBe(raw);
  });

  it("passes results at the exact limit through unchanged", () => {
    const raw = "x".repeat(MAX_TOOL_RESULT_CHARS);
    expect(capToolResult(raw)).toBe(raw);
  });

  it("truncates oversized results into a structured envelope", () => {
    const raw = "y".repeat(MAX_TOOL_RESULT_CHARS + 10_000);
    const capped = capToolResult(raw);
    const parsed = JSON.parse(capped);
    expect(parsed.truncated).toBe(true);
    expect(parsed.original_chars).toBe(raw.length);
    expect(parsed.max_chars).toBe(MAX_TOOL_RESULT_CHARS);
    expect(parsed.content).toHaveLength(MAX_TOOL_RESULT_CHARS);
    expect(parsed.content.startsWith("y")).toBe(true);
  });

  it("signals truncation so the model can react", () => {
    const raw = "z".repeat(MAX_TOOL_RESULT_CHARS + 1);
    const capped = capToolResult(raw);
    expect(capped).toContain('"truncated":true');
    expect(capped).toContain('"reason"');
  });

  it("keeps the envelope small even for massive inputs", () => {
    const raw = "a".repeat(MAX_TOOL_RESULT_CHARS * 10);
    const capped = capToolResult(raw);
    // Envelope adds a small overhead but must not re-include the whole raw string.
    expect(capped.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 500);
  });
});
