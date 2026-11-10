/**
 * The MCP tool gate — the ONE place that decides which tools a key sees
 * (ListTools) and may call (CallTool), so the two can never disagree.
 *
 * The read set is exactly what MCP has always served: the assistant chat's
 * locked-down tools minus create_event (chat intercepts it into a review card;
 * MCP has no review surface), team_availability only while team mode is on,
 * every tool plan-gated. The write set is MCP-only and separate: it is NOT in
 * CHAT_TOOL_NAMES (that would put it in chat) and its members are not added to
 * ALL_TOOLS (that would put them in front of the autonomous agent). A write tool
 * that already exists there (mark_read) reuses its definition; one that does not
 * (set_tier, create_draft) carries its own MCP-only definition (mcp/set-tier.ts,
 * mcp/create-draft.ts).
 *
 * Write tools are visible and callable only when the key's permission is
 * read_write AND MCP_WRITE_TOOLS_ENABLED is on. `authenticateApiKey` already
 * folds the flag into the permission it returns; the gate reads the flag itself
 * as well, so a caller that hands it a stale or hand-built permission still
 * cannot get a write tool while the flag is off.
 */

import type { ApiKeyPermissionWire } from "@klorn/contract";
import { CHAT_TOOL_NAMES } from "../agentcore/chat-engine.js";
import { ALL_TOOLS, isToolAllowedForPlan } from "../agentcore/tool-executor.js";
import { mcpWriteToolsEnabled, teamModeEnabled } from "../config.js";
import { CREATE_DRAFT_TOOL, CREATE_DRAFT_TOOL_NAME } from "./create-draft.js";
import { SET_TIER_TOOL, SET_TIER_TOOL_NAME } from "./set-tier.js";

/** Tools the chat allows but MCP must not: they need a human-review surface
 * this transport does not have. */
const MCP_EXCLUDED: ReadonlySet<string> = new Set(["create_event"]);

/** Tools that change state over MCP. Audited on every call, gated by permission. */
export const MCP_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "mark_read",
  SET_TIER_TOOL_NAME,
  CREATE_DRAFT_TOOL_NAME,
]);

/** Write tools with no ALL_TOOLS entry: MCP-only by construction, so no other surface can reach them. */
const MCP_ONLY_WRITE_TOOLS = [SET_TIER_TOOL, CREATE_DRAFT_TOOL] as const;

export function isMcpWriteTool(name: string): boolean {
  return MCP_WRITE_TOOL_NAMES.has(name);
}

function readToolDefs(plan: string) {
  return ALL_TOOLS.filter(
    (tool) =>
      CHAT_TOOL_NAMES.has(tool.function.name) &&
      !MCP_EXCLUDED.has(tool.function.name) &&
      (tool.function.name !== "team_availability" || teamModeEnabled()) &&
      isToolAllowedForPlan(tool.function.name, plan),
  );
}

function writeToolDefs(plan: string) {
  const reused = ALL_TOOLS.filter((tool) => MCP_WRITE_TOOL_NAMES.has(tool.function.name));
  return [...reused, ...MCP_ONLY_WRITE_TOOLS].filter((tool) =>
    isToolAllowedForPlan(tool.function.name, plan),
  );
}

/** Tool definitions a key with `permission` may list and call on `plan`. */
export function mcpToolDefs(plan: string, permission: ApiKeyPermissionWire) {
  const read = readToolDefs(plan);
  if (permission !== "read_write" || !mcpWriteToolsEnabled()) return read;
  return [...read, ...writeToolDefs(plan)];
}
