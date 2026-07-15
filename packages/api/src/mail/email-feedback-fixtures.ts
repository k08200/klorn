/**
 * Convert user-recorded EmailLabelFeedback rows into fixture-shaped objects
 * so they can flow back into the same regression toolchain we use for the
 * curated dogfood fixtures.
 *
 * The shape is deliberately distinct from EmailClassificationFixture: a
 * user correction only labels heuristic priority (URGENT/NORMAL/LOW); we
 * don't ask the user to also predict the LLM batch label, so we don't
 * synthesize one. We keep `capturedHeuristic` so the divergence between
 * Eve's auto-label and the user's intent stays visible in any future
 * inspection of the row.
 */

import { prisma } from "../db.js";

export type EmailPriorityValue = "URGENT" | "NORMAL" | "LOW";

export interface UserCorrectionFixture {
  id: string;
  capturedAt: string;
  from: string;
  subject: string;
  labels: string[];
  expectedSyncPriority: EmailPriorityValue;
  capturedHeuristic: {
    priority: EmailPriorityValue;
    reason: string | null;
    signals: string[];
  };
  note: string | null;
}

interface FeedbackRow {
  id: string;
  originalPriority: EmailPriorityValue;
  correctedPriority: EmailPriorityValue;
  reason: string | null;
  signals: string[];
  fromAddress: string;
  subject: string;
  labels: string[];
  note: string | null;
  createdAt: Date;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function feedbackToFixture(row: FeedbackRow): UserCorrectionFixture {
  return {
    id: `feedback-${row.id}`,
    capturedAt: row.createdAt.toISOString(),
    from: row.fromAddress,
    subject: row.subject,
    labels: row.labels,
    expectedSyncPriority: row.correctedPriority,
    capturedHeuristic: {
      priority: row.originalPriority,
      reason: row.reason,
      signals: row.signals,
    },
    note: row.note,
  };
}

export async function listUserFeedbackFixtures(
  userId: string,
  opts: { limit?: number } = {},
): Promise<UserCorrectionFixture[]> {
  const take = clampLimit(opts.limit);
  const rows = (await prisma.emailLabelFeedback.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      originalPriority: true,
      correctedPriority: true,
      reason: true,
      signals: true,
      fromAddress: true,
      subject: true,
      labels: true,
      note: true,
      createdAt: true,
    },
  })) as FeedbackRow[];

  return rows.map(feedbackToFixture);
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || (limit as number) < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit as number), MAX_LIMIT);
}
