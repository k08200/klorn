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
import { mailActionsFor } from "../mail/providers/dispatch.js";
import { isImapFamily } from "../mail/providers/error-semantics.js";
import { logProviderSoftFailure } from "../mail/providers/log-soft-failure.js";
import type { MailProviderActions } from "../mail/providers/types.js";

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
  // The provider lookup sits inside the per-item guarded chain: one item's
  // lookup failure must not abort the batch or the local updateMany below.
  await Promise.all(
    emails.map((email) =>
      mailActionsFor(userId, email.linkedInboxAccountId)
        .then(async (actions) => {
          const result = await actions.toggleRead(
            userId,
            email.gmailId,
            isRead,
            email.linkedInboxAccountId,
          );
          logProviderSoftFailure("EMAIL-BULK", email.id, result);
        })
        .catch((err) => {
          // Local write below still happens (accepted divergence) — but never silently.
          console.warn(`[EMAIL-BULK] toggleRead threw for ${email.id}:`, err);
        }),
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

/** What happened to one message: archived, or why not. */
type ArchiveResult = { ok: true } | { ok: false; error: string };

const ARCHIVE_FAILED = "Gmail archive failed";

const archiveError = (err: unknown): ArchiveResult => ({
  ok: false,
  error: err instanceof Error ? err.message : ARCHIVE_FAILED,
});

async function archiveOne(
  userId: string,
  email: EmailMessage,
  actions: MailProviderActions,
): Promise<ArchiveResult> {
  try {
    const result = await actions.archive(userId, email.gmailId, email.linkedInboxAccountId);
    // Includes unsupported providers and every IMAP failure: the per-item failure
    // keeps the row local instead of faking success.
    if (result && "error" in result) return { ok: false, error: result.error || ARCHIVE_FAILED };
    return { ok: true };
  } catch (err) {
    return archiveError(err);
  }
}

interface ResolvedArchive {
  email: EmailMessage;
  /** The provider's actions, or why the lookup failed. */
  resolved: { actions: MailProviderActions } | { failure: ArchiveResult };
}

/** The provider of each message; one message's lookup failure never aborts the batch. */
function resolveArchiveProviders(
  userId: string,
  emails: EmailMessage[],
): Promise<ResolvedArchive[]> {
  return Promise.all(
    emails.map(async (email): Promise<ResolvedArchive> => {
      try {
        return {
          email,
          resolved: { actions: await mailActionsFor(userId, email.linkedInboxAccountId) },
        };
      } catch (err) {
        return { email, resolved: { failure: archiveError(err) } };
      }
    }),
  );
}

/**
 * Archive every message; the result of each, by message id.
 *
 * IMAP mailboxes queue their moves per account and coalesce what is queued into
 * one login and one UID MOVE (providers/imap-session.ts), which only happens when
 * the calls are in flight together, so they are started together. Everything else
 * keeps its one-at-a-time order, as Gmail's per-call quota was always given.
 */
async function archiveAll(
  userId: string,
  emails: EmailMessage[],
): Promise<Map<string, ArchiveResult>> {
  const items = await resolveArchiveProviders(userId, emails);
  const results = new Map<string, ArchiveResult>();
  const run = async ({ email, resolved }: ResolvedArchive): Promise<void> => {
    results.set(
      email.id,
      "actions" in resolved ? await archiveOne(userId, email, resolved.actions) : resolved.failure,
    );
  };
  const concurrent = (item: ResolvedArchive) =>
    "actions" in item.resolved && isImapFamily(item.resolved.actions.provider);

  await Promise.all(items.filter(concurrent).map(run));
  for (const item of items.filter((i) => !concurrent(i))) await run(item);
  return results;
}

async function applyBulkArchiveAction(
  userId: string,
  emails: EmailMessage[],
): Promise<BulkEmailActionResult> {
  const results = await archiveAll(userId, emails);
  const failed: Array<{ id: string; error: string }> = [];
  const archivedIds: string[] = [];
  for (const email of emails) {
    const result = results.get(email.id);
    if (result?.ok) archivedIds.push(email.id);
    else failed.push({ id: email.id, error: result?.error ?? ARCHIVE_FAILED });
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
