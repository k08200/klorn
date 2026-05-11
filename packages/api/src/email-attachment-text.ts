import { inflateRawSync } from "node:zlib";

const MAX_EXTRACTABLE_BYTES = 8_000_000;

export interface ExtractedAttachmentContent {
  text: string | null;
  status: "readable" | "metadata" | "unsupported";
}

export function isReadableEmailAttachment(
  filename: string,
  mimeType: string,
  size?: number | null,
): boolean {
  if (size && size > MAX_EXTRACTABLE_BYTES) return false;
  const lower = filename.toLowerCase();
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("csv") ||
    mimeType.includes("xml") ||
    mimeType.includes("html") ||
    mimeType.includes("pdf") ||
    mimeType.includes("wordprocessingml") ||
    mimeType.includes("msword") ||
    mimeType.startsWith("image/") ||
    /\.(txt|md|csv|json|xml|html|htm|pdf|docx|doc|jpg|jpeg|png|webp|heic)$/i.test(lower)
  );
}

export function extractAttachmentContent(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): ExtractedAttachmentContent {
  const lower = filename.toLowerCase();

  if (isDocx(lower, mimeType)) {
    const text = extractDocxText(buffer);
    return {
      text: text || metadataText(filename, mimeType, buffer.length, "DOCX 텍스트 추출 실패"),
      status: text ? "readable" : "metadata",
    };
  }

  if (isPlainTextLike(lower, mimeType)) {
    return {
      text: cleanText(buffer.toString("utf-8")),
      status: "readable",
    };
  }

  if (mimeType.includes("pdf") || lower.endsWith(".pdf")) {
    const text = extractPdfTextHeuristic(buffer);
    return {
      text:
        text ||
        metadataText(filename, mimeType, buffer.length, "PDF 텍스트 레이어 없음 또는 추출 실패"),
      status: text ? "readable" : "metadata",
    };
  }

  if (mimeType.startsWith("image/") || /\.(jpg|jpeg|png|webp|heic)$/i.test(lower)) {
    return {
      text: metadataText(filename, mimeType, buffer.length, "이미지 파일 - OCR 분석 대기"),
      status: "metadata",
    };
  }

  return {
    text: metadataText(filename, mimeType, buffer.length, "본문 추출 미지원 파일"),
    status: "unsupported",
  };
}

function isPlainTextLike(filename: string, mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("csv") ||
    mimeType.includes("xml") ||
    mimeType.includes("html") ||
    /\.(txt|md|csv|json|xml|html|htm)$/i.test(filename)
  );
}

function isDocx(filename: string, mimeType: string): boolean {
  return (
    filename.endsWith(".docx") ||
    mimeType.includes("wordprocessingml") ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

function metadataText(filename: string, mimeType: string, size: number, reason: string): string {
  return [
    `파일명: ${filename}`,
    `MIME: ${mimeType || "application/octet-stream"}`,
    `크기: ${size} bytes`,
    `상태: ${reason}`,
  ].join("\n");
}

function cleanText(text: string): string | null {
  const cleaned = text.replaceAll(String.fromCharCode(0), "").replace(/\r\n/g, "\n").trim();
  return cleaned || null;
}

function extractDocxText(buffer: Buffer): string | null {
  try {
    const entries = readZipEntries(buffer);
    const xmlFiles = [
      "word/document.xml",
      ...Array.from(entries.keys()).filter((name) =>
        /^word\/(?:header|footer|footnotes|endnotes)\d*\.xml$/i.test(name),
      ),
    ];
    const text = xmlFiles
      .map((name) => entries.get(name))
      .filter((entry): entry is Buffer => !!entry)
      .map((entry) => extractWordXmlText(entry.toString("utf-8")))
      .filter(Boolean)
      .join("\n")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const centralEntries = readCentralDirectoryZipEntries(buffer);
  if (centralEntries.size > 0) return centralEntries;

  const entries = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;

    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const filename = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf-8");

    if ((flags & 0x08) !== 0 || compressedSize === 0) break;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) break;

    const compressed = buffer.subarray(dataStart, dataEnd);
    if (!filename.endsWith("/")) {
      if (method === 0) entries.set(filename, Buffer.from(compressed));
      if (method === 8) entries.set(filename, inflateRawSync(compressed));
    }

    offset = dataEnd;
  }

  return entries;
}

function readCentralDirectoryZipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) return entries;

  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralDirectoryEnd = Math.min(
    buffer.length,
    centralDirectoryOffset + centralDirectorySize,
  );

  let offset = centralDirectoryOffset;
  while (offset + 46 <= centralDirectoryEnd && buffer.readUInt32LE(offset) === 0x02014b50) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const filename = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf-8");

    const localData = readZipEntryFromLocalHeader(
      buffer,
      localHeaderOffset,
      compressedSize,
      method,
    );
    if (localData && !filename.endsWith("/")) {
      entries.set(filename, localData);
    }

    offset = nameStart + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function readZipEntryFromLocalHeader(
  buffer: Buffer,
  offset: number,
  compressedSize: number,
  method: number,
): Buffer | null {
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) return null;
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buffer.length) return null;

  const compressed = buffer.subarray(dataStart, dataEnd);
  if (method === 0) return Buffer.from(compressed);
  if (method === 8) return inflateRawSync(compressed);
  return null;
}

function extractWordXmlText(xml: string): string {
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, "\t");

  const chunks = Array.from(withBreaks.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)).map((match) =>
    decodeXml(match[1]),
  );
  const text = chunks.length > 0 ? chunks.join("") : withBreaks.replace(/<[^>]+>/g, " ");
  return (
    cleanText(
      decodeXml(text)
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n"),
    ) || ""
  );
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractPdfTextHeuristic(buffer: Buffer): string | null {
  const raw = buffer.toString("latin1");
  const literalStrings = Array.from(raw.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g))
    .map((match) =>
      match[1].replace(/\\([nrtbf()\\])/g, (_, ch: string) => {
        if (ch === "n" || ch === "r") return "\n";
        if (ch === "t") return "\t";
        if (ch === "b" || ch === "f") return "";
        return ch;
      }),
    )
    .filter((segment) => /[A-Za-z가-힣0-9]/.test(segment));

  const asciiSegments = raw.match(/[A-Za-z0-9가-힣@._+\-:/()[\], ]{18,}/g) ?? [];
  const text = [...literalStrings, ...asciiSegments]
    .map((segment) => segment.replace(/\s+/g, " ").trim())
    .filter((segment) => segment.length > 16 && !segment.includes(" obj"))
    .slice(0, 120)
    .join("\n");
  return cleanText(text);
}
