/**
 * The MCP surface — Klorn's inbox as Model Context Protocol tools, built on
 * the assistant chat's LOCKED-DOWN toolset and then narrowed further:
 * create_event is excluded too (chat intercepts it into a review card; MCP
 * has no review surface), so everything reachable here is read-only or
 * LOW-risk (one bounded exception: generate_briefing may create the day's
 * briefing notification — deduped to at most one push per user per day). Execution reuses executeToolCall — same result caps, and the
 * floor-action hard stop (send_email needs a verified receipt) stays as the
 * second layer under the whitelist.
 *
 * A key with read_write permission (MCP_WRITE_TOOLS_ENABLED on) additionally
 * gets the MCP-only write set — see tool-gate.ts. Every call to a write tool is
 * audited whether or not it is allowed (write-audit.ts, write-call.ts).
 */

import type { ApiKeyPermissionWire } from "@klorn/contract";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { executeToolCall } from "../agentcore/tool-executor.js";
import { isMcpWriteTool, mcpToolDefs } from "./tool-gate.js";
import { errorResult, type McpToolResult, textResult, unknownToolResult } from "./tool-result.js";
import { recordRefusedWrite } from "./write-audit.js";
import { runMcpWriteCall } from "./write-call.js";

/** The authenticated key behind a request, as `authenticateApiKey` resolved it. */
export interface McpKeyContext {
  keyId: string;
  permission: ApiKeyPermissionWire;
}

async function runReadTool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    return textResult(await executeToolCall(userId, name, args));
  } catch (err) {
    // executeToolCall already maps most failures to {"error"} strings; a
    // throw here is the floor-action stop or a genuine crash — either way
    // an in-band tool error, never a dead transport.
    return errorResult(err instanceof Error ? err.message : "Tool failed.");
  }
}

/** One server per request (stateless Streamable HTTP) — cheap: handlers
 * close over userId/plan/key, no per-user state lives on the instance. */
export function buildMcpServer(userId: string, plan: string, key: McpKeyContext): Server {
  const server = new Server({ name: "klorn", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mcpToolDefs(plan, key.permission).map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      inputSchema: tool.function.parameters as { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    // Fail closed against anything outside the MCP set — including tools
    // that exist elsewhere in the registry (send_email, delete_email).
    const admitted = mcpToolDefs(plan, key.permission).some((tool) => tool.function.name === name);
    if (!admitted) {
      // A refused write is audited best-effort, fire-and-forget: the response
      // is byte-identical to any unknown tool and arrives at the same speed,
      // so a key without write access cannot tell a write tool exists. The
      // audit is a no-op while the write flag is off and is throttled per key
      // (write-audit.ts), so this path cannot be used to flood the database.
      if (isMcpWriteTool(name)) {
        void recordRefusedWrite({
          userId,
          apiKeyId: key.keyId,
          tool: name,
          args,
          reason: "permission_denied",
        });
      }
      return unknownToolResult(name);
    }
    if (isMcpWriteTool(name)) {
      return runMcpWriteCall({ userId, apiKeyId: key.keyId, name, args });
    }
    return runReadTool(userId, name, args);
  });

  return server;
}
