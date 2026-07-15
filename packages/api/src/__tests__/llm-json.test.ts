/**
 * parseLlmJson — tolerant parsing of LLM completion content.
 *
 * Locks the contract that the firewall's judge/classifier survive a fallback
 * model that wraps its JSON in a markdown fence. The real-world trigger:
 * meta-llama/llama-3.3-70b-instruct:free (OpenRouter fallback chain #1) returns
 * ```json … ``` while the paid gemini default returns bare JSON.
 */
import { describe, expect, it } from "vitest";
import { parseLlmJson } from "../llm/llm-json.js";

describe("parseLlmJson", () => {
  it("parses bare JSON (the paid-model happy path)", () => {
    expect(parseLlmJson('{"confidence":0.9,"urgency":0.8}')).toEqual({
      confidence: 0.9,
      urgency: 0.8,
    });
  });

  it("parses JSON wrapped in a ```json fence (llama-3.3-70b:free shape)", () => {
    const fenced = '```json\n{"confidence":0.9,"urgency":0.8}\n```';
    expect(parseLlmJson(fenced)).toEqual({ confidence: 0.9, urgency: 0.8 });
  });

  it("parses JSON wrapped in a bare ``` fence (no language tag)", () => {
    const fenced = '```\n{"a":1}\n```';
    expect(parseLlmJson(fenced)).toEqual({ a: 1 });
  });

  it("tolerates surrounding whitespace around the fence", () => {
    const fenced = '  \n```json\n{"a":1}\n```  \n';
    expect(parseLlmJson(fenced)).toEqual({ a: 1 });
  });

  it("does not corrupt JSON whose string values contain backticks", () => {
    expect(parseLlmJson('{"reason":"use `npm run build`"}')).toEqual({
      reason: "use `npm run build`",
    });
  });

  it("parses a JSON array inside a fence (commitment-path step list shape)", () => {
    const fenced = '```json\n[{"step":"a"},{"step":"b"}]\n```';
    expect(parseLlmJson(fenced)).toEqual([{ step: "a" }, { step: "b" }]);
  });

  it("tolerates CRLF line endings around the fence (Windows-hosted models)", () => {
    const fenced = '```json\r\n{"a":1}\r\n```';
    expect(parseLlmJson(fenced)).toEqual({ a: 1 });
  });

  it("throws when prose trails the closing fence (caller falls back)", () => {
    // A degenerate model output. Anchored stripping leaves the trailing prose,
    // so JSON.parse throws and the caller's existing error path handles it —
    // same outcome as the old bare JSON.parse, never a silent wrong parse.
    expect(() => parseLlmJson('```json\n{"a":1}\n```\nNote: hope this helps')).toThrow();
  });

  it("throws on empty content", () => {
    expect(() => parseLlmJson("")).toThrow();
    expect(() => parseLlmJson("   ")).toThrow();
  });

  it("throws on non-JSON garbage", () => {
    expect(() => parseLlmJson("not json at all")).toThrow();
  });
});
