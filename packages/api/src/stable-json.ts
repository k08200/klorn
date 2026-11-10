/**
 * JSON with object keys sorted at every depth, so equal values serialise to the
 * same string whatever their insertion order. Used where the string is hashed
 * into something persisted: action-outbox idempotency keys and the MCP write
 * audit's argument hash. The output is therefore a compatibility surface — a
 * change here silently changes stored keys. Golden vectors in
 * `__tests__/action-outbox.test.ts` and `__tests__/mcp-write-audit.test.ts` pin it.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
