import { describe, expect, it } from "vitest";
import {
  type AttachmentForConversion,
  convertEmailAttachment,
  createStoredZip,
  getFileConversionCapabilities,
  getFileConversionEngineStatus,
  normalizeConversionTarget,
  requiresOriginalAttachment,
  runFileConversionQualitySuite,
} from "../mail/file-conversions.js";

describe("file conversions", () => {
  it("normalizes supported conversion targets", () => {
    expect(normalizeConversionTarget("DWG")).toBe("dwg");
    expect(normalizeConversionTarget("yaml")).toBe("yaml");
    expect(normalizeConversionTarget("SVG")).toBe("svg");
    expect(normalizeConversionTarget("WEBP")).toBe("webp");
    expect(normalizeConversionTarget(" txt ")).toBe("txt");
    expect(normalizeConversionTarget("exe")).toBeNull();
    expect(requiresOriginalAttachment("dwg")).toBe(true);
    expect(requiresOriginalAttachment("png")).toBe(true);
    expect(requiresOriginalAttachment("json")).toBe(false);
  });

  it("converts extracted attachment text to txt", async () => {
    const converted = await convertEmailAttachment({
      target: "txt",
      attachment: attachment({ contentText: "이름: 김하나\n키: 168cm" }),
    });

    expect(converted.filename).toBe("profile.txt");
    expect(converted.mimeType).toContain("text/plain");
    expect(converted.buffer.toString("utf-8")).toContain("김하나");
  });

  it("converts attachment analysis to json", async () => {
    const converted = await convertEmailAttachment({
      target: "json",
      attachment: attachment({
        summary: "배우 프로필",
        extractedFields: { name: "김하나", role: "배우" },
      }),
    });
    const payload = JSON.parse(converted.buffer.toString("utf-8")) as {
      summary: string;
      extractedFields: Record<string, string>;
    };

    expect(converted.filename).toBe("profile.json");
    expect(payload.summary).toBe("배우 프로필");
    expect(payload.extractedFields.name).toBe("김하나");
  });

  it("converts attachment analysis to csv/html/xml document formats", async () => {
    const source = attachment({
      contentText: "지원 내용",
      summary: "배우 프로필",
      extractedFields: { name: "김하나", role: "배우" },
    });

    const csv = await convertEmailAttachment({ target: "csv", attachment: source });
    const yaml = await convertEmailAttachment({ target: "yaml", attachment: source });
    const html = await convertEmailAttachment({ target: "html", attachment: source });
    const xml = await convertEmailAttachment({ target: "xml", attachment: source });
    const svg = await convertEmailAttachment({ target: "svg", attachment: source });

    expect(csv.filename).toBe("profile.csv");
    expect(csv.buffer.toString("utf-8")).toContain('"extracted.name","김하나"');
    expect(yaml.filename).toBe("profile.yaml");
    expect(yaml.buffer.toString("utf-8")).toContain('filename: "profile.pdf"');
    expect(html.filename).toBe("profile.html");
    expect(html.buffer.toString("utf-8")).toContain("<!doctype html>");
    expect(xml.filename).toBe("profile.xml");
    expect(xml.buffer.toString("utf-8")).toContain("<attachment>");
    expect(svg.filename).toBe("profile.svg");
    expect(svg.buffer.toString("utf-8")).toContain("<svg");
  });

  it("creates binary pdf/docx/xlsx outputs from extracted content", async () => {
    const source = attachment({
      contentText: "Name: Hana Kim\nRole: Actor",
      summary: "Actor profile",
      extractedFields: { name: "Hana Kim", role: "Actor" },
    });

    const pdf = await convertEmailAttachment({ target: "pdf", attachment: source });
    const docx = await convertEmailAttachment({ target: "docx", attachment: source });
    const xlsx = await convertEmailAttachment({ target: "xlsx", attachment: source });

    expect(pdf.buffer.subarray(0, 5).toString("utf-8")).toBe("%PDF-");
    expect(docx.buffer.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(xlsx.buffer.subarray(0, 4).toString("hex")).toBe("504b0304");
  });

  it("preserves original document bytes when converting to the same document format", async () => {
    const source = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x12, 0x34]);
    const converted = await convertEmailAttachment({
      target: "docx",
      sourceBuffer: source,
      attachment: attachment({
        filename: "resume.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    });

    expect(converted.filename).toBe("resume.docx");
    expect(converted.buffer).toEqual(source);
  });

  it("passes through same-format image conversions without an external engine", async () => {
    const source = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const converted = await convertEmailAttachment({
      target: "png",
      sourceBuffer: source,
      attachment: attachment({
        filename: "headshot.png",
        mimeType: "image/png",
        contentText: "이미지 파일",
      }),
    });

    expect(converted.filename).toBe("headshot.png");
    expect(converted.mimeType).toBe("image/png");
    expect(converted.buffer).toEqual(source);
  });

  it("returns a clear unavailable error for image re-encoding without a configured converter", async () => {
    const previous = process.env.EVE_DISABLE_CONVERTER_AUTODETECT;
    process.env.EVE_DISABLE_CONVERTER_AUTODETECT = "1";
    try {
      await expect(
        convertEmailAttachment({
          target: "webp",
          sourceBuffer: Buffer.from([0xff, 0xd8, 0xff]),
          attachment: attachment({ filename: "headshot.jpg", mimeType: "image/jpeg" }),
        }),
      ).rejects.toMatchObject({
        code: "converter_unavailable",
        statusCode: 501,
      });
    } finally {
      if (previous === undefined) delete process.env.EVE_DISABLE_CONVERTER_AUTODETECT;
      else process.env.EVE_DISABLE_CONVERTER_AUTODETECT = previous;
    }
  });

  it("returns a clear unavailable error for pdf to dwg without a configured converter", async () => {
    await expect(
      convertEmailAttachment({
        target: "dwg",
        sourceBuffer: Buffer.from("%PDF-1.7"),
        attachment: attachment({ filename: "floor-plan.pdf", mimeType: "application/pdf" }),
      }),
    ).rejects.toMatchObject({
      code: "converter_unavailable",
      statusCode: 501,
    });
  });

  it("reports built-in and external conversion capabilities", () => {
    const capabilities = getFileConversionCapabilities();

    expect(capabilities.find((item) => item.target === "docx")).toMatchObject({
      mode: "builtin",
      available: true,
    });
    expect(capabilities.find((item) => item.target === "dwg")).toMatchObject({
      mode: "external",
    });
    expect(capabilities.find((item) => item.target === "webp")).toMatchObject({
      mode: "external",
    });
  });

  it("reports conversion engine readiness", () => {
    const engines = getFileConversionEngineStatus();

    expect(engines.map((engine) => engine.id)).toEqual([
      "office-layout",
      "image-raster",
      "cad-dwg",
      "cad-dxf",
    ]);
    expect(engines.find((engine) => engine.id === "office-layout")?.targets).toContain("pdf");
    expect(engines.find((engine) => engine.id === "cad-dwg")?.setupHint).toContain(
      "EVE_PDF_TO_DWG_BIN",
    );
  });

  it("runs the conversion quality test suite", async () => {
    const previous = process.env.EVE_DISABLE_CONVERTER_AUTODETECT;
    process.env.EVE_DISABLE_CONVERTER_AUTODETECT = "1";
    try {
      const report = await runFileConversionQualitySuite();

      expect(report.scenarios.length).toBeGreaterThanOrEqual(20);
      expect(report.scenarios.find((item) => item.id === "builtin-json")).toMatchObject({
        status: "pass",
      });
      expect(report.score).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.EVE_DISABLE_CONVERTER_AUTODETECT;
      else process.env.EVE_DISABLE_CONVERTER_AUTODETECT = previous;
    }
  });

  it("creates a zip archive for batched conversion downloads", () => {
    const zip = createStoredZip([
      { name: "one.txt", data: Buffer.from("one") },
      { name: "two.txt", data: Buffer.from("two") },
    ]);

    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(zip.toString("latin1")).toContain("one.txt");
    expect(zip.toString("latin1")).toContain("two.txt");
  });
});

function attachment(overrides: Partial<AttachmentForConversion> = {}): AttachmentForConversion {
  return {
    id: "att-1",
    filename: "profile.pdf",
    mimeType: "application/pdf",
    size: 1000,
    contentText: null,
    summary: null,
    keyPoints: [],
    extractedFields: {},
    category: "profile",
    analysisStatus: "ANALYZED",
    analysisError: null,
    ...overrides,
  };
}
