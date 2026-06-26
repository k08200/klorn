/**
 * Email mutation routes — send, read/unread, star/unstar, delete, archive,
 * and their corresponding undo handlers.
 *
 * Split out of routes/email.ts so the Gmail-side write surface lives in one
 * place. Registered by emailRoutes() against the same `/api/email` prefix so
 * client paths stay byte-identical.
 */

import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import { syncEmailByGmailId } from "../email-sync.js";
import {
  archiveEmail,
  type GmailDraftAttachment,
  sendEmail,
  toggleReadGmail,
  toggleStarGmail,
  trashEmail,
  unarchiveEmail,
  untrashEmail,
} from "../gmail.js";
import { captureError } from "../sentry.js";
import { safeAttachmentFilename } from "./email.js";

// Gmail caps a single message (body + all attachments, base64-encoded) at 25 MB.
// We enforce the raw-byte total below that so the encoded payload stays under
// the ceiling, and cap the count so one request can't fan out unbounded parts.
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_MB = MAX_ATTACHMENT_BYTES / (1024 * 1024);
// Email bodies are small, but a generous field cap avoids truncating a long
// plain-text draft mid-send.
const MAX_FIELD_BYTES = 2 * 1024 * 1024;

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
  // Multipart parser for the compose route's file uploads. Scoped to this
  // plugin's encapsulation context, so JSON routes elsewhere are untouched.
  // Limits are the first line of defense — the plugin rejects oversized or
  // too-many-part requests before we buffer anything.
  await app.register(multipart, {
    limits: {
      fileSize: MAX_ATTACHMENT_BYTES,
      files: MAX_ATTACHMENTS,
      fields: 10,
      fieldSize: MAX_FIELD_BYTES,
    },
  });

  // POST /api/email/send — send a brand-new email (not a reply).
  // Same per-route send cap as /compose so neither route can outrun the other
  // as an abuse vector against the user's Gmail send quota.
  app.post(
    "/send",
    { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const uid = getUserId(request);
      const { to, subject, body } = request.body as { to: string; subject: string; body: string };

      if (!to || !subject || !body) {
        return { error: "Missing required fields: to, subject, body" };
      }

      const result = await sendEmail(uid, to, subject, body);
      return result;
    },
  );

  // POST /api/email/compose — send a brand-new email with optional file
  // attachments uploaded from the user's device (multipart/form-data).
  // Fields: to, subject, body. Files: any number of `files` parts (<= cap).
  app.post(
    "/compose",
    { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const uid = getUserId(request);
      if (!request.isMultipart()) {
        return reply.code(415).send({ error: "Expected multipart/form-data." });
      }

      const fields: Record<string, string> = {};
      const attachments: GmailDraftAttachment[] = [];
      let totalBytes = 0;

      try {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            // toBuffer() respects the fileSize limit and throws when exceeded.
            const content = await part.toBuffer();
            totalBytes += content.length;
            if (totalBytes > MAX_ATTACHMENT_BYTES) {
              return reply
                .code(413)
                .send({ error: `Attachments exceed the ${MAX_ATTACHMENT_MB} MB total limit.` });
            }
            attachments.push({
              filename: safeAttachmentFilename(part.filename || "attachment"),
              mimeType: part.mimetype || "application/octet-stream",
              content,
            });
          } else {
            fields[part.fieldname] =
              typeof part.value === "string" ? part.value : String(part.value);
          }
        }
      } catch (err) {
        const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
        if (code === "FST_REQ_FILE_TOO_LARGE") {
          return reply
            .code(413)
            .send({ error: `Each attachment must be under ${MAX_ATTACHMENT_MB} MB.` });
        }
        if (code === "FST_FILES_LIMIT") {
          return reply
            .code(413)
            .send({ error: `You can attach at most ${MAX_ATTACHMENTS} files.` });
        }
        if (
          code === "FST_FIELDS_LIMIT" ||
          code === "FST_PARTS_LIMIT" ||
          code === "FST_PROTO_VIOLATION" ||
          code === "FST_INVALID_MULTIPART_CONTENT_TYPE"
        ) {
          return reply.code(400).send({ error: "Malformed message form data." });
        }
        // Unknown parse failure — never swallow: log a signal and report.
        console.error(`[EMAIL] compose multipart parse failed for user ${uid}:`, err);
        captureError(err, { tags: { scope: "email.compose.multipart" }, extra: { userId: uid } });
        return reply.code(400).send({ error: "Could not read the message form data." });
      }

      const to = (fields.to || "").trim();
      const subject = (fields.subject || "").trim();
      const body = fields.body ?? "";
      if (!to || !subject || !body.trim()) {
        return reply.code(400).send({ error: "Missing required fields: to, subject, body" });
      }

      let result: Awaited<ReturnType<typeof sendEmail>>;
      try {
        result = await sendEmail(uid, to, subject, body, attachments);
      } catch (err) {
        // A non-auth Gmail failure (timeout, 5xx) would otherwise surface as an
        // untagged 500. Tag it with send context so it's diagnosable.
        console.error(`[EMAIL] compose sendEmail threw for user ${uid}:`, err);
        captureError(err, {
          tags: { scope: "email.compose.send" },
          extra: { userId: uid, attachedCount: attachments.length },
        });
        return reply.code(502).send({ error: "Failed to send the email through Gmail." });
      }
      if (result && "error" in result) {
        return reply.code(400).send(result);
      }
      return { ...result, attachedCount: attachments.length };
    },
  );

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
