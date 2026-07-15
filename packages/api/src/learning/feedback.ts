/**
 * Feedback ledger — append-only record of user signals on Eve proposals.
 *
 * Step 8.1 of the Attention OS roadmap. Every approve/reject/edit/ignore is
 * captured here so later PRs can derive policy from real behavior. Writes
 * never throw — feedback is observability, not control flow.
 */

import type { FeedbackSignal, FeedbackSource } from "@prisma/client";
import { prisma } from "../db.js";

export interface FeedbackInput {
  userId: string;
  source: FeedbackSource;
  sourceId: string;
  signal: FeedbackSignal;
  toolName?: string | null;
  recipient?: string | null;
  threadId?: string | null;
  evidence?: string | null;
}

export async function recordFeedback(input: FeedbackInput): Promise<void> {
  try {
    await prisma.feedbackEvent.create({
      data: {
        userId: input.userId,
        source: input.source,
        sourceId: input.sourceId,
        signal: input.signal,
        toolName: input.toolName ?? null,
        recipient: input.recipient ?? null,
        threadId: input.threadId ?? null,
        evidence: input.evidence ?? null,
      },
    });
  } catch (err) {
    console.warn("[feedback] recordFeedback failed", input.signal, input.sourceId, err);
  }
}

/**
 * Best-effort recipient extraction from a tool's argument JSON. Most send/draft
 * tools store the target email under common keys — pick the first one that
 * yields a non-empty string. Anything else returns null and the row simply
 * gets stored without a recipient (still useful for tool-level rollups).
 */
export function recipientFromToolArgs(toolArgs: unknown): string | null {
  let parsed: unknown = toolArgs;
  // Backward-compat: rows written before migration 20260519060000 are
  // JSON strings; rows written after are already parsed objects.
  if (typeof toolArgs === "string") {
    try {
      parsed = JSON.parse(toolArgs);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const candidates = ["to", "recipient", "email", "address", "contact"];
  for (const key of candidates) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}
