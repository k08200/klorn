/**
 * Email label feedback — captures the user's correction of an automatic
 * priority classification along with the heuristic evidence at the moment
 * of feedback.
 *
 * The originalPriority + reason + signals snapshot is what makes each row
 * useful later: we can replay the classifier against the case as a
 * regression test, or feed it in as a few-shot example without losing the
 * exact inputs that fooled the heuristic.
 */

import { prisma } from "../db.js";
import { classifyPriorityDetailed } from "./email-sync.js";

export type EmailPriorityValue = "URGENT" | "NORMAL" | "LOW";

const VALID_PRIORITIES: ReadonlySet<EmailPriorityValue> = new Set(["URGENT", "NORMAL", "LOW"]);

export interface RecordFeedbackInput {
  userId: string;
  emailId: string;
  correctedPriority: EmailPriorityValue;
  note?: string;
}

export interface FeedbackRecord {
  id: string;
  userId: string;
  emailId: string;
  originalPriority: EmailPriorityValue;
  correctedPriority: EmailPriorityValue;
  reason: string | null;
  signals: string[];
  fromAddress: string;
  subject: string;
  labels: string[];
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class FeedbackError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "FeedbackError";
  }
}

export async function recordFeedback(input: RecordFeedbackInput): Promise<FeedbackRecord> {
  if (!VALID_PRIORITIES.has(input.correctedPriority)) {
    throw new FeedbackError(`Invalid corrected priority: ${input.correctedPriority}`, 400);
  }

  const email = await prisma.emailMessage.findFirst({
    where: { id: input.emailId, userId: input.userId },
    select: {
      id: true,
      from: true,
      subject: true,
      labels: true,
      priority: true,
    },
  });

  if (!email) {
    throw new FeedbackError("Email not found", 404);
  }

  const originalPriority = email.priority as EmailPriorityValue;

  if (originalPriority === input.correctedPriority) {
    throw new FeedbackError(
      "Corrected priority is the same as the current label — no correction to record",
      400,
    );
  }

  const detailed = classifyPriorityDetailed(email.from, email.subject, email.labels ?? []);

  const row = await prisma.emailLabelFeedback.upsert({
    where: { userId_emailId: { userId: input.userId, emailId: input.emailId } },
    create: {
      userId: input.userId,
      emailId: input.emailId,
      originalPriority,
      correctedPriority: input.correctedPriority,
      reason: detailed.reason,
      signals: detailed.signals,
      fromAddress: email.from,
      subject: email.subject,
      labels: email.labels ?? [],
      note: input.note ?? null,
    },
    update: {
      correctedPriority: input.correctedPriority,
      originalPriority,
      reason: detailed.reason,
      signals: detailed.signals,
      fromAddress: email.from,
      subject: email.subject,
      labels: email.labels ?? [],
      note: input.note ?? null,
    },
  });

  return row as FeedbackRecord;
}

export async function getFeedback(userId: string, emailId: string): Promise<FeedbackRecord | null> {
  const row = await prisma.emailLabelFeedback.findUnique({
    where: { userId_emailId: { userId, emailId } },
  });
  return (row as FeedbackRecord | null) ?? null;
}
