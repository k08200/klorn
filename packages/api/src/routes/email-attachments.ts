/**
 * Email attachment routes — quality summary, brief export, download, convert,
 * bulk analyze, per-email analyze, OCR, and analysis correction.
 *
 * Split out of routes/email.ts so the attachment-processing domain
 * (vision/OCR, brief export, conversion) lives in one place. Registered by
 * emailRoutes() against the same `/api/email` prefix so client paths stay
 * byte-identical.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import {
  analyzeEmailAttachmentsForEmail,
  analyzePendingEmailAttachments,
  buildAttachmentCandidateProfile,
  buildAttachmentCorrectionGuidance,
  type EmailAttachmentView,
  listEmailAttachments,
} from "../email-attachments.js";
import {
  syncCandidateIntakeForEmail,
  syncRecentCandidateIntakes,
} from "../email-candidate-intake.js";
import { recordFeedback as recordLedgerFeedback } from "../feedback.js";
import { saveConversionResult } from "../file-conversion-store.js";
import {
  convertEmailAttachment,
  FileConversionError,
  normalizeConversionTarget,
  requiresOriginalAttachment,
  SUPPORTED_CONVERSION_TARGETS,
} from "../file-conversions.js";
import { getAuthedClient } from "../gmail.js";
import { getUserLlmCredentials } from "../llm-credentials.js";
import { createVisionCompletion, VISION_MODEL } from "../openai.js";
import {
  isDecorativeImage,
  isVisionAttachment,
  MAX_VISION_ATTACHMENT_BYTES,
} from "../vision-attachment-policy.js";
import { parseJsonArray, parseJsonRecord, safeAttachmentFilename } from "./email.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

function indentText(text: string, prefix: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function buildEmailAttachmentBrief(input: {
  subject: string;
  from: string;
  receivedAt: Date;
  summary: string | null;
  attachments: EmailAttachmentView[];
  candidateProfile: ReturnType<typeof buildAttachmentCandidateProfile>;
}): string {
  const lines = [
    "Klorn Attachment Brief",
    "",
    `Subject: ${input.subject || "Untitled"}`,
    `From: ${input.from || "Unknown sender"}`,
    `Received: ${input.receivedAt.toISOString()}`,
  ];

  if (input.summary) {
    lines.push("", "Email summary", input.summary);
  }

  if (input.candidateProfile) {
    lines.push(
      "",
      "Candidate profile",
      `Status: ${input.candidateProfile.pipelineStatus}`,
      `Next action: ${input.candidateProfile.nextAction}`,
      `Name: ${input.candidateProfile.name || "-"}`,
      `Role: ${input.candidateProfile.role || "-"}`,
      `Contact: ${input.candidateProfile.contact || "-"}`,
      `Age: ${input.candidateProfile.age || "-"}`,
      `Height: ${input.candidateProfile.height || "-"}`,
      `Skills: ${input.candidateProfile.skills.join(", ") || "-"}`,
      `Links: ${input.candidateProfile.links.join(", ") || "-"}`,
      `Missing: ${input.candidateProfile.missingFields.join(", ") || "none"}`,
      `Confidence: ${Math.round(input.candidateProfile.confidence * 100)}%`,
    );
    if (input.candidateProfile.manualReviewFiles.length > 0) {
      lines.push("Manual review files:");
      for (const file of input.candidateProfile.manualReviewFiles) {
        lines.push(`- ${file.filename}: ${file.reason}`);
      }
    }
  }

  lines.push("", "Attachments");
  for (const attachment of input.attachments) {
    lines.push(
      "",
      `- ${attachment.filename}`,
      `  Type: ${attachment.mimeType || "application/octet-stream"}`,
      `  Category: ${attachment.category || "-"}`,
      `  Analysis: ${attachment.analysisStatus}`,
    );
    if (attachment.summary) lines.push(`  Summary: ${attachment.summary}`);
    if (attachment.keyPoints.length > 0) {
      lines.push("  Key points:");
      for (const point of attachment.keyPoints) lines.push(`  - ${point}`);
    }
    const fields = Object.entries(attachment.extractedFields).filter(
      ([, value]) => value !== null && value !== "",
    );
    if (fields.length > 0) {
      lines.push("  Extracted fields:");
      for (const [key, value] of fields) lines.push(`  - ${key}: ${String(value)}`);
    }
    if (attachment.textPreview) {
      lines.push("  Text preview:", indentText(attachment.textPreview, "  "));
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

interface VisualAttachmentAnalysis {
  ocrText: string;
  summary: string;
  category: string;
  keyPoints: string[];
  extractedFields: Record<string, string | number | boolean | null>;
}

function parseVisualAnalysisJson(content: string): VisualAttachmentAnalysis {
  const json = content.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  const parsed = JSON.parse(json) as Partial<VisualAttachmentAnalysis>;
  const fields =
    parsed.extractedFields && typeof parsed.extractedFields === "object"
      ? parsed.extractedFields
      : {};
  return {
    ocrText: typeof parsed.ocrText === "string" ? parsed.ocrText.trim() : "",
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
    category: typeof parsed.category === "string" ? parsed.category.trim() : "document",
    keyPoints: Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints.filter((point): point is string => typeof point === "string").slice(0, 5)
      : [],
    extractedFields: fields as Record<string, string | number | boolean | null>,
  };
}

async function analyzeVisualAttachment(input: {
  userId: string;
  filename: string;
  mimeType: string;
  content: Buffer;
}): Promise<VisualAttachmentAnalysis> {
  const credentials = await getUserLlmCredentials(input.userId);
  const correctionGuidance = await buildAttachmentCorrectionGuidance(input.userId);
  const mimeType = input.mimeType || "application/octet-stream";
  const dataUrl = `data:${mimeType};base64,${input.content.toString("base64")}`;
  const response = await createVisionCompletion(
    {
      model: VISION_MODEL,
      temperature: 0.05,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You extract candidate/audition information from email attachments for Klorn.
Return ONLY JSON:
{
  "ocrText": "all readable text, preserve source language if needed",
  "summary": "English one-line summary, <=90 chars",
  "category": "resume|profile|portfolio|audition|contract|invoice|proposal|schedule|image|document|other",
  "keyPoints": ["English bullet, <=45 chars"],
  "extractedFields": {
    "name": "candidate name if present",
    "role": "actor/model/dancer/singer/role if present",
    "contact": "email/phone/contact if present",
    "phone": "phone number if present",
    "email": "email if present",
    "age": "age or birth year if present",
    "height": "height if present",
    "skills": "skills/languages/specialties if present",
    "links": "portfolio/showreel/social links if present",
    "availability": "availability/schedule if present"
  }
}
Do not invent missing facts. If unreadable, keep ocrText empty and explain briefly in summary.`,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Filename: ${input.filename}\nMIME: ${mimeType}\n${correctionGuidance}\nExtract text and candidate/profile fields from this attachment.`,
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    },
    { credentials, userId: input.userId },
  );
  const content = response.choices[0]?.message?.content || "{}";
  const parsed = parseVisualAnalysisJson(content);
  return {
    ocrText: parsed.ocrText,
    summary: parsed.summary || `${input.filename}: Vision/OCR analysis completed`,
    category: parsed.category || "document",
    keyPoints: parsed.keyPoints,
    extractedFields: parsed.extractedFields,
  };
}

function summarizeAttachmentCorrection(row: { evidence: string | null; createdAt: Date }) {
  const fallback = {
    filename: null as string | null,
    previousCategory: null as string | null,
    nextCategory: null as string | null,
    previousFieldKeys: [] as string[],
    nextFieldKeys: [] as string[],
    categoryChanged: false,
    fieldsChanged: false,
    summaryChanged: false,
    createdAt: row.createdAt.toISOString(),
  };
  if (!row.evidence) return fallback;
  try {
    const parsed = JSON.parse(row.evidence) as {
      filename?: unknown;
      previousCategory?: unknown;
      nextCategory?: unknown;
      category?: unknown;
      previousFieldKeys?: unknown;
      nextFieldKeys?: unknown;
      fieldKeys?: unknown;
      summaryChanged?: unknown;
    };
    const previousFieldKeys = Array.isArray(parsed.previousFieldKeys)
      ? parsed.previousFieldKeys.filter((key): key is string => typeof key === "string")
      : [];
    const nextFieldKeys = Array.isArray(parsed.nextFieldKeys)
      ? parsed.nextFieldKeys.filter((key): key is string => typeof key === "string")
      : Array.isArray(parsed.fieldKeys)
        ? parsed.fieldKeys.filter((key): key is string => typeof key === "string")
        : [];
    const previousCategory =
      typeof parsed.previousCategory === "string" ? parsed.previousCategory : null;
    const nextCategory =
      typeof parsed.nextCategory === "string"
        ? parsed.nextCategory
        : typeof parsed.category === "string"
          ? parsed.category
          : null;
    return {
      filename: typeof parsed.filename === "string" ? parsed.filename : null,
      previousCategory,
      nextCategory,
      previousFieldKeys,
      nextFieldKeys,
      categoryChanged: !!nextCategory && previousCategory !== nextCategory,
      fieldsChanged: previousFieldKeys.join("|") !== nextFieldKeys.join("|"),
      summaryChanged: parsed.summaryChanged === true,
      createdAt: row.createdAt.toISOString(),
    };
  } catch {
    return fallback;
  }
}

function attachmentIssueReason(status: string): string {
  if (status === "PENDING") return "Analysis pending";
  if (status === "FALLBACK") return "Fallback analysis after AI failure";
  if (status === "UNSUPPORTED") return "Text extraction limited";
  if (status === "VISION_FAILED") return "Vision/OCR analysis failed";
  return "Needs review";
}

// ─── Routes ──────────────────────────────────────────────────────────────

export async function registerEmailAttachmentsRoutes(app: FastifyInstance) {
  // GET /api/email/attachments/quality
  app.get("/attachments/quality", { preHandler: requireAuth }, async (request) => {
    const uid = getUserId(request);
    const { limit } = request.query as { limit?: string };
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const rows = await prisma.emailAttachment.findMany({
      where: { userId: uid },
      orderBy: { updatedAt: "desc" },
      take: safeLimit,
      select: {
        id: true,
        emailId: true,
        filename: true,
        mimeType: true,
        size: true,
        summary: true,
        contentText: true,
        keyPoints: true,
        extractedFields: true,
        category: true,
        analysisStatus: true,
        analysisError: true,
      },
    });
    const views = rows.map((row) => ({
      id: row.id,
      emailId: row.emailId,
      filename: row.filename,
      mimeType: row.mimeType,
      size: row.size,
      summary: row.summary,
      textPreview: row.contentText,
      keyPoints: parseJsonArray(row.keyPoints),
      extractedFields: parseJsonRecord(row.extractedFields),
      category: row.category,
      analysisStatus: row.analysisStatus,
      analysisError: row.analysisError,
    }));
    const candidateProfiles = new Map<string, ReturnType<typeof buildAttachmentCandidateProfile>>();
    for (const row of views) {
      if (candidateProfiles.has(row.emailId)) continue;
      const grouped = views.filter((item) => item.emailId === row.emailId);
      candidateProfiles.set(row.emailId, buildAttachmentCandidateProfile(grouped));
    }
    const correctedCount = rows.filter((row) => row.analysisStatus === "CORRECTED").length;
    const failedCount = rows.filter((row) =>
      ["FALLBACK", "UNSUPPORTED", "VISION_FAILED"].includes(row.analysisStatus),
    ).length;
    const manualReviewCount = Array.from(candidateProfiles.values()).reduce(
      (sum, profile) => sum + (profile?.manualReviewFiles.length ?? 0),
      0,
    );
    const candidateEmailCount = Array.from(candidateProfiles.values()).filter(Boolean).length;
    const recentCorrections = await prisma.feedbackEvent.findMany({
      where: {
        userId: uid,
        toolName: "email_attachment_analysis",
        signal: "EDITED",
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, evidence: true, createdAt: true },
    });
    const correctionSummaries = recentCorrections.map(summarizeAttachmentCorrection);
    const categoryCorrectionCount = correctionSummaries.filter(
      (item) => item.categoryChanged,
    ).length;
    const fieldCorrectionCount = correctionSummaries.filter((item) => item.fieldsChanged).length;

    return {
      totalAttachments: rows.length,
      candidateEmailCount,
      analyzedCount: rows.filter((row) => ["ANALYZED", "CORRECTED"].includes(row.analysisStatus))
        .length,
      correctedCount,
      failedCount,
      manualReviewCount,
      qualityScore:
        rows.length === 0
          ? 1
          : Math.max(0, Math.min(1, 1 - (failedCount + manualReviewCount * 0.5) / rows.length)),
      statusCounts: rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.analysisStatus] = (acc[row.analysisStatus] ?? 0) + 1;
        return acc;
      }, {}),
      categoryCounts: rows.reduce<Record<string, number>>((acc, row) => {
        const key = row.category || "uncategorized";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      topIssues: rows
        .filter((row) =>
          ["FALLBACK", "UNSUPPORTED", "VISION_FAILED", "PENDING"].includes(row.analysisStatus),
        )
        .slice(0, 8)
        .map((row) => ({
          attachmentId: row.id,
          emailId: row.emailId,
          filename: row.filename,
          status: row.analysisStatus,
          reason: row.analysisError ?? attachmentIssueReason(row.analysisStatus),
        })),
      recentCorrections,
      correctionSummary: {
        total: recentCorrections.length,
        categoryCorrectionCount,
        fieldCorrectionCount,
        summaryCorrectionCount: correctionSummaries.filter((item) => item.summaryChanged).length,
        categoryStability:
          recentCorrections.length === 0
            ? 1
            : Math.max(0, 1 - categoryCorrectionCount / recentCorrections.length),
        fieldStability:
          recentCorrections.length === 0
            ? 1
            : Math.max(0, 1 - fieldCorrectionCount / recentCorrections.length),
        examples: correctionSummaries.slice(0, 5),
      },
    };
  });

  // GET /api/email/:id/attachments/brief
  app.get("/:id/attachments/brief", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = getUserId(request);
    const dbEmail = await prisma.emailMessage.findFirst({
      where: { userId: uid, OR: [{ id }, { gmailId: id }] },
      select: {
        id: true,
        from: true,
        subject: true,
        summary: true,
        receivedAt: true,
      },
    });
    if (!dbEmail) return reply.code(404).send({ error: "Email not found" });

    const attachments = await listEmailAttachments([dbEmail.id], uid);
    const candidateProfile = buildAttachmentCandidateProfile(attachments);
    const brief = buildEmailAttachmentBrief({
      subject: dbEmail.subject,
      from: dbEmail.from,
      receivedAt: dbEmail.receivedAt,
      summary: dbEmail.summary,
      attachments,
      candidateProfile,
    });
    const buffer = Buffer.from(brief, "utf-8");
    return reply
      .header("Content-Type", "text/plain; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="klorn-attachment-brief.txt"`)
      .send(buffer);
  });

  // GET /api/email/:id/attachments/:attachmentId/download
  app.get(
    "/:id/attachments/:attachmentId/download",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id, attachmentId } = request.params as { id: string; attachmentId: string };
      const uid = getUserId(request);

      const row = await prisma.emailAttachment.findFirst({
        where: {
          id: attachmentId,
          userId: uid,
          email: { OR: [{ id }, { gmailId: id }] },
        },
        include: { email: { select: { gmailId: true } } },
      });
      if (!row) return reply.code(404).send({ error: "Attachment not found" });

      const auth = await getAuthedClient(uid);
      if (!auth) return reply.code(409).send({ error: "Gmail not connected" });

      const { google } = await import("googleapis");
      const gmail = google.gmail({ version: "v1", auth });
      const res = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: row.email.gmailId,
        id: row.gmailAttachmentId,
      });
      const data = res.data.data;
      if (!data) return reply.code(404).send({ error: "Attachment body not found" });

      const filename = safeAttachmentFilename(row.filename);
      const buffer = Buffer.from(data, "base64url");
      reply
        .header("Content-Type", row.mimeType || "application/octet-stream")
        .header("Content-Length", String(buffer.length))
        .header("Content-Disposition", `attachment; filename="${filename}"`);
      return reply.send(buffer);
    },
  );

  // POST /api/email/:id/attachments/:attachmentId/convert
  app.post(
    "/:id/attachments/:attachmentId/convert",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id, attachmentId } = request.params as { id: string; attachmentId: string };
      const uid = getUserId(request);
      const body = (request.body as { targetFormat?: unknown; format?: unknown }) || {};
      const target = normalizeConversionTarget(body.targetFormat ?? body.format);
      if (!target) {
        return reply.code(400).send({
          error: "Invalid conversion target",
          supportedTargets: SUPPORTED_CONVERSION_TARGETS,
        });
      }

      const row = await prisma.emailAttachment.findFirst({
        where: {
          id: attachmentId,
          userId: uid,
          email: { OR: [{ id }, { gmailId: id }] },
        },
        include: { email: { select: { gmailId: true } } },
      });
      if (!row) return reply.code(404).send({ error: "Attachment not found" });

      let sourceBuffer: Buffer | undefined;
      const needsOriginal = requiresOriginalAttachment(target);
      const prefersOriginal = target === "pdf" || target === "docx" || target === "xlsx";
      if (needsOriginal || prefersOriginal) {
        const auth = await getAuthedClient(uid);
        if (!auth && needsOriginal) return reply.code(409).send({ error: "Gmail not connected" });

        if (auth) {
          const { google } = await import("googleapis");
          const gmail = google.gmail({ version: "v1", auth });
          const res = await gmail.users.messages.attachments.get({
            userId: "me",
            messageId: row.email.gmailId,
            id: row.gmailAttachmentId,
          });
          const data = res.data.data;
          if (!data && needsOriginal)
            return reply.code(404).send({ error: "Attachment body not found" });
          sourceBuffer = data ? Buffer.from(data, "base64url") : undefined;
        }
      }

      try {
        const converted = await convertEmailAttachment({
          target,
          sourceBuffer,
          attachment: {
            id: row.id,
            filename: row.filename,
            mimeType: row.mimeType,
            size: row.size,
            contentText: row.contentText,
            summary: row.summary,
            keyPoints: parseJsonArray(row.keyPoints),
            extractedFields: parseJsonRecord(row.extractedFields),
            category: row.category,
            analysisStatus: row.analysisStatus,
            analysisError: row.analysisError,
          },
        });
        const filename = safeAttachmentFilename(converted.filename);
        const result = await saveConversionResult({
          userId: uid,
          filename,
          mimeType: converted.mimeType,
          buffer: converted.buffer,
          target,
          fileCount: 1,
        });
        reply
          .header("Content-Type", converted.mimeType)
          .header("Content-Length", String(converted.buffer.length))
          .header("X-Klorn-Conversion-Id", result.id)
          .header("Content-Disposition", `attachment; filename="${filename}"`);
        return reply.send(converted.buffer);
      } catch (err) {
        if (err instanceof FileConversionError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code });
        }
        request.log.error({ err }, "Attachment conversion failed");
        return reply.code(500).send({ error: "Attachment conversion failed" });
      }
    },
  );

  // POST /api/email/attachments/analyze
  app.post("/attachments/analyze", { preHandler: requireAuth }, async (request) => {
    const uid = getUserId(request);
    const { limit, retryFallback } =
      (request.body as { limit?: number; retryFallback?: boolean }) || {};

    if (retryFallback) {
      await prisma.$executeRaw`
        UPDATE "EmailAttachment"
        SET
          "analysisStatus" = 'PENDING',
          "analysisError" = NULL,
          "updatedAt" = NOW()
        WHERE "userId" = ${uid}
          AND "contentText" IS NOT NULL
          AND "analysisStatus" IN ('FALLBACK', 'FAILED')
      `;
    }

    const analyzed = await analyzePendingEmailAttachments(
      uid,
      Math.min(Math.max(limit || 25, 1), 100),
    );
    await syncRecentCandidateIntakes(uid, Math.min(Math.max(limit || 25, 1), 100));
    return { analyzed };
  });

  // POST /api/email/:id/attachments/analyze
  app.post("/:id/attachments/analyze", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = getUserId(request);
    const { force } = (request.body as { force?: boolean }) || {};

    const dbEmail = await prisma.emailMessage.findFirst({
      where: { userId: uid, OR: [{ id }, { gmailId: id }] },
      select: { id: true },
    });
    if (!dbEmail) return reply.code(404).send({ error: "Email not found" });

    const analyzed = await analyzeEmailAttachmentsForEmail({
      userId: uid,
      emailId: dbEmail.id,
      force: force !== false,
    });
    const attachments = await listEmailAttachments([dbEmail.id], uid);
    const candidateProfile = buildAttachmentCandidateProfile(attachments);
    const candidateIntake = candidateProfile
      ? await syncCandidateIntakeForEmail({ userId: uid, emailId: dbEmail.id })
      : null;
    return {
      analyzed,
      attachments,
      candidateProfile,
      candidateIntake,
    };
  });

  // POST /api/email/:id/attachments/ocr
  app.post("/:id/attachments/ocr", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = getUserId(request);
    const body = (request.body as { attachmentIds?: unknown; force?: boolean }) || {};
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter((value): value is string => typeof value === "string")
      : [];

    const dbEmail = await prisma.emailMessage.findFirst({
      where: { userId: uid, OR: [{ id }, { gmailId: id }] },
      select: { id: true, gmailId: true },
    });
    if (!dbEmail) return reply.code(404).send({ error: "Email not found" });

    const auth = await getAuthedClient(uid);
    if (!auth) return reply.code(409).send({ error: "Gmail not connected" });

    const rows = await prisma.emailAttachment.findMany({
      where: {
        userId: uid,
        emailId: dbEmail.id,
        ...(attachmentIds.length > 0 ? { id: { in: attachmentIds } } : {}),
      },
      select: {
        id: true,
        gmailAttachmentId: true,
        filename: true,
        mimeType: true,
        size: true,
        contentText: true,
        analysisStatus: true,
      },
      orderBy: { createdAt: "asc" },
      take: 12,
    });

    const { google } = await import("googleapis");
    const gmail = google.gmail({ version: "v1", auth });
    const results: Array<{ attachmentId: string; filename: string; status: string }> = [];

    for (const row of rows) {
      if (!body.force && !isVisionAttachment(row)) {
        results.push({ attachmentId: row.id, filename: row.filename, status: "skipped" });
        continue;
      }
      // Decorative chrome (logos, spacers, tracking pixels) carries no readable
      // content — mark it analyzed-and-done with a clear summary instead of
      // burning a vision call and surfacing a VISION_FAILED 404. `force` is the
      // escape hatch: an explicit OCR request still runs vision on it.
      if (!body.force && isDecorativeImage(row)) {
        await prisma.emailAttachment.update({
          where: { id: row.id },
          data: {
            analysisStatus: "ANALYZED",
            analysisError: null,
            summary: `${row.filename}: decorative image (logo/icon/spacer) — skipped OCR`,
            category: "image",
            keyPoints: [],
            extractedFields: {},
          },
        });
        results.push({ attachmentId: row.id, filename: row.filename, status: "skipped_decorative" });
        continue;
      }
      if ((row.size ?? 0) > MAX_VISION_ATTACHMENT_BYTES) {
        await prisma.emailAttachment.update({
          where: { id: row.id },
          data: {
            analysisStatus: "VISION_FAILED",
            analysisError: "Attachment is too large for vision OCR",
          },
        });
        results.push({ attachmentId: row.id, filename: row.filename, status: "too_large" });
        continue;
      }

      try {
        const res = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: dbEmail.gmailId,
          id: row.gmailAttachmentId,
        });
        const data = res.data.data;
        if (!data) throw new Error("Attachment body not found");
        const analysis = await analyzeVisualAttachment({
          userId: uid,
          filename: row.filename,
          mimeType: row.mimeType,
          content: Buffer.from(data, "base64url"),
        });
        await prisma.emailAttachment.update({
          where: { id: row.id },
          data: {
            contentText: analysis.ocrText || row.contentText,
            summary: analysis.summary,
            category: analysis.category,
            // JSONB after migration 20260519050000.
            keyPoints: analysis.keyPoints,
            extractedFields: analysis.extractedFields,
            analysisStatus: analysis.ocrText ? "ANALYZED" : "VISION_FAILED",
            analysisError: analysis.ocrText ? null : "Vision OCR returned no readable text",
          },
        });
        results.push({ attachmentId: row.id, filename: row.filename, status: "analyzed" });
      } catch (err) {
        await prisma.emailAttachment.update({
          where: { id: row.id },
          data: {
            analysisStatus: "VISION_FAILED",
            analysisError: err instanceof Error ? err.message.slice(0, 500) : "Vision OCR failed",
          },
        });
        results.push({ attachmentId: row.id, filename: row.filename, status: "failed" });
      }
    }

    const attachments = await listEmailAttachments([dbEmail.id], uid);
    const candidateProfile = buildAttachmentCandidateProfile(attachments);
    const candidateIntake = candidateProfile
      ? await syncCandidateIntakeForEmail({ userId: uid, emailId: dbEmail.id })
      : null;
    return { results, attachments, candidateProfile, candidateIntake };
  });

  // PATCH /api/email/:id/attachments/:attachmentId/analysis
  app.patch(
    "/:id/attachments/:attachmentId/analysis",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id, attachmentId } = request.params as { id: string; attachmentId: string };
      const uid = getUserId(request);
      const body =
        (request.body as {
          summary?: unknown;
          category?: unknown;
          keyPoints?: unknown;
          extractedFields?: unknown;
        }) || {};

      const row = await prisma.emailAttachment.findFirst({
        where: {
          id: attachmentId,
          userId: uid,
          email: { OR: [{ id }, { gmailId: id }] },
        },
        include: { email: { select: { id: true, threadId: true } } },
      });
      if (!row) return reply.code(404).send({ error: "Attachment not found" });

      const keyPoints = Array.isArray(body.keyPoints)
        ? body.keyPoints.filter((point): point is string => typeof point === "string").slice(0, 8)
        : row.keyPoints
          ? parseJsonArray(row.keyPoints)
          : [];
      const previousFields = parseJsonRecord(row.extractedFields);
      const extractedFields =
        body.extractedFields &&
        typeof body.extractedFields === "object" &&
        !Array.isArray(body.extractedFields)
          ? (body.extractedFields as Record<string, string | number | boolean | null>)
          : previousFields;
      const nextSummary = typeof body.summary === "string" ? body.summary.trim() : row.summary;
      const nextCategory = typeof body.category === "string" ? body.category.trim() : row.category;

      await prisma.emailAttachment.update({
        where: { id: row.id },
        data: {
          summary: nextSummary,
          category: nextCategory,
          // JSONB after migration 20260519050000.
          keyPoints: keyPoints,
          extractedFields: extractedFields,
          analysisStatus: "CORRECTED",
          analysisError: null,
        },
      });
      await recordLedgerFeedback({
        userId: uid,
        source: "ATTENTION_ITEM",
        sourceId: `email-attachment:${row.id}`,
        signal: "EDITED",
        toolName: "email_attachment_analysis",
        threadId: row.email.threadId,
        evidence: JSON.stringify({
          filename: row.filename,
          previousCategory: row.category,
          nextCategory,
          previousFieldKeys: Object.keys(previousFields),
          nextFieldKeys: Object.keys(extractedFields),
          summaryChanged: (row.summary ?? "") !== (nextSummary ?? ""),
        }),
      });

      const attachments = await listEmailAttachments([row.email.id], uid);
      const candidateProfile = buildAttachmentCandidateProfile(attachments);
      const candidateIntake = candidateProfile
        ? await syncCandidateIntakeForEmail({ userId: uid, emailId: row.email.id })
        : null;
      return {
        attachment: attachments.find((attachment) => attachment.id === row.id),
        attachments,
        candidateProfile,
        candidateIntake,
      };
    },
  );
}
