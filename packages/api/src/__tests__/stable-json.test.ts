/**
 * stableStringify — JSON with object keys sorted at every depth, shared by the
 * action outbox (idempotency keys) and the MCP write audit (argument hash).
 * Its output is part of persisted keys, so it must never drift.
 */

import { describe, expect, it } from "vitest";
import { stableStringify } from "../stable-json.js";

describe("stableStringify", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(stableStringify({ b: 1, a: { d: [3, 1, 2], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1,2]},"b":1}',
    );
  });

  it("is independent of insertion order", () => {
    expect(stableStringify({ x: 1, y: { p: true, q: "s" } })).toBe(
      stableStringify({ y: { q: "s", p: true }, x: 1 }),
    );
  });

  it("serialises primitives like JSON.stringify and maps undefined to null", () => {
    expect(stableStringify("a\u0000b🙂")).toBe(JSON.stringify("a\u0000b🙂"));
    expect(stableStringify(12.5)).toBe("12.5");
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(undefined)).toBe("null");
    expect(stableStringify([])).toBe("[]");
    expect(stableStringify({})).toBe("{}");
  });

  it("does not confuse a string that looks like JSON with the JSON itself", () => {
    expect(stableStringify({ a: "1" })).not.toBe(stableStringify({ a: 1 }));
  });
});
