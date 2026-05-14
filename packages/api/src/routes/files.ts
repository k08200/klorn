import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import {
  type ExtractedAttachmentContent,
  extractAttachmentContent,
} from "../email-attachment-text.js";
import {
  cleanupExpiredConversionResults,
  getConversionResult,
  listConversionQualityReports,
  listConversionResults,
  saveConversionQualityReport,
  saveConversionResult,
} from "../file-conversion-store.js";
import {
  type AttachmentConversionTarget,
  convertEmailAttachment,
  createStoredZip,
  FileConversionError,
  getFileConversionCapabilities,
  getFileConversionEngineStatus,
  normalizeConversionTarget,
  recommendConversionTargets,
  runFileConversionQualitySuite,
  SUPPORTED_CONVERSION_TARGETS,
} from "../file-conversions.js";

const MAX_CONVERSION_UPLOAD_BYTES = 18_000_000;
const MAX_BATCH_UPLOAD_BYTES = 54_000_000;
const MAX_BATCH_FILES = 20;

interface UploadedConversionFile {
  filename?: unknown;
  mimeType?: unknown;
  contentBase64?: unknown;
}

export async function fileRoutes(app: FastifyInstance) {
  app.get("/conversions", { preHandler: requireAuth }, async () => ({
    targets: SUPPORTED_CONVERSION_TARGETS,
    capabilities: getFileConversionCapabilities(),
    engines: getFileConversionEngineStatus(),
  }));

  app.get("/quality-tests", { preHandler: requireAuth }, async (request) => {
    const uid = getUserId(request);
    return { reports: await listConversionQualityReports(uid, 12) };
  });

  app.post("/quality-tests/run", { preHandler: requireAuth }, async (request) => {
    const uid = getUserId(request);
    const report = await runFileConversionQualitySuite();
    return saveConversionQualityReport(uid, report);
  });

  app.get("/results", { preHandler: requireAuth }, async (request) => {
    const uid = getUserId(request);
    await cleanupExpiredConversionResults(uid);
    return { results: await listConversionResults(uid, 20) };
  });

  app.post(
    "/preview",
    { preHandler: requireAuth, bodyLimit: MAX_CONVERSION_UPLOAD_BYTES * 2 },
    async (request, reply) => {
      const body =
        (request.body as {
          filename?: unknown;
          mimeType?: unknown;
          contentBase64?: unknown;
        }) || {};
      const prepared = prepareUploadedFile(body);
      if ("error" in prepared)
        return reply.code(prepared.statusCode).send({ error: prepared.error });

      const extracted = extractUploadedText(
        prepared.sourceBuffer,
        prepared.filename,
        prepared.mimeType,
      );
      return {
        filename: prepared.filename,
        mimeType: prepared.mimeType,
        size: prepared.sourceBuffer.length,
        status: extracted.status,
        quality: previewQuality(extracted),
        preview: buildPreview(extracted.text),
        recommendations: recommendConversionTargets({
          filename: prepared.filename,
          mimeType: prepared.mimeType,
          extractionStatus: extracted.status,
        }),
      };
    },
  );

  app.post(
    "/convert",
    { preHandler: requireAuth, bodyLimit: MAX_CONVERSION_UPLOAD_BYTES * 2 },
    async (request, reply) => {
      const body =
        (request.body as {
          filename?: unknown;
          mimeType?: unknown;
          contentBase64?: unknown;
          targetFormat?: unknown;
        }) || {};
      const target = normalizeConversionTarget(body.targetFormat);
      if (!target) {
        return reply.code(400).send({
          error: "Invalid conversion target",
          supportedTargets: SUPPORTED_CONVERSION_TARGETS,
        });
      }
      const prepared = prepareUploadedFile(body);
      if ("error" in prepared)
        return reply.code(prepared.statusCode).send({ error: prepared.error });

      try {
        const uid = getUserId(request);
        const converted = await convertUploadedFile(prepared, target);
        const result = await saveConversionResult({
          userId: uid,
          filename: converted.filename,
          mimeType: converted.mimeType,
          buffer: converted.buffer,
          target,
          fileCount: 1,
        });
        return reply
          .header("Content-Type", converted.mimeType)
          .header("Content-Length", String(converted.buffer.length))
          .header("X-Jigeum-Conversion-Id", result.id)
          .header("Content-Disposition", `attachment; filename="${converted.filename}"`)
          .send(converted.buffer);
      } catch (err) {
        if (err instanceof FileConversionError) {
          return reply.code(err.statusCode).send({
            error: err.message,
            code: err.code,
            alternatives: conversionAlternatives(prepared, target),
          });
        }
        request.log.error({ err }, "File conversion failed");
        return reply.code(500).send({
          error: "File conversion failed",
          alternatives: conversionAlternatives(prepared, target),
        });
      }
    },
  );

  app.post(
    "/convert-batch",
    { preHandler: requireAuth, bodyLimit: MAX_BATCH_UPLOAD_BYTES * 2 },
    async (request, reply) => {
      const body =
        (request.body as {
          files?: unknown;
          targetFormat?: unknown;
        }) || {};
      const target = normalizeConversionTarget(body.targetFormat);
      if (!target) {
        return reply.code(400).send({
          error: "Invalid conversion target",
          supportedTargets: SUPPORTED_CONVERSION_TARGETS,
        });
      }
      if (!Array.isArray(body.files) || body.files.length === 0) {
        return reply.code(400).send({ error: "files are required" });
      }
      if (body.files.length > MAX_BATCH_FILES) {
        return reply
          .code(400)
          .send({ error: `Batch conversion is limited to ${MAX_BATCH_FILES} files` });
      }

      const preparedFiles = body.files.map((file) =>
        prepareUploadedFile(file as UploadedConversionFile),
      );
      const firstInvalid = preparedFiles.find(
        (file): file is { error: string; statusCode: number } => "error" in file,
      );
      if (firstInvalid)
        return reply.code(firstInvalid.statusCode).send({ error: firstInvalid.error });

      const validFiles = preparedFiles.filter(
        (file): file is PreparedUploadedFile => !("error" in file),
      );
      const totalBytes = validFiles.reduce((sum, file) => sum + file.sourceBuffer.length, 0);
      if (totalBytes > MAX_BATCH_UPLOAD_BYTES) {
        return reply.code(413).send({ error: "Batch is too large for conversion" });
      }

      const entries: Array<{ name: string; data: Buffer }> = [];
      for (const file of validFiles) {
        try {
          const converted = await convertUploadedFile(file, target);
          entries.push({ name: converted.filename, data: converted.buffer });
        } catch (err) {
          const message =
            err instanceof FileConversionError || err instanceof Error
              ? err.message
              : "File conversion failed";
          entries.push({
            name: `${safeZipName(file.filename)}.conversion-error.txt`,
            data: Buffer.from(`${file.filename}\n${message}\n`, "utf-8"),
          });
        }
      }

      const zip = createStoredZip(entries);
      const uid = getUserId(request);
      const result = await saveConversionResult({
        userId: uid,
        filename: `jigeum-converted-${target}.zip`,
        mimeType: "application/zip",
        buffer: zip,
        target,
        fileCount: validFiles.length,
      });
      return reply
        .header("Content-Type", "application/zip")
        .header("Content-Length", String(zip.length))
        .header("X-Jigeum-Conversion-Id", result.id)
        .header("Content-Disposition", `attachment; filename="jigeum-converted-${target}.zip"`)
        .send(zip);
    },
  );

  app.get("/results/:resultId/download", { preHandler: requireAuth }, async (request, reply) => {
    const uid = getUserId(request);
    const { resultId } = request.params as { resultId: string };
    const result = await getConversionResult(uid, resultId);
    if (!result) {
      return reply.code(404).send({ error: "Conversion result not found or expired" });
    }
    return reply
      .header("Content-Type", result.meta.mimeType)
      .header("Content-Length", String(result.buffer.length))
      .header("Content-Disposition", `attachment; filename="${result.meta.filename}"`)
      .send(result.buffer);
  });
}

interface PreparedUploadedFile {
  filename: string;
  mimeType: string;
  sourceBuffer: Buffer;
}

function prepareUploadedFile(
  body: UploadedConversionFile,
): PreparedUploadedFile | { error: string; statusCode: number } {
  if (typeof body.filename !== "string" || body.filename.trim().length === 0) {
    return { error: "filename is required", statusCode: 400 };
  }
  if (typeof body.contentBase64 !== "string" || body.contentBase64.length === 0) {
    return { error: "contentBase64 is required", statusCode: 400 };
  }
  const filename = body.filename.trim();
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream";
  const sourceBuffer = Buffer.from(stripDataUrlPrefix(body.contentBase64), "base64");
  if (sourceBuffer.length > MAX_CONVERSION_UPLOAD_BYTES) {
    return { error: "File is too large for conversion", statusCode: 413 };
  }
  return { filename, mimeType, sourceBuffer };
}

async function convertUploadedFile(file: PreparedUploadedFile, target: AttachmentConversionTarget) {
  const extracted = extractUploadedText(file.sourceBuffer, file.filename, file.mimeType);
  return convertEmailAttachment({
    target,
    sourceBuffer: file.sourceBuffer,
    attachment: {
      id: "uploaded-file",
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.sourceBuffer.length,
      contentText: extracted.text,
      summary: null,
      keyPoints: [],
      extractedFields: {},
      category: null,
      analysisStatus: extracted.text ? "EXTRACTED" : "UPLOADED",
      analysisError: extracted.status === "readable" ? null : extracted.status,
    },
  });
}

function buildPreview(text: string | null): string | null {
  if (!text?.trim()) return null;
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10)
    .join("\n")
    .slice(0, 1200);
}

function previewQuality(
  extracted: ExtractedAttachmentContent,
): "readable" | "metadata" | "unsupported" {
  return extracted.status;
}

function safeZipName(filename: string): string {
  return filename.replace(/[\\/:*?"<>|]+/g, "_") || "file";
}

function conversionAlternatives(
  file: PreparedUploadedFile,
  attemptedTarget: AttachmentConversionTarget,
): Array<{ target: AttachmentConversionTarget; reason: string }> {
  const extracted = extractUploadedText(file.sourceBuffer, file.filename, file.mimeType);
  const capabilities = new Map(
    getFileConversionCapabilities().map((capability) => [capability.target, capability]),
  );
  return recommendConversionTargets({
    filename: file.filename,
    mimeType: file.mimeType,
    extractionStatus: extracted.status,
  })
    .filter((item) => item.target !== attemptedTarget)
    .filter((item) => {
      const capability = capabilities.get(item.target);
      return !capability || capability.mode === "builtin" || capability.available;
    })
    .slice(0, 3)
    .map((item) => ({ target: item.target, reason: item.reason }));
}

function stripDataUrlPrefix(value: string): string {
  const marker = "base64,";
  const index = value.indexOf(marker);
  return index >= 0 ? value.slice(index + marker.length) : value;
}

function extractUploadedText(
  sourceBuffer: Buffer,
  filename: string,
  mimeType: string,
): ExtractedAttachmentContent {
  try {
    return extractAttachmentContent(sourceBuffer, filename, mimeType);
  } catch {
    return {
      text: null,
      status: "unsupported",
    };
  }
}
