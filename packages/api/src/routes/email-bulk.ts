/**
 * Email bulk-action route — applies a single list-level action (mark-read,
 * mark-unread, archive, set-priority) to up to 100 selected messages.
 *
 * Split out of routes/email.ts so the bulk pipeline (id parsing, per-action
 * branching, Gmail-side reconciliation) lives in one place. Registered by
 * emailRoutes() against the same `/api/email` prefix so client paths stay
 * byte-identical.
 */

import type { EmailBulkActionResponse } from "@klorn/contract";
import type { EmailMessage } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import type { EmailPriorityValue } from "../mail/email-label-feedback.js";
import { archiveEmail, toggleReadGmail } from "../mail/gmail.js";

// ─── Types ───────────────────────────────────────────────────────────────

type BulkEmailAction = "mark-read" | "mark-unread" | "archive" | "set-priority";

interface BulkEmailBody {
  ids?: unknown;
  action?: unknown;
  priority?: unknown;
}

interface BulkEmailActionResult {
  statusCode?: number;
  // Success payload is the @klorn/contract wire shape; failures are an
  // `{ error }` body sent with a 4xx statusCode.
  payload: EmailBulkActionResponse | { error: string };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseBulkEmailIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeEmailPriority(value: unknown): EmailPriorityValue | null {
  return value === "URGENT" || value === "NORMAL" || value === "LOW" ? value : null;
}

function findBulkEmails(userId: string, ids: string[]): Promise<EmailMessage[]> {
  return prisma.emailMessage.findMany({
    where: { userId, OR: [{ id: { in: ids } }, { gmailId: { in: ids } }] },
  });
}

async function applyBulkReadAction(
  userId: string,
  emails: EmailMessage[],
  isRead: boolean,
): Promise<BulkEmailActionResult> {
  await Promise.all(
    emails.map((email) =>
      toggleReadGmail(userId, email.gmailId, isRead, email.linkedInboxAccountId).catch(() => null),
    ),
  );
  await prisma.emailMessage.updateMany({
    where: { userId, id: { in: emails.map((email) => email.id) } },
    data: { isRead },
  });
  return { payload: { success: true, updatedCount: emails.length, failed: [] } };
}

async function applyBulkPriorityAction(
  userId: string,
  emails: EmailMessage[],
  priorityValue: unknown,
): Promise<BulkEmailActionResult> {
  const priority = normalizeEmailPriority(priorityValue);
  if (!priority) return { statusCode: 400, payload: { error: "Invalid email priority" } };
  await prisma.emailMessage.updateMany({
    where: { userId, id: { in: emails.map((email) => email.id) } },
    data: { priority },
  });
  return { payload: { success: true, updatedCount: emails.length, failed: [] } };
}

async function applyBulkArchiveAction(
  userId: string,
  emails: EmailMessage[],
): Promise<BulkEmailActionResult> {
  const failed: Array<{ id: string; error: string }> = [];
  const archivedIds: string[] = [];
  for (const email of emails) {
    try {
      const result = await archiveEmail(userId, email.gmailId, email.linkedInboxAccountId);
      if (result && "error" in result) {
        failed.push({ id: email.id, error: result.error || "Gmail archive failed" });
      } else archivedIds.push(email.id);
    } catch (err) {
      failed.push({
        id: email.id,
        error: err instanceof Error ? err.message : "Gmail archive failed",
      });
    }
  }
  if (archivedIds.length > 0) {
    await prisma.emailMessage.deleteMany({ where: { userId, id: { in: archivedIds } } });
  }
  return {
    payload: {
      success: failed.length === 0,
      updatedCount: archivedIds.length,
      failed,
    },
  };
}

async function handleBulkEmailAction(
  userId: string,
  body: BulkEmailBody,
): Promise<BulkEmailActionResult> {
  const ids = parseBulkEmailIds(body.ids);
  if (ids.length === 0) return { statusCode: 400, payload: { error: "No emails selected" } };
  if (ids.length > 100) {
    return { statusCode: 400, payload: { error: "Bulk action is limited to 100 emails" } };
  }

  const emails = await findBulkEmails(userId, ids);
  if (emails.length === 0) return { payload: { success: true, updatedCount: 0, failed: [] } };

  switch (body.action as BulkEmailAction) {
    case "mark-read":
      return applyBulkReadAction(userId, emails, true);
    case "mark-unread":
      return applyBulkReadAction(userId, emails, false);
    case "set-priority":
      return applyBulkPriorityAction(userId, emails, body.priority);
    case "archive":
      return applyBulkArchiveAction(userId, emails);
    default:
      return { statusCode: 400, payload: { error: "Invalid bulk action" } };
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────

export async function registerEmailBulkRoutes(app: FastifyInstance) {
  // POST /api/email/bulk — apply a list-level action to selected messages.
  app.post("/bulk", { preHandler: requireAuth }, async (request, reply) => {
    const uid = getUserId(request);
    const result = await handleBulkEmailAction(uid, (request.body as BulkEmailBody) || {});
    if (result.statusCode) return reply.code(result.statusCode).send(result.payload);
    return result.payload;
  });
}
