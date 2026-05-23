/**
 * Email mutation routes — send, read/unread, star/unstar, delete, archive,
 * and their corresponding undo handlers.
 *
 * Split out of routes/email.ts so the Gmail-side write surface lives in one
 * place. Registered by emailRoutes() against the same `/api/email` prefix so
 * client paths stay byte-identical.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import { syncEmailByGmailId } from "../email-sync.js";
import {
  archiveEmail,
  sendEmail,
  toggleReadGmail,
  toggleStarGmail,
  trashEmail,
  unarchiveEmail,
  untrashEmail,
} from "../gmail.js";

interface EmailUndoBody {
  gmailId?: unknown;
}

function resolveUndoGmailId(pathId: string, body: unknown): string {
  const parsedBody = (body || {}) as EmailUndoBody;
  if (typeof parsedBody.gmailId === "string" && parsedBody.gmailId.trim()) {
    return parsedBody.gmailId.trim();
  }
  return pathId;
}

export async function registerEmailMutationsRoutes(app: FastifyInstance) {
  // POST /api/email/send — send a brand-new email (not a reply)
  app.post("/send", { preHandler: requireAuth }, async (request) => {
    const uid = getUserId(request);
    const { to, subject, body } = request.body as { to: string; subject: string; body: string };

    if (!to || !subject || !body) {
      return { error: "Missing required fields: to, subject, body" };
    }

    const result = await sendEmail(uid, to, subject, body);
    return result;
  });

  // PATCH /api/email/:id/read — mark read/unread, syncs to Gmail then DB
  app.patch("/:id/read", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = getUserId(request);
    const { isRead } = (request.body as { isRead?: boolean }) || {};
    const readVal = isRead !== false;

    const email = await prisma.emailMessage.findFirst({
      where: { userId: uid, OR: [{ id }, { gmailId: id }] },
    });
    if (!email) return reply.code(404).send({ error: "Email not found" });

    // Sync to Gmail first, then update DB
    await toggleReadGmail(uid, email.gmailId, readVal).catch(() => {
      // Gmail sync failed — still update local DB
    });
    await prisma.emailMessage.update({
      where: { id: email.id },
      data: { isRead: readVal },
    });
    return { success: true };
  });

  // PATCH /api/email/:id/star — star/unstar, syncs to Gmail
  app.patch("/:id/star", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = getUserId(request);
    const { isStarred } = (request.body as { isStarred?: boolean }) || {};
    const starVal = isStarred !== false;

    const email = await prisma.emailMessage.findFirst({
      where: { userId: uid, OR: [{ id }, { gmailId: id }] },
    });
    if (!email) return reply.code(404).send({ error: "Email not found" });

    await toggleStarGmail(uid, email.gmailId, starVal).catch(() => {});
    await prisma.emailMessage.update({
      where: { id: email.id },
      data: { isStarred: starVal },
    });
    return { success: true };
  });

  // DELETE /api/email/:id — trash in Gmail, then remove from DB
  app.delete("/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = getUserId(request);

    const email = await prisma.emailMessage.findFirst({
      where: { userId: uid, OR: [{ id }, { gmailId: id }] },
    });
    if (!email) return reply.code(404).send({ error: "Email not found" });

    // Try Gmail first — only delete from DB if Gmail succeeds (or not connected)
    try {
      const result = await trashEmail(uid, email.gmailId);
      if (result && "error" in result) {
        // Gmail not connected — just remove from DB
        await prisma.emailMessage.deleteMany({ where: { id: email.id } });
        return { success: true, warning: "Gmail not connected, removed locally only" };
      }
    } catch (err) {
      const gErr = err as { message?: string };
      console.error(`[EMAIL] Gmail trash failed for ${email.gmailId}:`, gErr.message);
      return reply.code(502).send({ error: `Gmail delete failed: ${gErr.message || "unknown"}` });
    }

    // Gmail succeeded — DB already cleaned by trashEmail()
    return { success: true };
  });

  // POST /api/email/:id/delete/undo — restore from Gmail trash and resync locally.
  app.post("/:id/delete/undo", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = getUserId(request);
    const gmailId = resolveUndoGmailId(id, request.body);

    try {
      const result = await untrashEmail(uid, gmailId);
      if (result && "error" in result) {
        return reply.code(409).send({ error: result.error });
      }
      const synced = await syncEmailByGmailId(uid, gmailId);
      return { success: true, gmailId, emailId: synced.emailId };
    } catch (err) {
      const gErr = err as { message?: string };
      return reply.code(502).send({ error: `Gmail undo failed: ${gErr.message || "unknown"}` });
    }
  });

  // POST /api/email/:id/archive — remove from inbox in Gmail, then DB
  app.post("/:id/archive", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = getUserId(request);

    const email = await prisma.emailMessage.findFirst({
      where: { userId: uid, OR: [{ id }, { gmailId: id }] },
    });
    if (!email) return reply.code(404).send({ error: "Email not found" });

    try {
      const result = await archiveEmail(uid, email.gmailId);
      if (result && "error" in result) {
        await prisma.emailMessage.deleteMany({ where: { id: email.id } });
        return { success: true, warning: "Gmail not connected, removed locally only" };
      }
    } catch (err) {
      const gErr = err as { message?: string };
      console.error(`[EMAIL] Gmail archive failed for ${email.gmailId}:`, gErr.message);
      return reply.code(502).send({ error: `Gmail archive failed: ${gErr.message || "unknown"}` });
    }

    return { success: true };
  });

  // POST /api/email/:id/archive/undo — move back to inbox and resync locally.
  app.post("/:id/archive/undo", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = getUserId(request);
    const gmailId = resolveUndoGmailId(id, request.body);

    try {
      const result = await unarchiveEmail(uid, gmailId);
      if (result && "error" in result) {
        return reply.code(409).send({ error: result.error });
      }
      const synced = await syncEmailByGmailId(uid, gmailId);
      return { success: true, gmailId, emailId: synced.emailId };
    } catch (err) {
      const gErr = err as { message?: string };
      return reply.code(502).send({ error: `Gmail undo failed: ${gErr.message || "unknown"}` });
    }
  });
}
