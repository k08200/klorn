/**
 * Chat routes — pending-action list / approve / reject / snooze.
 *
 * The /api/chat surface used to host conversation CRUD (create/list/get/
 * update/delete) plus the agent send-message loop, but POC scope dropped
 * the entire user-initiated chat surface. What remains is the approval
 * gating that turns agent-proposed tool calls into executed ones — the
 * inbox card uses these endpoints to approve, reject, or snooze each
 * PendingAction.
 */

import type { FastifyInstance } from "fastify";
import { resolveActionTarget } from "../action-target.js";
import {
  type ActionReceipt,
  isFloorAction,
  mintReceipt,
  sendEmailPayloadHash,
} from "../attention-floor.js";
import { upsertAttentionForPendingAction } from "../attention-mirror.js";
import { getUserId } from "../auth.js";
import { db, prisma } from "../db.js";
import { recipientFromToolArgs, recordFeedback } from "../feedback.js";
import { executeToolCall } from "../tool-executor.js";
import { pushNotification } from "../websocket.js";

/**
 * Mint an ActionReceipt for the about-to-execute floor action. The receipt
 * pins the bytes the user just clicked "approve" on so that any mutation
 * between this call and the tool-executor read will throw at verify time.
 *
 * inputHash is left empty when the PendingAction wasn't classifier-driven
 * (PR #468 hash lives on AttentionItem; PendingAction may not have one
 * yet for legacy / manual flows). Empty string is metadata-only; verify
 * checks payloadHash, not inputHash.
 */
function mintReceiptForToolArgs(input: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  approvedBy: string;
  inputHash: string;
}): ActionReceipt | null {
  if (!isFloorAction(input.toolName)) return null;
  if (input.toolName === "send_email") {
    const to = typeof input.toolArgs.to === "string" ? input.toolArgs.to : "";
    const subject = typeof input.toolArgs.subject === "string" ? input.toolArgs.subject : "";
    const body = typeof input.toolArgs.body === "string" ? input.toolArgs.body : "";
    return mintReceipt({
      action: "send_email",
      inputHash: input.inputHash,
      payloadHash: sendEmailPayloadHash({ to, subject, body }),
      target: to.trim().toLowerCase(),
      approvedAt: new Date(),
      approvedBy: input.approvedBy,
    });
  }
  // delete_permanent / forward_external aren't shipped as tools yet — wiring
  // here is a no-op until those tools land. The doctrine list still locks
  // them, so adding them later requires only this case + the executor case.
  return null;
}

const idParamSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1 },
  },
} as const;

const actionIdParamSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actionId"],
  properties: {
    actionId: { type: "string", minLength: 1 },
  },
} as const;

const rejectActionBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: { type: "string", minLength: 1, maxLength: 500 },
  },
} as const;

function hasMeaningfulText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function chatRoutes(app: FastifyInstance) {
  // GET /api/chat/pending-actions — All pending actions for the current user across conversations.
  // Powers the mobile inbox so users can see & act on every "needs your attention" item in one place.
  app.get("/pending-actions", async (request) => {
    const userId = getUserId(request);
    const { status } = request.query as { status?: string };
    const statusFilter = status === "all" ? undefined : status || "PENDING";

    type PendingActionRow = {
      id: string;
      conversationId: string;
      status: string;
      toolName: string;
      toolArgs: string;
      reasoning: string | null;
      result: string | null;
      createdAt: Date;
      conversation?: { id: string; title: string | null } | null;
    };
    const actions = (await db.pendingAction.findMany({
      where: { userId, ...(statusFilter ? { status: statusFilter } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        conversation: { select: { id: true, title: true } },
      },
    })) as PendingActionRow[];

    // Resolve a human-readable target label for each action (title/name instead of raw UUID).
    const enriched = await Promise.all(
      actions.map(async (a) => {
        let targetLabel: string | null = null;
        try {
          const parsed = (
            typeof a.toolArgs === "string" ? JSON.parse(a.toolArgs) : (a.toolArgs ?? {})
          ) as Record<string, unknown>;
          targetLabel = await resolveActionTarget(a.toolName, parsed);
        } catch {
          // Malformed toolArgs — leave label null
        }
        return {
          id: a.id,
          conversationId: a.conversationId,
          conversationTitle: a.conversation?.title ?? null,
          status: a.status,
          toolName: a.toolName,
          toolArgs: a.toolArgs,
          targetLabel,
          reasoning: a.reasoning,
          result: a.result,
          createdAt: a.createdAt.toISOString(),
        };
      }),
    );

    return { actions: enriched };
  });

  // GET /api/chat/conversations/:id/pending-actions — Get pending actions for a conversation
  app.get(
    "/conversations/:id/pending-actions",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const userId = getUserId(request);
      const { id } = request.params as { id: string };

      const conversation = await prisma.conversation.findUnique({
        where: { id },
      });
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      if (conversation.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

      type ActionRow = {
        id: string;
        messageId: string;
        status: string;
        toolName: string;
        toolArgs: string;
        reasoning: string | null;
        result: string | null;
        createdAt: Date;
      };
      const actions = (await db.pendingAction.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "desc" },
      })) as ActionRow[];

      // Include resolved targetLabel so the chat preview can show the real
      // task/note/contact name instead of the raw UUID.
      const enriched = await Promise.all(
        actions.map(async (a) => {
          let targetLabel: string | null = null;
          try {
            const parsed = (
              typeof a.toolArgs === "string" ? JSON.parse(a.toolArgs) : (a.toolArgs ?? {})
            ) as Record<string, unknown>;
            targetLabel = await resolveActionTarget(a.toolName, parsed);
          } catch {
            // Malformed toolArgs — leave label null
          }
          return { ...a, targetLabel };
        }),
      );

      return { actions: enriched };
    },
  );

  // POST /api/chat/pending-actions/:actionId/approve — Approve and execute a pending action
  app.post(
    "/pending-actions/:actionId/approve",
    { schema: { params: actionIdParamSchema } },
    async (request, reply) => {
      const userId = getUserId(request);
      const { actionId } = request.params as { actionId: string };

      const action = await db.pendingAction.findUnique({
        where: { id: actionId },
      });

      if (!action) return reply.code(404).send({ error: "Action not found" });
      if (action.userId !== userId) return reply.code(403).send({ error: "Forbidden" });
      if (action.status !== "PENDING") {
        return reply.code(400).send({ error: `Action already ${action.status.toLowerCase()}` });
      }

      // Atomic status claim — prevents race condition with concurrent approve/reject
      // Uses updateMany with status condition so only one request can claim
      const claimed = await db.pendingAction.updateMany({
        where: { id: actionId, status: "PENDING" },
        data: { status: "EXECUTED", updatedAt: new Date() },
      });
      if (claimed.count === 0) {
        return reply.code(409).send({ error: "Action already processed by another request" });
      }
      await upsertAttentionForPendingAction({ ...action, status: "EXECUTED" });

      // Execute the tool — if it fails, rollback to FAILED
      try {
        // toolArgs is JSONB post-#332 (already parsed), but legacy
        // rows can still be JSON strings.
        const toolArgs =
          typeof action.toolArgs === "string"
            ? JSON.parse(action.toolArgs)
            : (action.toolArgs ?? {});
        // Floor: mint and persist the receipt before we hand off to the
        // tool executor. Persisting first means even if the executor
        // crashes after sending, the audit row exists.
        const receipt = mintReceiptForToolArgs({
          toolName: action.toolName,
          toolArgs,
          approvedBy: userId,
          inputHash: "",
        });
        if (receipt) {
          await db.pendingAction.update({
            where: { id: actionId },
            data: { actionReceipt: receipt as unknown as object },
          });
        }
        const toolResult = await executeToolCall(userId, action.toolName, toolArgs, receipt);

        await db.pendingAction.update({
          where: { id: actionId },
          data: { result: toolResult },
        });

        // Add a follow-up message in the conversation
        await db.message.create({
          data: {
            conversationId: action.conversationId,
            role: "ASSISTANT",
            content: `${action.toolName.replace(/_/g, " ")} completed.`,
            metadata: { source: "agent", actionResult: true },
          },
        });

        // Push notification about execution
        pushNotification(userId, {
          id: "action-executed",
          type: "system",
          title: "conversations-updated",
          message: "",
          createdAt: new Date().toISOString(),
        });

        // Learn from approval for pattern detection
        import("../pattern-learner.js")
          .then(({ learnFromApproval }) => learnFromApproval(userId, action.toolName, toolArgs))
          .catch(() => {});

        // Append to the structured feedback ledger — Step 8.1 substrate.
        await recordFeedback({
          userId,
          source: "PENDING_ACTION",
          sourceId: actionId,
          signal: "APPROVED",
          toolName: action.toolName,
          recipient: recipientFromToolArgs(action.toolArgs),
          threadId: action.conversationId,
        });

        // Auto-allow this tool type for future actions if requested
        const { autoAllow } = (request.body as { autoAllow?: boolean }) || {};
        if (autoAllow && action.toolName) {
          const config = await prisma.automationConfig.findUnique({
            where: { userId },
          });
          const existing: string[] =
            (config as unknown as { alwaysAllowedTools?: string[] })?.alwaysAllowedTools || [];
          if (!existing.includes(action.toolName)) {
            await prisma.automationConfig.upsert({
              where: { userId },
              update: { alwaysAllowedTools: [...existing, action.toolName] },
              create: { userId, alwaysAllowedTools: [action.toolName] },
            });
          }
        }

        return { success: true, result: toolResult, autoAllowed: !!autoAllow };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Execution failed";

        await db.pendingAction.update({
          where: { id: actionId },
          data: { status: "FAILED", result: message },
        });
        await upsertAttentionForPendingAction({ ...action, status: "FAILED" });

        await db.message.create({
          data: {
            conversationId: action.conversationId,
            role: "ASSISTANT",
            content: `Execution failed: ${message}`,
            metadata: { source: "agent", actionFailed: true },
          },
        });

        await recordFeedback({
          userId,
          source: "PENDING_ACTION",
          sourceId: actionId,
          signal: "FAILED",
          toolName: action.toolName,
          recipient: recipientFromToolArgs(action.toolArgs),
          threadId: action.conversationId,
          evidence: message,
        });

        return reply.code(500).send({ error: message });
      }
    },
  );

  // POST /api/chat/pending-actions/:actionId/reject — Reject a pending action
  app.post(
    "/pending-actions/:actionId/reject",
    { schema: { params: actionIdParamSchema, body: rejectActionBodySchema } },
    async (request, reply) => {
      const userId = getUserId(request);
      const { actionId } = request.params as { actionId: string };
      const { reason } = (request.body as { reason?: string }) || {};
      if (reason !== undefined && !hasMeaningfulText(reason)) {
        return reply.code(400).send({ error: "Rejection reason cannot be empty" });
      }

      const action = await db.pendingAction.findUnique({
        where: { id: actionId },
      });

      if (!action) return reply.code(404).send({ error: "Action not found" });
      if (action.userId !== userId) return reply.code(403).send({ error: "Forbidden" });
      if (action.status !== "PENDING") {
        return reply.code(400).send({ error: `Action already ${action.status.toLowerCase()}` });
      }

      // Atomic status claim — prevents race condition with concurrent approve/reject
      const claimed = await db.pendingAction.updateMany({
        where: { id: actionId, status: "PENDING" },
        data: {
          status: "REJECTED",
          result: reason ? `Rejected: ${reason}` : "User rejected without reason",
        },
      });
      if (claimed.count === 0) {
        return reply.code(409).send({ error: "Action already processed by another request" });
      }
      await upsertAttentionForPendingAction({ ...action, status: "REJECTED" });

      // Add a follow-up message (include reason if provided)
      const rejectMsg = reason
        ? `Understood. I rejected this suggestion: "${reason}".`
        : "Understood. I rejected this suggestion.";

      await db.message.create({
        data: {
          conversationId: action.conversationId,
          role: "ASSISTANT",
          content: rejectMsg,
          metadata: { source: "agent", actionRejected: true },
        },
      });

      // Learn from rejection for pattern detection
      import("../pattern-learner.js")
        .then(({ learnFromRejection }) =>
          learnFromRejection(userId, action.toolName, action.reasoning || "", reason?.trim() || ""),
        )
        .catch(() => {});

      await recordFeedback({
        userId,
        source: "PENDING_ACTION",
        sourceId: actionId,
        signal: "REJECTED",
        toolName: action.toolName,
        recipient: recipientFromToolArgs(action.toolArgs),
        threadId: action.conversationId,
        evidence: reason?.trim() || null,
      });

      // Never suggest this tool type again if requested
      const { neverSuggest } = (request.body as { neverSuggest?: boolean }) || {};
      if (neverSuggest && action.toolName) {
        import("../memory.js")
          .then(({ remember }) =>
            remember(
              userId,
              "FEEDBACK",
              `never_suggest_${action.toolName}`,
              `User explicitly asked Klorn to never propose ${action.toolName} actions.`,
              "user",
            ),
          )
          .catch(() => {});
      }

      return { success: true, neverSuggested: !!neverSuggest };
    },
  );

  // POST /api/chat/pending-actions/:actionId/snooze — defer an action until a later time
  app.post(
    "/pending-actions/:actionId/snooze",
    { schema: { params: actionIdParamSchema } },
    async (request, reply) => {
      const userId = getUserId(request);
      const { actionId } = request.params as { actionId: string };
      const { snoozeUntil } = (request.body as { snoozeUntil?: string }) ?? {};

      if (!snoozeUntil) return reply.code(400).send({ error: "snoozeUntil is required" });
      const snoozeDate = new Date(snoozeUntil);
      if (!Number.isFinite(snoozeDate.getTime()) || snoozeDate <= new Date()) {
        return reply.code(400).send({ error: "snoozeUntil must be a future ISO datetime" });
      }

      const action = await prisma.pendingAction.findFirst({
        where: { id: actionId, userId, status: "PENDING" },
        select: { id: true, toolName: true, conversationId: true, toolArgs: true },
      });
      if (!action)
        return reply.code(404).send({ error: "Pending action not found or not actionable" });

      // Snooze the corresponding AttentionItem (the queue entry for this PA)
      await (
        prisma.attentionItem as unknown as {
          updateMany: (args: unknown) => Promise<unknown>;
        }
      ).updateMany({
        where: { source: "PENDING_ACTION", sourceId: actionId },
        data: { status: "SNOOZED", snoozedUntil: snoozeDate, lastAmplifiedAt: null },
      });

      // Record the snooze signal for policy learning
      import("../feedback.js")
        .then(({ recordFeedback }) =>
          recordFeedback({
            userId,
            source: "PENDING_ACTION",
            sourceId: actionId,
            signal: "SNOOZED",
            toolName: action.toolName,
            recipient: null,
            threadId: action.conversationId,
            evidence: `Snoozed until ${snoozeDate.toISOString()}`,
          }),
        )
        .catch(() => {});

      return { success: true, snoozedUntil: snoozeDate.toISOString() };
    },
  );
}
