import { inflateRawSync } from "node:zlib";

const MAX_EXTRACTABLE_BYTES = 8_000_000;
// Aggregate caps across ALL entries in one archive: the per-entry inflate cap
// above is defeated by a ZIP with many entries (each ≤8MB but summing to GBs),
// so a multi-entry archive could still OOM the dyno. Bail once cumulative
// output or entry count crosses these.
const MAX_TOTAL_EXTRACTABLE_BYTES = 32_000_000;
const MAX_ZIP_ENTRIES = 512;

/**
 * Raw-inflate with a hard output cap. A crafted deflate stream (a few KB that
 * expands to gigabytes — a "zip bomb") would otherwise allocate unbounded and
 * OOM-kill the process; the only prior guard checked the COMPRESSED input size,
 * which a bomb passes trivially. maxOutputLength makes Node throw a RangeError
 * once output exceeds the extraction budget; every caller runs inside a
 * try/catch that falls back to metadata, so a bomb degrades to "unreadable"
 * instead of taking the dyno down. Text extraction never needs >8MB anyway.
 */
export function inflateRawCapped(input: Buffer): Buffer {
  return inflateRawSync(input, { maxOutputLength: MAX_EXTRACTABLE_BYTES });
}

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
    mimeType.includes("spreadsheetml") ||
    mimeType.includes("presentationml") ||
    mimeType.includes("msword") ||
    mimeType.includes("ms-excel") ||
    mimeType.includes("powerpoint") ||
    mimeType.includes("haansoft") ||
    mimeType.includes("hwp") ||
    mimeType.startsWith("image/") ||
    /\.(txt|md|csv|json|xml|html|htm|pdf|docx|doc|xlsx|xls|pptx|ppt|hwpx|hwp|jpg|jpeg|png|webp|heic)$/i.test(
      lower,
    )
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

  if (isXlsx(lower, mimeType)) {
    const text = extractXlsxText(buffer);
    return {
      text: text || metadataText(filename, mimeType, buffer.length, "XLSX 텍스트 추출 실패"),
      status: text ? "readable" : "metadata",
    };
  }

  if (isPptx(lower, mimeType)) {
    const text = extractPptxText(buffer);
    return {
      text: text || metadataText(filename, mimeType, buffer.length, "PPTX 텍스트 추출 실패"),
      status: text ? "readable" : "metadata",
    };
  }

  if (isHwpx(lower, mimeType)) {
    const text = extractHwpxText(buffer);
    return {
      text: text || metadataText(filename, mimeType, buffer.length, "HWPX 텍스트 추출 실패"),
      status: text ? "readable" : "metadata",
    };
  }

  if (isLegacyHwp(lower, mimeType)) {
    const text = extractLegacyHwpText(buffer);
    return {
      text: text || metadataText(filename, mimeType, buffer.length, "구형 HWP 본문 자동 추출 제한"),
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

function isXlsx(filename: string, mimeType: string): boolean {
  return (
    filename.endsWith(".xlsx") ||
    mimeType.includes("spreadsheetml") ||
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
}

function isPptx(filename: string, mimeType: string): boolean {
  return (
    filename.endsWith(".pptx") ||
    mimeType.includes("presentationml") ||
    mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );
}

function isHwpx(filename: string, mimeType: string): boolean {
  return (
    filename.endsWith(".hwpx") ||
    mimeType.includes("hwpx") ||
    mimeType === "application/haansofthwpx" ||
    mimeType === "application/vnd.hancom.hwpx"
  );
}

function isLegacyHwp(filename: string, mimeType: string): boolean {
  return (
    filename.endsWith(".hwp") ||
    mimeType.includes("x-hwp") ||
    mimeType === "application/haansofthwp" ||
    mimeType === "application/hwp"
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

function extractXlsxText(buffer: Buffer): string | null {
  try {
    const entries = readZipEntries(buffer);
    const sharedStrings = Array.from(entries.entries())
      .filter(([name]) => /^xl\/sharedStrings\.xml$/i.test(name))
      .flatMap(([, entry]) => extractXmlText(entry.toString("utf-8")));
    const worksheetText = Array.from(entries.entries())
      .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
      .flatMap(([, entry]) => extractXmlText(entry.toString("utf-8")));
    return uniqueLines([...sharedStrings, ...worksheetText]).join("\n") || null;
  } catch {
    return null;
  }
}

function extractPptxText(buffer: Buffer): string | null {
  try {
    const entries = readZipEntries(buffer);
    const text = Array.from(entries.entries())
      .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .flatMap(([, entry]) => extractXmlText(entry.toString("utf-8")));
    return uniqueLines(text).join("\n") || null;
  } catch {
    return null;
  }
}

function extractHwpxText(buffer: Buffer): string | null {
  try {
    const entries = readZipEntries(buffer);
    const sectionText = Array.from(entries.entries())
      .filter(([name]) => /^(?:contents|content)\/section\d+\.xml$/i.test(name))
      .flatMap(([, entry]) => extractHwpxXmlText(entry.toString("utf-8")));
    if (sectionText.length > 0) return uniqueLines(sectionText).join("\n") || null;

    const xmlText = Array.from(entries.entries())
      .filter(([name]) => name.toLowerCase().endsWith(".xml"))
      .filter(([name]) => !/(?:settings|version|manifest|header|meta|preview)\.xml$/i.test(name))
      .flatMap(([, entry]) => extractHwpxXmlText(entry.toString("utf-8")));
    return uniqueLines(xmlText).join("\n") || null;
  } catch {
    return null;
  }
}

function extractLegacyHwpText(buffer: Buffer): string | null {
  const chunks = [
    ...extractUtf16TextChunks(buffer),
    ...extractInflatedTextChunks(buffer),
    ...extractAsciiKoreanTextChunks(buffer),
  ];
  return uniqueLines(chunks).join("\n") || null;
}

function extractUtf16TextChunks(buffer: Buffer): string[] {
  const chunks: string[] = [];
  for (const offset of [0, 1]) {
    let current = "";
    for (let i = offset; i + 1 < buffer.length; i += 2) {
      const code = buffer.readUInt16LE(i);
      if (isReadableTextCode(code)) {
        current += String.fromCharCode(code);
      } else {
        pushReadableChunk(chunks, current);
        current = "";
      }
    }
    pushReadableChunk(chunks, current);
  }
  return chunks;
}

function extractInflatedTextChunks(buffer: Buffer): string[] {
  const chunks: string[] = [];
  const maxOffset = Math.min(buffer.length - 16, 1_000_000);
  for (let offset = 0; offset < maxOffset; offset += 64) {
    try {
      const inflated = inflateRawCapped(buffer.subarray(offset));
      if (inflated.length < 16) continue;
      chunks.push(...extractUtf16TextChunks(inflated), ...extractAsciiKoreanTextChunks(inflated));
      if (chunks.length >= 80) break;
    } catch {
      // Most offsets are not deflate streams. Keep scanning sparsely.
    }
  }
  return chunks;
}

function extractAsciiKoreanTextChunks(buffer: Buffer): string[] {
  const text = buffer.toString("utf-8");
  return (
    text
      .match(/[A-Za-z0-9가-힣@._+\-:/()[\], ]{8,}/g)
      ?.map((segment) => segment.replace(/\s+/g, " ").trim())
      .filter((segment) => /[가-힣A-Za-z0-9]/.test(segment))
      .slice(0, 120) ?? []
  );
}

function isReadableTextCode(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    code === 0x20 ||
    (code >= 0x21 && code <= 0x7e) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0x3130 && code <= 0x318f) ||
    (code >= 0x1100 && code <= 0x11ff)
  );
}

function pushReadableChunk(chunks: string[], value: string): void {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length < 6) return;
  if (!/[가-힣A-Za-z0-9]/.test(cleaned)) return;
  chunks.push(cleaned);
}

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const centralEntries = readCentralDirectoryZipEntries(buffer);
  if (centralEntries.size > 0) return centralEntries;

  const entries = new Map<string, Buffer>();
  let offset = 0;
  let totalBytes = 0;

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
      const data =
        method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawCapped(compressed) : null;
      if (data) {
        entries.set(filename, data);
        totalBytes += data.length;
        if (totalBytes > MAX_TOTAL_EXTRACTABLE_BYTES || entries.size >= MAX_ZIP_ENTRIES) break;
      }
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
  let totalBytes = 0;
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
      totalBytes += localData.length;
      if (totalBytes > MAX_TOTAL_EXTRACTABLE_BYTES || entries.size >= MAX_ZIP_ENTRIES) break;
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
  if (method === 8) return inflateRawCapped(compressed);
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

function extractXmlText(xml: string): string[] {
  const chunks = Array.from(xml.matchAll(/<[^:>\s]*:?t\b[^>]*>([\s\S]*?)<\/[^:>\s]*:?t\b[^>]*>/gi))
    .map((match) => cleanText(decodeXml(match[1])))
    .filter((value): value is string => !!value);
  if (chunks.length > 0) return chunks;
  const fallback = cleanText(decodeXml(xml.replace(/<[^>]+>/g, " ")));
  return fallback ? [fallback] : [];
}

function extractHwpxXmlText(xml: string): string[] {
  const withBreaks = xml
    .replace(/<[^:>]*:?tab\b[^>]*\/>/g, "\t")
    .replace(/<[^:>]*:?lineBreak\b[^>]*\/>/g, "\n")
    .replace(/<[^:>]*:?br\b[^>]*\/>/g, "\n")
    .replace(/<\/[^:>]*:?p>/g, "\n")
    .replace(/<\/[^:>]*:?tr>/g, "\n")
    .replace(/<\/[^:>]*:?tc>/g, "\t");

  const chunks = Array.from(
    withBreaks.matchAll(/<[^:>\s]*:?t\b[^>]*>([\s\S]*?)<\/[^:>\s]*:?t\b[^>]*>/gi),
  )
    .map((match) => cleanText(decodeXml(match[1])))
    .filter((value): value is string => !!value);
  if (chunks.length > 0) return chunks;

  const fallback = cleanText(decodeXml(withBreaks.replace(/<[^>]+>/g, " ")));
  return fallback ? fallback.split("\n") : [];
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const cleaned = line.replace(/\s+/g, " ").trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out.slice(0, 200);
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
