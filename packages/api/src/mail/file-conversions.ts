import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildCsvConversion,
  buildDocxConversion,
  buildHtmlConversion,
  buildJsonConversion,
  buildMarkdownConversion,
  buildPdfConversion,
  buildRtfConversion,
  buildSvgConversion,
  buildTextConversion,
  buildXlsxConversion,
  buildXmlConversion,
  buildYamlConversion,
  zipStore,
} from "./file-conversion-builders.js";

export type AttachmentConversionTarget =
  | "txt"
  | "md"
  | "json"
  | "yaml"
  | "csv"
  | "html"
  | "xml"
  | "svg"
  | "rtf"
  | "pdf"
  | "docx"
  | "xlsx"
  | "png"
  | "jpg"
  | "webp"
  | "dwg"
  | "dxf";

export interface AttachmentForConversion {
  id: string;
  filename: string;
  mimeType: string;
  size: number | null;
  contentText: string | null;
  summary: string | null;
  keyPoints: string[];
  extractedFields: Record<string, string | number | boolean | null>;
  category: string | null;
  analysisStatus: string;
  analysisError: string | null;
}

export interface ConvertedAttachment {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

export class FileConversionError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "FileConversionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const SUPPORTED_CONVERSION_TARGETS: AttachmentConversionTarget[] = [
  "txt",
  "md",
  "json",
  "yaml",
  "csv",
  "html",
  "xml",
  "svg",
  "rtf",
  "pdf",
  "docx",
  "xlsx",
  "png",
  "jpg",
  "webp",
  "dwg",
  "dxf",
];

export interface FileConversionCapability {
  target: AttachmentConversionTarget;
  label: string;
  mode: "builtin" | "external";
  available: boolean;
  description: string;
}

export interface FileConversionRecommendation {
  target: AttachmentConversionTarget;
  reason: string;
  priority: number;
}

export interface FileConversionEngineStatus {
  id: "office-layout" | "image-raster" | "cad-dwg" | "cad-dxf";
  label: string;
  category: "layout" | "image" | "cad";
  available: boolean;
  source: "env" | "auto" | "missing";
  executable: string | null;
  targets: AttachmentConversionTarget[];
  targetStatuses: Array<{ target: AttachmentConversionTarget; available: boolean }>;
  detail: string;
  setupHint: string;
}

export interface FileConversionQualityScenarioResult {
  id: string;
  label: string;
  category: "builtin" | "layout" | "image" | "cad";
  status: "pass" | "warn" | "blocked" | "fail";
  detail: string;
  durationMs: number;
  outputBytes?: number;
}

export interface FileConversionQualityReport {
  score: number;
  generatedAt: string;
  passed: number;
  warned: number;
  blocked: number;
  failed: number;
  scenarios: FileConversionQualityScenarioResult[];
}

export function getFileConversionCapabilities(): FileConversionCapability[] {
  return SUPPORTED_CONVERSION_TARGETS.map((target) => {
    if (target === "dwg" || target === "dxf") {
      const suffix = target.toUpperCase();
      const config = readExternalConverterConfig(target);
      return {
        target,
        label: suffix,
        mode: "external",
        available: !!config,
        description: `Convert PDF drawings into ${suffix} CAD files.`,
      };
    }
    if (isRasterTarget(target)) {
      const config = readImageConverterConfig(target);
      return {
        target,
        label: target.toUpperCase(),
        mode: "external",
        available: !!config,
        description: `Convert images to ${target.toUpperCase()} format.`,
      };
    }
    if (target === "pdf" || target === "docx" || target === "xlsx") {
      const hasLayoutEngine = !!readOfficeConverterConfig();
      return {
        target,
        label: target.toUpperCase(),
        mode: "builtin",
        available: true,
        description: hasLayoutEngine
          ? `${target.toUpperCase()} conversion prefers the layout-preserving engine and falls back to the built-in report renderer.`
          : `${builtinDescription(target)} Connect LibreOffice/soffice to preserve the original layout.`,
      };
    }
    return {
      target,
      label: target.toUpperCase(),
      mode: "builtin",
      available: true,
      description: builtinDescription(target),
    };
  });
}

export function getFileConversionEngineStatus(): FileConversionEngineStatus[] {
  const office = readOfficeConverterConfig();
  const png = readImageConverterConfig("png");
  const jpg = readImageConverterConfig("jpg");
  const webp = readImageConverterConfig("webp");
  const dwg = readExternalConverterConfig("dwg");
  const dxf = readExternalConverterConfig("dxf");
  const dxfToDwg = readDxfToDwgConverterConfig();
  const dwgAvailable = !!dwg || (!!dxf && !!dxfToDwg);

  return [
    {
      id: "office-layout",
      label: "Layout engine",
      category: "layout",
      available: !!office,
      source: engineSource(["EVE_LIBREOFFICE_BIN", "EVE_OFFICE_CONVERTER_BIN"], !!office),
      executable: office?.bin ?? null,
      targets: ["pdf", "docx", "xlsx"],
      targetStatuses: [
        { target: "pdf", available: !!office },
        { target: "docx", available: !!office },
        { target: "xlsx", available: !!office },
      ],
      detail: office
        ? "Layout-preserving conversion is attempted first."
        : "Only the built-in report renderer is active.",
      setupHint: "Install LibreOffice/soffice or set EVE_LIBREOFFICE_BIN.",
    },
    {
      id: "image-raster",
      label: "Image engine",
      category: "image",
      available: !!(png || jpg || webp),
      source: engineSource(
        [
          "EVE_IMAGE_CONVERTER_BIN",
          "EVE_IMAGE_TO_PNG_BIN",
          "EVE_IMAGE_TO_JPG_BIN",
          "EVE_IMAGE_TO_WEBP_BIN",
        ],
        !!(png || jpg || webp),
      ),
      executable: png?.bin ?? jpg?.bin ?? webp?.bin ?? null,
      targets: ["png", "jpg", "webp"],
      targetStatuses: [
        { target: "png", available: !!png },
        { target: "jpg", available: !!jpg },
        { target: "webp", available: !!webp },
      ],
      detail:
        png || jpg || webp
          ? "Image re-encoding is available."
          : "Only identity (same-format) conversion is available.",
      setupHint: "Install ImageMagick (magick) or set EVE_IMAGE_CONVERTER_BIN.",
    },
    {
      id: "cad-dwg",
      label: "PDF to DWG",
      category: "cad",
      available: dwgAvailable,
      source: engineSource(["EVE_PDF_TO_DWG_BIN", "EVE_DXF_TO_DWG_BIN"], dwgAvailable),
      executable: dwg?.bin ?? dxfToDwg?.bin ?? null,
      targets: ["dwg"],
      targetStatuses: [{ target: "dwg", available: dwgAvailable }],
      detail: dwg
        ? "A dedicated DWG converter is connected."
        : dwgAvailable
          ? "PDF→DXF→DWG post-processing pipeline is connected."
          : "No DWG converter or DXF→DWG post-processor is configured.",
      setupHint: "Install ODA File Converter or set EVE_DXF_TO_DWG_BIN / EVE_PDF_TO_DWG_BIN.",
    },
    {
      id: "cad-dxf",
      label: "PDF to DXF",
      category: "cad",
      available: !!dxf,
      source: engineSource(["EVE_PDF_TO_DXF_BIN"], !!dxf),
      executable: dxf?.bin ?? null,
      targets: ["dxf"],
      targetStatuses: [{ target: "dxf", available: !!dxf }],
      detail: dxf ? "DXF converter is connected." : "No DXF converter is configured.",
      setupHint: "Install pstoedit or set EVE_PDF_TO_DXF_BIN.",
    },
  ];
}

export async function runFileConversionQualitySuite(): Promise<FileConversionQualityReport> {
  const builtinTargets: AttachmentConversionTarget[] = [
    "txt",
    "md",
    "json",
    "yaml",
    "csv",
    "html",
    "xml",
    "svg",
    "rtf",
    "pdf",
    "docx",
    "xlsx",
  ];
  const scenarios = await Promise.all([
    ...builtinTargets.map((target) => runBuiltinQualityScenario(target)),
    runPassthroughQualityScenario("image-png-pass", "PNG identity", "png"),
    runPassthroughQualityScenario("image-jpg-pass", "JPG identity", "jpg"),
    runPassthroughQualityScenario("image-webp-pass", "WEBP identity", "webp"),
    runImageReencodeScenario("image-svg-webp", "SVG → WEBP re-encode", "webp"),
    runLayoutEngineScenario(),
    runDxfEngineScenario(),
    runDwgPipelineScenario(),
    runEngineReadinessScenario(
      "layout-engine",
      "Layout-preserving engine",
      "layout",
      readOfficeConverterConfig(),
    ),
    runEngineReadinessScenario(
      "cad-dwg-engine",
      "PDF → DWG engine",
      "cad",
      readDwgReadinessConfig(),
    ),
    runEngineReadinessScenario(
      "cad-dxf-engine",
      "PDF → DXF engine",
      "cad",
      readExternalConverterConfig("dxf"),
    ),
  ]);

  const passed = scenarios.filter((item) => item.status === "pass").length;
  const warned = scenarios.filter((item) => item.status === "warn").length;
  const blocked = scenarios.filter((item) => item.status === "blocked").length;
  const failed = scenarios.filter((item) => item.status === "fail").length;
  const weighted = passed + warned * 0.5;
  return {
    score: Math.round((weighted / scenarios.length) * 100),
    generatedAt: new Date().toISOString(),
    passed,
    warned,
    blocked,
    failed,
    scenarios,
  };
}

export function recommendConversionTargets(input: {
  filename: string;
  mimeType: string;
  extractionStatus?: "readable" | "metadata" | "unsupported" | string | null;
}): FileConversionRecommendation[] {
  const lower = input.filename.toLowerCase();
  const mime = input.mimeType.toLowerCase();
  const recommendations: FileConversionRecommendation[] = [];

  const push = (target: AttachmentConversionTarget, reason: string, priority: number) => {
    if (!recommendations.some((item) => item.target === target)) {
      recommendations.push({ target, reason, priority });
    }
  };

  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic|svg)$/i.test(lower)) {
    const source = inferImageFormat({
      id: "",
      filename: input.filename,
      mimeType: input.mimeType,
      size: null,
      contentText: null,
      summary: null,
      keyPoints: [],
      extractedFields: {},
      category: null,
      analysisStatus: "",
      analysisError: null,
    });
    if (source === "png") push("png", "Preserves the original image format.", 100);
    else if (source === "jpeg") push("jpg", "Preserves the original image format.", 100);
    else if (source === "webp") push("webp", "Preserves the original image format.", 100);
    push("pdf", "Bundles the image into a review-ready PDF report.", 70);
    push("svg", "Stores image metadata as a summary card.", 55);
    return recommendations.sort((a, b) => b.priority - a.priority);
  }

  if (mime.includes("spreadsheet") || /\.(xlsx|xls|csv|tsv)$/i.test(lower)) {
    push("xlsx", "Keeps tabular structure intact.", 100);
    push("csv", "Easy to import into other systems.", 90);
    push("json", "Best for structured data integrations.", 70);
    return recommendations.sort((a, b) => b.priority - a.priority);
  }

  if (mime.includes("pdf") || lower.endsWith(".pdf")) {
    push("pdf", "Keeps a review-ready PDF report.", 90);
    push("docx", "Moves extracted content into an editable document.", 80);
    if (input.extractionStatus === "readable") push("txt", "Preserves the PDF text layer.", 75);
    push("dwg", "CAD-conversion candidate for engineering drawings.", 60);
    push("dxf", "Use when a drawing-exchange format is required.", 55);
    return recommendations.sort((a, b) => b.priority - a.priority);
  }

  if (mime.includes("word") || /\.(docx|doc|hwp|hwpx|rtf)$/i.test(lower)) {
    push("docx", "Keep as an editable document.", 100);
    push("pdf", "Good for sharing as a finished document.", 85);
    push("md", "Light option for tidied-up content.", 70);
    push("txt", "Extracts plain body text only.", 60);
    return recommendations.sort((a, b) => b.priority - a.priority);
  }

  if (input.extractionStatus === "readable" || /\.(txt|md|json|xml|html|yaml|yml)$/i.test(lower)) {
    push("md", "Reformats into a readable summary.", 95);
    push("pdf", "Saves as a shareable report.", 85);
    push("json", "Best when structured output is required.", 75);
    push("txt", "Preserves the body text only.", 70);
    return recommendations.sort((a, b) => b.priority - a.priority);
  }

  push("pdf", "Saves as a review-ready report.", 70);
  push("json", "Preserves metadata and extracted content.", 60);
  return recommendations.sort((a, b) => b.priority - a.priority);
}

async function runQualityScenario(
  id: string,
  label: string,
  category: FileConversionQualityScenarioResult["category"],
  fn: () => Promise<{ detail: string; outputBytes?: number }>,
): Promise<FileConversionQualityScenarioResult> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    return {
      id,
      label,
      category,
      status: "pass",
      detail: result.detail,
      durationMs: Date.now() - startedAt,
      outputBytes: result.outputBytes,
    };
  } catch (err) {
    return {
      id,
      label,
      category,
      status: "fail",
      detail: err instanceof Error ? err.message : "Quality test failed.",
      durationMs: Date.now() - startedAt,
    };
  }
}

function runBuiltinQualityScenario(
  target: AttachmentConversionTarget,
): Promise<FileConversionQualityScenarioResult> {
  return runQualityScenario(
    `builtin-${target}`,
    `${target.toUpperCase()} built-in conversion`,
    "builtin",
    async () => {
      const attachment = qualityAttachment(
        target === "xlsx"
          ? {
              filename: "applicants.csv",
              mimeType: "text/csv",
              contentText: "name,role\nHana Kim,Actor\nDoyoon Park,Model",
            }
          : { filename: "actor-profile.txt", mimeType: "text/plain" },
      );
      const converted = await convertEmailAttachment({ target, attachment });
      assertConvertedOutput(target, converted.buffer);
      return {
        detail: `${target.toUpperCase()} sample conversion produced valid output.`,
        outputBytes: converted.buffer.length,
      };
    },
  );
}

function runPassthroughQualityScenario(
  id: string,
  label: string,
  target: "png" | "jpg" | "webp",
): Promise<FileConversionQualityScenarioResult> {
  return runQualityScenario(id, label, "image", async () => {
    const source = sampleImageBuffer(target);
    const converted = await convertEmailAttachment({
      target,
      sourceBuffer: source,
      attachment: qualityAttachment({
        filename: `headshot.${target}`,
        mimeType: imageMimeType(target),
      }),
    });
    if (!converted.buffer.equals(source))
      throw new Error("Original image bytes were not preserved.");
    return {
      detail: "Identity conversion preserves the original bytes.",
      outputBytes: converted.buffer.length,
    };
  });
}

function runImageReencodeScenario(
  id: string,
  label: string,
  target: "png" | "jpg" | "webp",
): Promise<FileConversionQualityScenarioResult> | FileConversionQualityScenarioResult {
  if (!readImageConverterConfig(target)) {
    return blockedQualityScenario(id, label, "image", "An image re-encoding engine is required.");
  }
  return runQualityScenario(id, label, "image", async () => {
    const converted = await convertEmailAttachment({
      target,
      sourceBuffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#38bdf8"/></svg>',
        "utf-8",
      ),
      attachment: qualityAttachment({ filename: "headshot.svg", mimeType: "image/svg+xml" }),
    });
    assertConvertedOutput(target, converted.buffer);
    return {
      detail: `ImageMagick path runs the SVG → ${target.toUpperCase()} conversion.`,
      outputBytes: converted.buffer.length,
    };
  });
}

function runLayoutEngineScenario():
  | Promise<FileConversionQualityScenarioResult>
  | FileConversionQualityScenarioResult {
  if (!readOfficeConverterConfig()) {
    return blockedQualityScenario(
      "layout-rtf-pdf",
      "RTF → PDF layout-preserving conversion",
      "layout",
      "LibreOffice/soffice must be connected.",
    );
  }
  return runQualityScenario(
    "layout-rtf-pdf",
    "RTF → PDF layout-preserving conversion",
    "layout",
    async () => {
      const source = Buffer.from(
        "{\\rtf1\\ansi\\deff0\\b EVE Profile\\b0\\par Name: Hana Kim\\par Role: Actor\\par}",
        "utf-8",
      );
      const converted = await convertEmailAttachment({
        target: "pdf",
        sourceBuffer: source,
        attachment: qualityAttachment({
          filename: "layout-profile.rtf",
          mimeType: "application/rtf",
        }),
      });
      assertConvertedOutput("pdf", converted.buffer);
      return {
        detail: "LibreOffice path runs the layout-preserving conversion.",
        outputBytes: converted.buffer.length,
      };
    },
  );
}

function runDxfEngineScenario():
  | Promise<FileConversionQualityScenarioResult>
  | FileConversionQualityScenarioResult {
  if (!readExternalConverterConfig("dxf")) {
    return blockedQualityScenario(
      "cad-pdf-dxf",
      "PDF → DXF live conversion",
      "cad",
      "A PDF → DXF engine must be connected.",
    );
  }
  return runQualityScenario("cad-pdf-dxf", "PDF → DXF live conversion", "cad", async () => {
    const pdf = await convertEmailAttachment({ target: "pdf", attachment: qualityAttachment() });
    const converted = await convertEmailAttachment({
      target: "dxf",
      sourceBuffer: pdf.buffer,
      attachment: qualityAttachment({ filename: "floor-plan.pdf", mimeType: "application/pdf" }),
    });
    if (converted.buffer.length === 0) throw new Error("DXF output is empty.");
    return {
      detail: "pstoedit path runs the PDF → DXF conversion.",
      outputBytes: converted.buffer.length,
    };
  });
}

function runDwgPipelineScenario():
  | Promise<FileConversionQualityScenarioResult>
  | FileConversionQualityScenarioResult {
  if (!readDwgReadinessConfig()) {
    return blockedQualityScenario(
      "cad-pdf-dwg-pipeline",
      "PDF → DXF → DWG pipeline",
      "cad",
      "A dedicated DWG engine or a DXF → DWG post-processor must be connected.",
    );
  }
  return runQualityScenario("cad-pdf-dwg-pipeline", "PDF → DXF → DWG pipeline", "cad", async () => {
    const pdf = await convertEmailAttachment({ target: "pdf", attachment: qualityAttachment() });
    const converted = await convertEmailAttachment({
      target: "dwg",
      sourceBuffer: pdf.buffer,
      attachment: qualityAttachment({ filename: "floor-plan.pdf", mimeType: "application/pdf" }),
    });
    if (converted.buffer.length === 0) throw new Error("DWG output is empty.");
    return {
      detail: "PDF → DXF → DWG pipeline ran end to end.",
      outputBytes: converted.buffer.length,
    };
  });
}

function runEngineReadinessScenario(
  id: string,
  label: string,
  category: "layout" | "cad",
  config: { bin: string } | null,
): FileConversionQualityScenarioResult {
  return {
    id,
    label,
    category,
    status: config ? "pass" : "blocked",
    detail: config
      ? `${config.bin} executable is connected.`
      : "An external conversion engine must be connected.",
    durationMs: 0,
  };
}

function blockedQualityScenario(
  id: string,
  label: string,
  category: FileConversionQualityScenarioResult["category"],
  detail: string,
): FileConversionQualityScenarioResult {
  return { id, label, category, status: "blocked", detail, durationMs: 0 };
}

function assertConvertedOutput(target: AttachmentConversionTarget, buffer: Buffer): void {
  if (buffer.length === 0) throw new Error("Output file is empty.");
  if (target === "pdf" && buffer.subarray(0, 5).toString("utf-8") !== "%PDF-") {
    throw new Error("PDF signature missing.");
  }
  if (
    (target === "docx" || target === "xlsx") &&
    buffer.subarray(0, 4).toString("hex") !== "504b0304"
  ) {
    throw new Error(`${target.toUpperCase()} ZIP signature missing.`);
  }
  if (target === "svg" && !buffer.toString("utf-8", 0, 200).includes("<svg")) {
    throw new Error("SVG markup missing.");
  }
  if (target === "webp" && buffer.subarray(0, 4).toString("utf-8") !== "RIFF") {
    throw new Error("WEBP RIFF signature missing.");
  }
  if (target === "png" && buffer.subarray(0, 4).toString("hex") !== "89504e47") {
    throw new Error("PNG signature missing.");
  }
}

function sampleImageBuffer(target: "png" | "jpg" | "webp"): Buffer {
  if (target === "png") {
    return Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    );
  }
  if (target === "webp") return Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "binary");
  return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
}

function qualityAttachment(
  overrides: Partial<AttachmentForConversion> = {},
): AttachmentForConversion {
  return {
    id: "quality-sample",
    filename: "actor-profile.txt",
    mimeType: "text/plain",
    size: 128,
    contentText: "Name: Hana Kim\nRole: Actor\nContact: 010-1234-5678\nExperience: 2 indie films",
    summary: "Actor applicant profile",
    keyPoints: ["Actor application", "Contact included", "Experience included"],
    extractedFields: {
      name: "Hana Kim",
      role: "Actor",
      phone: "010-1234-5678",
    },
    category: "profile",
    analysisStatus: "ANALYZED",
    analysisError: null,
    ...overrides,
  };
}

export function createStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  return zipStore(entries);
}

const TARGETS = new Set<AttachmentConversionTarget>(SUPPORTED_CONVERSION_TARGETS);

export function normalizeConversionTarget(value: unknown): AttachmentConversionTarget | null {
  if (typeof value !== "string") return null;
  const target = value.trim().toLowerCase();
  return TARGETS.has(target as AttachmentConversionTarget)
    ? (target as AttachmentConversionTarget)
    : null;
}

export function requiresOriginalAttachment(target: AttachmentConversionTarget): boolean {
  return target === "dwg" || target === "dxf" || isRasterTarget(target);
}

export async function convertEmailAttachment(input: {
  attachment: AttachmentForConversion;
  target: AttachmentConversionTarget;
  sourceBuffer?: Buffer;
}): Promise<ConvertedAttachment> {
  switch (input.target) {
    case "txt":
      return buildTextConversion(input.attachment);
    case "md":
      return buildMarkdownConversion(input.attachment);
    case "json":
      return buildJsonConversion(input.attachment);
    case "yaml":
      return buildYamlConversion(input.attachment);
    case "csv":
      return buildCsvConversion(input.attachment);
    case "html":
      return buildHtmlConversion(input.attachment);
    case "xml":
      return buildXmlConversion(input.attachment);
    case "svg":
      return buildSvgConversion(input.attachment);
    case "rtf":
      return buildRtfConversion(input.attachment);
    case "pdf":
      return (
        (await tryLayoutPreservingDocumentConversion(
          input.attachment,
          input.target,
          input.sourceBuffer,
        )) ?? buildPdfConversion(input.attachment)
      );
    case "docx":
      return (
        (await tryLayoutPreservingDocumentConversion(
          input.attachment,
          input.target,
          input.sourceBuffer,
        )) ?? buildDocxConversion(input.attachment)
      );
    case "xlsx":
      return (
        (await tryLayoutPreservingDocumentConversion(
          input.attachment,
          input.target,
          input.sourceBuffer,
        )) ?? buildXlsxConversion(input.attachment)
      );
    case "png":
    case "jpg":
    case "webp":
      return convertImageFormat(input.attachment, input.target, input.sourceBuffer);
    case "dwg":
    case "dxf":
      return convertPdfToCad(input.attachment, input.target, input.sourceBuffer);
    default:
      throw new FileConversionError(
        "unsupported_target",
        "This conversion target is not supported.",
        400,
      );
  }
}

async function tryLayoutPreservingDocumentConversion(
  attachment: AttachmentForConversion,
  target: "pdf" | "docx" | "xlsx",
  sourceBuffer?: Buffer,
): Promise<ConvertedAttachment | null> {
  if (!sourceBuffer || sourceBuffer.length === 0) return null;

  const sourceExt = normalizedSourceExtension(attachment);
  if (sourceExt === target) {
    return {
      filename: withExtension(attachment.filename, target),
      mimeType: documentMimeType(target),
      buffer: sourceBuffer,
    };
  }

  const config = readOfficeConverterConfig();
  if (!config || !canConvertWithOfficeEngine(sourceExt, target)) return null;

  const tempDir = await mkdtemp(path.join(tmpdir(), "eve-layout-convert-"));
  try {
    const inputPath = documentSourceTempPath(tempDir, sourceExt);
    await writeFile(inputPath, sourceBuffer);
    await runExternalConverter(config.bin, [
      "--headless",
      "--convert-to",
      target,
      "--outdir",
      tempDir,
      inputPath,
    ]);
    const outputPath = await findConvertedOutput(tempDir, target);
    if (!outputPath) {
      throw new FileConversionError(
        "converter_failed",
        "The layout-preserving converter ran but produced no output file.",
        500,
      );
    }
    return {
      filename: withExtension(attachment.filename, target),
      mimeType: documentMimeType(target),
      buffer: await readFile(outputPath),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function convertImageFormat(
  attachment: AttachmentForConversion,
  target: "png" | "jpg" | "webp",
  sourceBuffer?: Buffer,
): Promise<ConvertedAttachment> {
  if (!isImageAttachment(attachment)) {
    throw new FileConversionError(
      "unsupported_source",
      "Image conversion supports only image sources.",
      415,
    );
  }
  if (!sourceBuffer || sourceBuffer.length === 0) {
    throw new FileConversionError(
      "missing_source",
      "Image conversion requires the original file.",
      422,
    );
  }

  const sourceFormat = inferImageFormat(attachment);
  if (sourceFormat === target || (sourceFormat === "jpeg" && target === "jpg")) {
    return {
      filename: withExtension(attachment.filename, target),
      mimeType: imageMimeType(target),
      buffer: sourceBuffer,
    };
  }

  const config = readImageConverterConfig(target);
  if (!config) {
    throw new FileConversionError(
      "converter_unavailable",
      [
        `${sourceFormat?.toUpperCase() ?? "IMAGE"} → ${target.toUpperCase()} image converter is not connected on the server yet.`,
        `Install a converter like ImageMagick and set EVE_IMAGE_CONVERTER_BIN or EVE_IMAGE_TO_${target.toUpperCase()}_BIN to enable real re-encoding.`,
      ].join(" "),
      501,
    );
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "eve-image-convert-"));
  try {
    const inputPath = imageSourceTempPath(tempDir, sourceFormat);
    const outputPath = imageOutputTempPath(tempDir, target);
    await writeFile(inputPath, sourceBuffer);
    const args = config.args.map((arg) =>
      arg.replaceAll("{input}", inputPath).replaceAll("{output}", outputPath),
    );
    await runExternalConverter(config.bin, args);
    const buffer = await readFile(outputPath);
    return {
      filename: withExtension(attachment.filename, target),
      mimeType: imageMimeType(target),
      buffer,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function convertPdfToCad(
  attachment: AttachmentForConversion,
  target: "dwg" | "dxf",
  sourceBuffer?: Buffer,
): Promise<ConvertedAttachment> {
  if (!isPdfAttachment(attachment)) {
    throw new FileConversionError(
      "unsupported_source",
      "CAD conversion currently supports PDF sources only.",
      415,
    );
  }
  if (!sourceBuffer || sourceBuffer.length === 0) {
    throw new FileConversionError(
      "missing_source",
      "CAD conversion requires the original PDF file.",
      422,
    );
  }

  const config = readExternalConverterConfig(target);
  const dxfToDwgConfig = target === "dwg" ? readDxfToDwgConverterConfig() : null;
  const dxfConfig = target === "dwg" ? readExternalConverterConfig("dxf") : null;
  if (!config && !(target === "dwg" && dxfConfig && dxfToDwgConfig)) {
    throw new FileConversionError(
      "converter_unavailable",
      [
        `PDF → ${target.toUpperCase()} converter is not connected on the server yet.`,
        target === "dwg"
          ? "Set EVE_PDF_TO_DWG_BIN, or install ODA File Converter and set EVE_DXF_TO_DWG_BIN to run the PDF → DXF → DWG pipeline."
          : "Set EVE_PDF_TO_DXF_BIN to make this button produce a real DXF file.",
      ].join(" "),
      501,
    );
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "eve-file-convert-"));
  try {
    const inputPath = tempPathWithin(tempDir, "source.pdf");
    const outputPath = cadOutputTempPath(tempDir, target);
    await writeFile(inputPath, sourceBuffer);
    if (config) {
      const args = config.args.map((arg) =>
        arg.replaceAll("{input}", inputPath).replaceAll("{output}", outputPath),
      );
      await runExternalConverter(config.bin, args);
    } else if (dxfConfig && dxfToDwgConfig) {
      const dxfPath = tempPathWithin(tempDir, "intermediate.dxf");
      const dxfArgs = dxfConfig.args.map((arg) =>
        arg.replaceAll("{input}", inputPath).replaceAll("{output}", dxfPath),
      );
      await runExternalConverter(dxfConfig.bin, dxfArgs);
      await runDxfToDwgConverter(dxfToDwgConfig, dxfPath, outputPath, tempDir);
    }
    const buffer = await readFile(outputPath);
    return {
      filename: withExtension(attachment.filename, target),
      mimeType: target === "dwg" ? "image/vnd.dwg" : "image/vnd.dxf",
      buffer,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function readExternalConverterConfig(
  target: "dwg" | "dxf",
): { bin: string; args: string[] } | null {
  const suffix = target.toUpperCase();
  const envConfig = readTemplateConverterConfig(
    `EVE_PDF_TO_${suffix}_BIN`,
    `EVE_PDF_TO_${suffix}_ARGS`,
    ["{input}", "{output}"],
  );
  if (envConfig) return envConfig;
  if (converterAutodetectDisabled()) return null;
  if (target === "dxf") {
    const pstoedit = findExecutable(["pstoedit"]);
    if (pstoedit) return { bin: pstoedit, args: ["-f", "dxf", "{input}", "{output}"] };
  }
  return null;
}

type DxfToDwgConverterConfig =
  | { mode: "template"; bin: string; args: string[] }
  | { mode: "oda"; bin: string };

function readDwgReadinessConfig(): { bin: string } | null {
  const direct = readExternalConverterConfig("dwg");
  if (direct) return { bin: direct.bin };
  const dxf = readExternalConverterConfig("dxf");
  const dxfToDwg = readDxfToDwgConverterConfig();
  return dxf && dxfToDwg ? { bin: dxfToDwg.bin } : null;
}

function readDxfToDwgConverterConfig(): DxfToDwgConverterConfig | null {
  const envConfig = readTemplateConverterConfig("EVE_DXF_TO_DWG_BIN", "EVE_DXF_TO_DWG_ARGS", [
    "{input}",
    "{output}",
  ]);
  if (envConfig) return { mode: "template", ...envConfig };
  if (converterAutodetectDisabled()) return null;
  const oda = findExecutable([
    "ODAFileConverter",
    "/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter",
    "/Applications/ODA File Converter.app/Contents/MacOS/ODAFileConverter",
  ]);
  return oda ? { mode: "oda", bin: oda } : null;
}

async function runDxfToDwgConverter(
  config: DxfToDwgConverterConfig,
  inputPath: string,
  outputPath: string,
  tempDir: string,
): Promise<void> {
  if (config.mode === "template") {
    const args = config.args.map((arg) =>
      arg.replaceAll("{input}", inputPath).replaceAll("{output}", outputPath),
    );
    await runExternalConverter(config.bin, args);
    return;
  }

  const inputDir = tempPathWithin(tempDir, "oda-input");
  const outputDir = tempPathWithin(tempDir, "oda-output");
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await copyFile(inputPath, tempPathWithin(inputDir, "converted.dxf"));
  await runExternalConverter(config.bin, [inputDir, outputDir, "ACAD2018", "DWG", "0", "1"]);
  const dwgPath = await findConvertedOutput(outputDir, "dwg");
  if (!dwgPath) {
    throw new FileConversionError(
      "converter_failed",
      "The DXF → DWG post-processor ran but produced no DWG output.",
      500,
    );
  }
  await copyFile(dwgPath, outputPath);
}

function readImageConverterConfig(target: "png" | "jpg" | "webp"): {
  bin: string;
  args: string[];
} | null {
  const suffix = target.toUpperCase();
  return (
    readTemplateConverterConfig(`EVE_IMAGE_TO_${suffix}_BIN`, `EVE_IMAGE_TO_${suffix}_ARGS`, [
      "{input}",
      "{output}",
    ]) ??
    readTemplateConverterConfig("EVE_IMAGE_CONVERTER_BIN", "EVE_IMAGE_CONVERTER_ARGS", [
      "{input}",
      "{output}",
    ]) ??
    (converterAutodetectDisabled()
      ? null
      : (() => {
          const magick = findExecutable([
            "magick",
            "/opt/homebrew/bin/magick",
            "/usr/local/bin/magick",
          ]);
          return magick ? { bin: magick, args: ["{input}", "{output}"] } : null;
        })())
  );
}

function readOfficeConverterConfig(): { bin: string } | null {
  const envBin =
    process.env.EVE_LIBREOFFICE_BIN?.trim() || process.env.EVE_OFFICE_CONVERTER_BIN?.trim();
  if (envBin) return { bin: envBin };
  if (converterAutodetectDisabled()) return null;
  const bin = findExecutable([
    "soffice",
    "libreoffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
  ]);
  return bin ? { bin } : null;
}

function readTemplateConverterConfig(
  binEnv: string,
  argsEnv: string,
  defaultArgs: string[],
): { bin: string; args: string[] } | null {
  const bin = process.env[binEnv]?.trim();
  if (!bin) return null;
  const rawArgs = process.env[argsEnv]?.trim();
  if (!rawArgs) return { bin, args: defaultArgs };
  try {
    const parsed = JSON.parse(rawArgs);
    if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string")) {
      throw new Error("args must be a JSON string array");
    }
    return { bin, args: parsed };
  } catch (err) {
    throw new FileConversionError(
      "converter_misconfigured",
      err instanceof Error ? err.message : "Converter arguments are misconfigured.",
      500,
    );
  }
}

function engineSource(envNames: string[], available: boolean): "env" | "auto" | "missing" {
  if (envNames.some((name) => !!process.env[name]?.trim())) return "env";
  return available ? "auto" : "missing";
}

function runExternalConverter(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, windowsHide: true });
    let stderr = "";
    const timeoutMs = converterTimeoutMs();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new FileConversionError(
          "converter_timeout",
          `The converter did not finish within ${Math.round(timeoutMs / 1000)} seconds.`,
          504,
        ),
      );
    }, timeoutMs);
    child.stdout?.resume();
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new FileConversionError("converter_failed", err.message, 500));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new FileConversionError(
          "converter_failed",
          (stderr || `The converter exited with code ${code}.`).slice(0, 700),
          500,
        ),
      );
    });
  });
}

async function findConvertedOutput(tempDir: string, target: string): Promise<string | null> {
  const files = await readdir(tempDir);
  const match = files.find((file) => file.toLowerCase().endsWith(`.${target}`));
  return match ? path.join(tempDir, match) : null;
}

function canConvertWithOfficeEngine(sourceExt: string, target: "pdf" | "docx" | "xlsx"): boolean {
  if (target === "pdf") {
    return /^(doc|docx|odt|rtf|txt|md|html|htm|xls|xlsx|ods|csv|tsv|ppt|pptx|odp)$/i.test(
      sourceExt,
    );
  }
  if (target === "docx") {
    return /^(doc|odt|rtf|txt|md|html|htm)$/i.test(sourceExt);
  }
  return /^(xls|ods|csv|tsv)$/i.test(sourceExt);
}

function documentMimeType(target: "pdf" | "docx" | "xlsx"): string {
  if (target === "pdf") return "application/pdf";
  if (target === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

function normalizedSourceExtension(attachment: AttachmentForConversion): string {
  const ext = sourceExtension(attachment).toLowerCase();
  if (ext === "jpeg") return "jpg";
  if (ext === "htm") return "html";
  return ext;
}

function findExecutable(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate.includes("/") && existsSync(candidate)) return candidate;
  }
  const paths = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/")) continue;
    for (const dir of paths) {
      const fullPath = path.join(dir, candidate);
      if (existsSync(fullPath)) return fullPath;
    }
  }
  return null;
}

function converterTimeoutMs(): number {
  const value = Number(process.env.EVE_CONVERTER_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1000 ? value : 60_000;
}

function converterAutodetectDisabled(): boolean {
  return process.env.EVE_DISABLE_CONVERTER_AUTODETECT === "1";
}

function isPdfAttachment(attachment: AttachmentForConversion): boolean {
  return (
    attachment.mimeType.toLowerCase().includes("pdf") ||
    attachment.filename.toLowerCase().endsWith(".pdf")
  );
}

function isRasterTarget(target: AttachmentConversionTarget): target is "png" | "jpg" | "webp" {
  return target === "png" || target === "jpg" || target === "webp";
}

function isImageAttachment(attachment: AttachmentForConversion): boolean {
  const lower = attachment.filename.toLowerCase();
  return (
    attachment.mimeType.toLowerCase().startsWith("image/") ||
    /\.(png|jpg|jpeg|webp|gif|heic|svg)$/i.test(lower)
  );
}

function inferImageFormat(attachment: AttachmentForConversion): string | null {
  const mime = attachment.mimeType.toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpeg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("svg")) return "svg";
  if (mime.includes("heic")) return "heic";
  const ext = sourceExtension(attachment);
  if (ext === "jpg") return "jpeg";
  return ext;
}

function sourceExtension(attachment: AttachmentForConversion): string {
  const lower = attachment.filename.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return ext || "bin";
}

function documentSourceTempPath(baseDir: string, extension: string): string {
  switch (extension) {
    case "csv":
      return tempPathWithin(baseDir, "source.csv");
    case "doc":
      return tempPathWithin(baseDir, "source.doc");
    case "docx":
      return tempPathWithin(baseDir, "source.docx");
    case "html":
      return tempPathWithin(baseDir, "source.html");
    case "md":
      return tempPathWithin(baseDir, "source.md");
    case "ods":
      return tempPathWithin(baseDir, "source.ods");
    case "odt":
      return tempPathWithin(baseDir, "source.odt");
    case "pdf":
      return tempPathWithin(baseDir, "source.pdf");
    case "rtf":
      return tempPathWithin(baseDir, "source.rtf");
    case "tsv":
      return tempPathWithin(baseDir, "source.tsv");
    case "txt":
      return tempPathWithin(baseDir, "source.txt");
    case "xls":
      return tempPathWithin(baseDir, "source.xls");
    case "xlsx":
      return tempPathWithin(baseDir, "source.xlsx");
    default:
      return tempPathWithin(baseDir, "source.bin");
  }
}

function imageSourceTempPath(baseDir: string, format: string | null): string {
  switch (format) {
    case "gif":
      return tempPathWithin(baseDir, "source.gif");
    case "heic":
      return tempPathWithin(baseDir, "source.heic");
    case "jpeg":
      return tempPathWithin(baseDir, "source.jpg");
    case "png":
      return tempPathWithin(baseDir, "source.png");
    case "svg":
      return tempPathWithin(baseDir, "source.svg");
    case "webp":
      return tempPathWithin(baseDir, "source.webp");
    default:
      return tempPathWithin(baseDir, "source.bin");
  }
}

function imageOutputTempPath(baseDir: string, target: "png" | "jpg" | "webp"): string {
  switch (target) {
    case "jpg":
      return tempPathWithin(baseDir, "converted.jpg");
    case "png":
      return tempPathWithin(baseDir, "converted.png");
    case "webp":
      return tempPathWithin(baseDir, "converted.webp");
  }
}

function cadOutputTempPath(baseDir: string, target: "dwg" | "dxf"): string {
  return target === "dwg"
    ? tempPathWithin(baseDir, "converted.dwg")
    : tempPathWithin(baseDir, "converted.dxf");
}

function tempPathWithin(baseDir: string, child: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, child);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("Unsafe conversion temp path");
  }
  return resolved;
}

function imageMimeType(target: "png" | "jpg" | "webp"): string {
  if (target === "jpg") return "image/jpeg";
  return `image/${target}`;
}

export function withExtension(filename: string, extension: string): string {
  const base = path.basename(filename || "attachment").replace(/[\\/:*?"<>|]+/g, "_");
  const withoutExt = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  return `${withoutExt || "attachment"}.${extension}`;
}

function builtinDescription(target: AttachmentConversionTarget): string {
  switch (target) {
    case "txt":
      return "Saves the extracted text only.";
    case "md":
      return "Saves the summary, fields, and body as a Markdown report.";
    case "json":
      return "Saves the analysis result and extracted text as JSON.";
    case "yaml":
      return "Saves the analysis result and extracted text as YAML.";
    case "csv":
      return "Saves file metadata and extracted fields as a CSV table.";
    case "html":
      return "Saves a browser-viewable HTML report.";
    case "xml":
      return "Saves an integration-ready XML document.";
    case "svg":
      return "Saves the summary report as an SVG image.";
    case "rtf":
      return "Saves as a rich text document.";
    case "pdf":
      return "Saves the extracted content as a simple PDF report.";
    case "docx":
      return "Saves the extracted content as a Word document.";
    case "xlsx":
      return "Saves extracted fields and summary as an Excel document.";
    case "png":
      return "Converts the image to PNG.";
    case "jpg":
      return "Converts the image to JPG.";
    case "webp":
      return "Converts the image to WEBP.";
    default:
      return "Requires an external conversion engine.";
  }
}
