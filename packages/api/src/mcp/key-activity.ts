/**
 * Read side of the MCP write audit (step A3 of
 * docs/providers/unified-platform-plan.md): the newest rows one key left in
 * McpWriteAudit, shaped for the settings page.
 *
 * The wire shape is an allow-list. `select` names the five columns that may
 * leave the database, and `toWire` copies them by name, so the argument hash,
 * the row id, the user id and the key id cannot reach a response even if a
 * future column is added or the query is widened.
 */

import type { ApiKeyActivityWire } from "@klorn/contract";
import { prisma } from "../db.js";

/** Rows returned per key. The table is swept after 90 days; this bounds one response. */
export const KEY_ACTIVITY_LIMIT = 50;

const ACTIVITY_SELECT = {
  tool: true,
  outcome: true,
  reason: true,
  targetId: true,
  createdAt: true,
} as const;

interface ActivityRow {
  tool: string;
  outcome: ApiKeyActivityWire["outcome"];
  reason: string | null;
  targetId: string | null;
  createdAt: Date;
}

function toWire(row: ActivityRow): ApiKeyActivityWire {
  return {
    tool: row.tool,
    outcome: row.outcome,
    reason: row.reason,
    targetId: row.targetId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The key's most recent audit rows, newest first. `userId` is in the filter as
 * well as the key id, so a row is only ever read by its own user. The id
 * tie-break keeps the order stable for rows written in the same millisecond.
 */
export async function listKeyActivity(
  userId: string,
  apiKeyId: string,
): Promise<ApiKeyActivityWire[]> {
  const rows = await prisma.mcpWriteAudit.findMany({
    where: { apiKeyId, userId },
    select: ACTIVITY_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: KEY_ACTIVITY_LIMIT,
  });
  return rows.map(toWire);
}
