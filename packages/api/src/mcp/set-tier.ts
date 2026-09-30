/**
 * `set_tier` — an MCP agent moves one email to a lane (step A2b of
 * docs/providers/unified-platform-plan.md). MCP-only: the definition lives here
 * and is NOT in ALL_TOOLS (that would hand it to the autonomous agent) or
 * CHAT_TOOL_NAMES (that would hand it to chat); mcp/tool-gate.ts adds it to the
 * write set and mcp/write-call.ts runs it, so the A2a gate, audit row and
 * per-user write cap apply unchanged.
 *
 * The lane change is AGENT-authored and is recorded as such:
 *  - it never goes through `overrideAttentionTier` and never sets
 *    `isManualOverride` — only a human action may (GHSA-cxc5-fmqv-pxv6);
 *  - it never stamps the DecisionLabel ledger: stamping is outcome-null-only and
 *    first-wins, so an agent stamp would block the human's later one;
 *  - it writes a tierReason that cannot match MANUAL_OVERRIDE_PREFIX, plus its
 *    own `agentTierSetAt` / `agentTierKeyId` columns, which every learning
 *    reader skips (judge/agent-tier.ts);
 *  - it fires nothing an injected agent could abuse: no push, banner, Telegram
 *    message, bell row or client wake-up, and no Gmail label. A label written
 *    (or not written) behind the tier's back is what label-correction would
 *    read as a human drag, so that path skips agent-set items
 *    (judge/label-correction.ts) instead.
 *
 * A human always wins: an item carrying `isManualOverride` is refused, and the
 * write itself is guarded on it, so a human override that lands between the read
 * and the write is not overwritten either.
 *
 * Read visibility lives in this write path: the result carries the previous and
 * the new lane. Read tools (list_emails / read_email) are deliberately left
 * untouched, so their results stay byte-identical for every key.
 */

import { prisma } from "../db.js";
import {
  AGENT_SETTABLE_TIERS,
  type AgentSettableTier,
  agentTierReason,
  agentVisibleLane,
  isAgentSettableTier,
} from "../judge/agent-tier.js";
import { normalizeTier } from "../judge/tiers.js";
import { captureError } from "../sentry.js";
import { MAX_TARGET_ID_LENGTH } from "./write-audit.js";

export const SET_TIER_TOOL_NAME = "set_tier";

export const SET_TIER_TOOL = {
  type: "function" as const,
  function: {
    name: SET_TIER_TOOL_NAME,
    description:
      "Move one email to a lane: PUSH, MEETING, QUEUE, INFO or SILENT. The result carries the " +
      "previous and the new lane. A lane the user chose by hand is never changed (the call is " +
      "refused), and lane changes made through this tool are marked as agent changes and never " +
      "train the classifier.",
    parameters: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "The email id as returned by list_emails or read_email.",
        },
        tier: {
          type: "string",
          enum: [...AGENT_SETTABLE_TIERS],
          description: "The lane to move the email to.",
        },
      },
      required: ["email_id", "tier"],
    },
  },
};

/** The caller: the user and the API key the call arrived on. */
export interface SetTierContext {
  userId: string;
  apiKeyId: string;
}

type SetTierErrorCode = "INVALID_ARGUMENT" | "NOT_FOUND" | "MANUAL_OVERRIDE" | "UNAVAILABLE";

const TIER_ERROR = `tier must be one of ${AGENT_SETTABLE_TIERS.join(", ")}.`;
const EMAIL_ID_ERROR = `email_id must be a non-empty string of at most ${MAX_TARGET_ID_LENGTH} characters.`;
const NOT_FOUND_ERROR = "No open email with this id in your inbox.";
const MANUAL_OVERRIDE_ERROR =
  "This email's lane was moved by the user by hand, so it was left as it is.";
const UNAVAILABLE_ERROR = "The lane could not be changed. Nothing was changed; try again.";

const fail = (code: SetTierErrorCode, error: string): string => JSON.stringify({ error, code });

const done = (
  emailId: string,
  previousTier: AgentSettableTier,
  tier: AgentSettableTier,
  changed: boolean,
): string =>
  JSON.stringify({ success: true, email_id: emailId, previous_tier: previousTier, tier, changed });

type ParsedArgs =
  | { ok: true; emailId: string; tier: AgentSettableTier }
  | { ok: false; error: string };

function parseArgs(args: Record<string, unknown>): ParsedArgs {
  const raw = typeof args.email_id === "string" ? args.email_id.trim() : "";
  if (raw.length === 0 || raw.length > MAX_TARGET_ID_LENGTH)
    return { ok: false, error: EMAIL_ID_ERROR };
  if (!isAgentSettableTier(args.tier)) return { ok: false, error: TIER_ERROR };
  return { ok: true, emailId: raw, tier: args.tier };
}

interface OpenItem {
  id: string;
  tier: string | null;
  isManualOverride: boolean;
}

/** The caller's OPEN email attention item for a DB id or provider id, same lookup shape as mark_read. */
async function findOpenItem(userId: string, emailId: string): Promise<OpenItem | null> {
  const email = await prisma.emailMessage.findFirst({
    where: { userId, OR: [{ id: emailId }, { gmailId: emailId }] },
    select: { id: true },
  });
  if (!email) return null;
  return prisma.attentionItem.findFirst({
    where: { userId, source: "EMAIL", sourceId: email.id, status: "OPEN" },
    select: { id: true, tier: true, isManualOverride: true },
  });
}

/** The guarded write matched nothing: say why, from the row's state now. */
async function explainLostWrite(userId: string, itemId: string): Promise<string> {
  const now = await prisma.attentionItem.findFirst({
    where: { id: itemId, userId },
    select: { isManualOverride: true },
  });
  return now?.isManualOverride
    ? fail("MANUAL_OVERRIDE", MANUAL_OVERRIDE_ERROR)
    : fail("NOT_FOUND", NOT_FOUND_ERROR);
}

async function changeLane(
  ctx: SetTierContext,
  emailId: string,
  tier: AgentSettableTier,
): Promise<string> {
  const item = await findOpenItem(ctx.userId, emailId);
  if (!item) return fail("NOT_FOUND", NOT_FOUND_ERROR);
  if (item.isManualOverride) return fail("MANUAL_OVERRIDE", MANUAL_OVERRIDE_ERROR);

  const previous = agentVisibleLane(item.tier);
  // Already there: nothing to write, and no provenance minted for a lane the
  // agent did not choose. Also what lets an agent read a lane without a side effect.
  if (normalizeTier(item.tier) === tier) return done(emailId, previous, tier, false);

  const { count } = await prisma.attentionItem.updateMany({
    // isManualOverride is re-checked in the WHERE: a human override that landed
    // after the read above still wins.
    where: { id: item.id, userId: ctx.userId, status: "OPEN", isManualOverride: false },
    data: {
      tier,
      tierReason: agentTierReason(tier),
      agentTierSetAt: new Date(),
      agentTierKeyId: ctx.apiKeyId,
    },
  });
  if (count === 0) return explainLostWrite(ctx.userId, item.id);
  return done(emailId, previous, tier, true);
}

/**
 * Run `set_tier` for a caller the gate already admitted. Returns the tool's JSON
 * result: `{success:true,...}` or `{error, code}`. Never throws for an expected
 * refusal; an unexpected failure is captured and answered generically, so a
 * database message never reaches the agent.
 */
export async function executeSetTier(
  ctx: SetTierContext,
  args: Record<string, unknown>,
): Promise<string> {
  const parsed = parseArgs(args);
  if (!parsed.ok) return fail("INVALID_ARGUMENT", parsed.error);
  try {
    return await changeLane(ctx, parsed.emailId, parsed.tier);
  } catch (err) {
    captureError(err, {
      tags: { scope: "mcp.set-tier" },
      extra: { userId: ctx.userId, apiKeyId: ctx.apiKeyId },
    });
    return fail("UNAVAILABLE", UNAVAILABLE_ERROR);
  }
}
