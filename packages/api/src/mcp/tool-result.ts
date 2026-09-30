/** The two MCP CallTool result shapes, built in one place so every path answers alike. */

export interface McpToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** A tool's own output, passed through untouched. No `isError` key, as on main. */
export function textResult(text: string): McpToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/** An in-band tool error — never a dead transport. */
export function errorResult(message: string, extra: Record<string, unknown> = {}): McpToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }) }],
    isError: true,
  };
}

/** Answer for anything outside the served set. Also what a key with no write access
 * gets for a write tool, so it cannot tell that tool exists. */
export function unknownToolResult(name: string): McpToolResult {
  return errorResult(`Unknown tool: ${name}`);
}
