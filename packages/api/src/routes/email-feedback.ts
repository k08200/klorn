/**
 * Email feedback sub-routes.
 *
 * Extracted from routes/email.ts (2026-05-19). All endpoints below
 * register under the same prefix as the parent emailRoutes, so client
 * paths stay byte-identical.
 *
 * Routes:
 *   - GET    /api/email/feedback                       — list label corrections
 *   - GET    /api/email/feedback/eval                  — replay them through the heuristic
 *   - POST   /api/email/:id/feedback                   — user reports wrong priority
 *   - GET    /api/email/:id/feedback                   — fetch prior correction
 *   - POST   /api/email/:id/reply-needed/feedback      — capture reply-needed judgment
 *   - GET    /api/email/:id/reply-needed/feedback      — latest reply-needed feedback
 *
 * Shared helpers (`looksReplyNeeded`, `serializeFeedback`, `parseJsonArray`,
 * `replyNeededSourceId`, `serializeReplyFeedback`) and the reply-needed
 * constants (`REPLY_NEEDED_CHOICES`, `REPLY_SIGNAL_BY_CHOICE`, etc.) live in
 * routes/email.ts and are imported here so the helper code stays in one
 * place until a later PR moves the whole shared block out.
 */

import type { FastifyInstance } from "fastify";
import { getUserId } from "../auth.js";
import { prisma } from "../db.js";
import { evaluateUserCorrectionFixtures } from "../email-classification-eval.js";
import { recordFeedback as recordLedgerFeedback } from "../learning/feedback.js";
import { listUserFeedbackFixtures } from "../mail/email-feedback-fixtures.js";
import {
  type EmailPriorityValue,
  FeedbackError,
  getFeedback,
  recordFeedback,
} from "../mail/email-label-feedback.js";
import {
  looksReplyNeeded,
  parseJsonArray,
  REPLY_NEEDED_CHOICES,
  REPLY_NEEDED_TOOL,
  REPLY_SIGNAL_BY_CHOICE,
  type ReplyNeededChoice,
  replyNeededSourceId,
  serializeFeedback,
  serializeReplyFeedback,
} from "./email.js";

export async function registerEmailFeedbackRoutes(app: FastifyInstance) {
  // GET /api/email/feedback — list the user's accumulated label corrections
  // in fixture-shape so they can be inspected (and later replayed against
  // the classifier as a regression suite).
  app.get("/feedback", async (request) => {
    const userId = getUserId(request);
    const { limit } = request.query as { limit?: string };
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    const fixtures = await listUserFeedbackFixtures(userId, {
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
    return { fixtures, count: fixtures.length };
  });

  // GET /api/email/feedback/eval — replay the user's corrections against
  // the current heuristic classifier without changing runtime behavior.
  app.get("/feedback/eval", async (request) => {
    const userId = getUserId(request);
    const { limit } = request.query as { limit?: string };
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    const fixtures = await listUserFeedbackFixtures(userId, {
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
    return {
      generatedAt: new Date().toISOString(),
      ...evaluateUserCorrectionFixtures(fixtures),
    };
  });

  // POST /api/email/:id/feedback — user reports the auto-priority is wrong.
  // Idempotent on (user, email): re-correction overwrites prior feedback.
  app.post("/:id/feedback", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = getUserId(request);
    const body = (request.body ?? {}) as {
      correctedPriority?: string;
      note?: string;
    };

    if (!body.correctedPriority) {
      return reply.code(400).send({ error: "correctedPriority is required" });
    }

    try {
      const row = await recordFeedback({
        userId,
        emailId: id,
        correctedPriority: body.correctedPriority as EmailPriorityValue,
        note: typeof body.note === "string" ? body.note.slice(0, 500) : undefined,
      });
      return { feedback: serializeFeedback(row) };
    } catch (err) {
      if (err instanceof FeedbackError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  // GET /api/email/:id/feedback — returns the user's prior correction (or null).
  app.get("/:id/feedback", async (request) => {
    const { id } = request.params as { id: string };
    const userId = getUserId(request);
    const row = await getFeedback(userId, id);
    return { feedback: row ? serializeFeedback(row) : null };
  });

  // POST /api/email/:id/reply-needed/feedback — capture whether Klorn's
  // "reply needed" judgment was right. This measures precision before we
  // make reply automation any bolder.
  app.post("/:id/reply-needed/feedback", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = getUserId(request);
    const body = (request.body ?? {}) as { choice?: string; note?: string };
    const choice = body.choice as ReplyNeededChoice | undefined;

    if (!choice || !REPLY_NEEDED_CHOICES.has(choice)) {
      return reply.code(400).send({
        error:
          "choice must be one of needed, today, waiting_on_me, waiting_on_them, not_needed, later, done",
      });
    }

    const email = await prisma.emailMessage.findFirst({
      where: { userId, OR: [{ id }, { gmailId: id }] },
      select: {
        id: true,
        from: true,
        subject: true,
        priority: true,
        category: true,
        actionItems: true,
        needsReply: true,
        needsReplyReason: true,
        needsReplyConfidence: true,
        threadId: true,
      },
    });
    if (!email) return reply.code(404).send({ error: "Email not found" });

    const actionItems = parseJsonArray(email.actionItems);
    const inferredNeedsReply = looksReplyNeeded({
      needsReply: email.needsReply,
      priority: email.priority,
      category: email.category,
      actionItems,
      from: email.from,
    });
    const evidence = JSON.stringify({
      choice,
      emailId: email.id,
      subject: email.subject.slice(0, 250),
      from: email.from.slice(0, 250),
      priority: email.priority,
      category: email.category,
      actionItems,
      inferredNeedsReply,
      needsReplyReason: email.needsReplyReason,
      needsReplyConfidence: email.needsReplyConfidence,
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
    });

    await recordLedgerFeedback({
      userId,
      source: "ATTENTION_ITEM",
      sourceId: replyNeededSourceId(email.id),
      signal: REPLY_SIGNAL_BY_CHOICE[choice],
      toolName: REPLY_NEEDED_TOOL,
      recipient: email.from,
      threadId: email.threadId,
      evidence,
    });

    return {
      feedback: {
        emailId: email.id,
        choice,
        signal: REPLY_SIGNAL_BY_CHOICE[choice],
        inferredNeedsReply,
      },
    };
  });

  // GET /api/email/:id/reply-needed/feedback — latest reply-needed feedback.
  app.get("/:id/reply-needed/feedback", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = getUserId(request);
    const email = await prisma.emailMessage.findFirst({
      where: { userId, OR: [{ id }, { gmailId: id }] },
      select: { id: true },
    });
    if (!email) return reply.code(404).send({ error: "Email not found" });

    const row = await prisma.feedbackEvent.findFirst({
      where: {
        userId,
        source: "ATTENTION_ITEM",
        sourceId: replyNeededSourceId(email.id),
        toolName: REPLY_NEEDED_TOOL,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, signal: true, evidence: true, createdAt: true },
    });

    return { feedback: row ? serializeReplyFeedback(row) : null };
  });
}
