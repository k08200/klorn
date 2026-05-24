/**
 * Built-in file converters — generate plain TXT / Markdown / JSON / YAML / CSV /
 * HTML / XML / SVG / RTF / PDF / DOCX / XLSX reports from an `AttachmentForConversion`.
 *
 * Split out of file-conversions.ts. The 12 builders + their dedicated
 * encoding helpers (yaml, csv, html/xml escape, PDF generator, DOCX/XLSX
 * zip+xml writer with embedded CRC32 implementation) live here so the main
 * file-conversions.ts can focus on capability detection, quality scenarios,
 * and external converter dispatch.
 *
 * The split is purely structural — no behavior change. `withExtension`
 * stays in file-conversions.ts because it's shared with the external
 * converters; this module imports it back through the entry file.
 */

import {
  type AttachmentForConversion,
  type ConvertedAttachment,
  FileConversionError,
  withExtension,
} from "./file-conversions.js";

// ─── Builders ────────────────────────────────────────────────────────────

export function buildTextConversion(attachment: AttachmentForConversion): ConvertedAttachment {
  const text = attachment.contentText?.trim();
  if (!text) {
    throw new FileConversionError(
      "no_extracted_text",
      "This file has no extracted text yet. Run attachment analysis or OCR first.",
      422,
    );
  }
  return {
    filename: withExtension(attachment.filename, "txt"),
    mimeType: "text/plain; charset=utf-8",
    buffer: Buffer.from(text, "utf-8"),
  };
}

export function buildMarkdownConversion(attachment: AttachmentForConversion): ConvertedAttachment {
  const lines = [
    `# ${attachment.filename}`,
    "",
    `- MIME: ${attachment.mimeType || "unknown"}`,
    `- Size: ${attachment.size ?? "unknown"}`,
    `- Category: ${attachment.category ?? "unknown"}`,
    `- Status: ${attachment.analysisStatus}`,
    "",
  ];
  if (attachment.summary) lines.push("## Summary", "", attachment.summary, "");
  if (attachment.keyPoints.length > 0) {
    lines.push("## Key Points", "", ...attachment.keyPoints.map((point) => `- ${point}`), "");
  }
  if (Object.keys(attachment.extractedFields).length > 0) {
    lines.push("## Extracted Fields", "");
    for (const [key, value] of Object.entries(attachment.extractedFields)) {
      if (value !== null && value !== "") lines.push(`- ${key}: ${String(value)}`);
    }
    lines.push("");
  }
  if (attachment.contentText?.trim()) {
    lines.push("## Extracted Text", "", attachment.contentText.trim(), "");
  }
  if (attachment.analysisError) {
    lines.push("## Analysis Note", "", attachment.analysisError, "");
  }
  return {
    filename: withExtension(attachment.filename, "md"),
    mimeType: "text/markdown; charset=utf-8",
    buffer: Buffer.from(lines.join("\n"), "utf-8"),
  };
}

export function buildJsonConversion(attachment: AttachmentForConversion): ConvertedAttachment {
  const payload = {
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    summary: attachment.summary,
    keyPoints: attachment.keyPoints,
    extractedFields: attachment.extractedFields,
    category: attachment.category,
    analysisStatus: attachment.analysisStatus,
    analysisError: attachment.analysisError,
    contentText: attachment.contentText,
  };
  return {
    filename: withExtension(attachment.filename, "json"),
    mimeType: "application/json; charset=utf-8",
    buffer: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf-8"),
  };
}

export function buildYamlConversion(attachment: AttachmentForConversion): ConvertedAttachment {
  const fields = Object.entries(attachment.extractedFields)
    .filter(([, value]) => value !== null && value !== "")
    .map(([key, value]) => `  ${yamlKey(key)}: ${yamlScalar(String(value))}`)
    .join("\n");
  const yaml = [
    `id: ${yamlScalar(attachment.id)}`,
    `filename: ${yamlScalar(attachment.filename)}`,
    `mimeType: ${yamlScalar(attachment.mimeType)}`,
    `size: ${attachment.size ?? "null"}`,
    `category: ${attachment.category ? yamlScalar(attachment.category) : "null"}`,
    `analysisStatus: ${yamlScalar(attachment.analysisStatus)}`,
    `summary: ${attachment.summary ? yamlScalar(attachment.summary) : "null"}`,
    "keyPoints:",
    ...(attachment.keyPoints.length > 0
      ? attachment.keyPoints.map((point) => `  - ${yamlScalar(point)}`)
      : ["  []"]),
    "extractedFields:",
    fields || "  {}",
    `contentText: ${attachment.contentText?.trim() ? yamlBlock(attachment.contentText.trim()) : "null"}`,
  ].join("\n");
  return {
    filename: withExtension(attachment.filename, "yaml"),
    mimeType: "application/yaml; charset=utf-8",
    buffer: Buffer.from(`${yaml}\n`, "utf-8"),
  };
}

export function buildCsvConversion(attachment: AttachmentForConversion): ConvertedAttachment {
  const rows: string[][] = [
    ["field", "value"],
    ["filename", attachment.filename],
    ["mimeType", attachment.mimeType],
    ["size", attachment.size === null ? "" : String(attachment.size)],
    ["category", attachment.category ?? ""],
    ["analysisStatus", attachment.analysisStatus],
    ["summary", attachment.summary ?? ""],
  ];
  attachment.keyPoints.forEach((point, index) => {
    rows.push([`keyPoint.${index + 1}`, point]);
  });
  for (const [key, value] of Object.entries(attachment.extractedFields)) {
    rows.push([`extracted.${key}`, value === null ? "" : String(value)]);
  }
  if (attachment.contentText?.trim()) rows.push(["contentText", attachment.contentText.trim()]);
  if (attachment.analysisError) rows.push(["analysisError", attachment.analysisError]);

  return {
    filename: withExtension(attachment.filename, "csv"),
    mimeType: "text/csv; charset=utf-8",
    buffer: Buffer.from(
      `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`,
      "utf-8",
    ),
  };
}

export function buildHtmlConversion(attachment: AttachmentForConversion): ConvertedAttachment {
  const fieldRows = Object.entries(attachment.extractedFields)
    .filter(([, value]) => value !== null && value !== "")
    .map(
      ([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(String(value))}</td></tr>`,
    )
    .join("\n");
  const keyPoints = attachment.keyPoints.map((point) => `<li>${escapeHtml(point)}</li>`).join("\n");
  const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(attachment.filename)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #1c1917; line-height: 1.55; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .meta { color: #78716c; font-size: 13px; margin-bottom: 24px; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    th, td { border: 1px solid #e7e5e4; padding: 8px; text-align: left; vertical-align: top; }
    th { width: 180px; background: #f5f5f4; }
    pre { white-space: pre-wrap; background: #f5f5f4; padding: 16px; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(attachment.filename)}</h1>
  <p class="meta">${escapeHtml(attachment.mimeType)} · ${attachment.size ?? "unknown"} bytes · ${escapeHtml(attachment.analysisStatus)}</p>
  ${attachment.summary ? `<h2>Summary</h2><p>${escapeHtml(attachment.summary)}</p>` : ""}
  ${keyPoints ? `<h2>Key Points</h2><ul>${keyPoints}</ul>` : ""}
  ${fieldRows ? `<h2>Extracted Fields</h2><table>${fieldRows}</table>` : ""}
  ${attachment.contentText?.trim() ? `<h2>Extracted Text</h2><pre>${escapeHtml(attachment.contentText.trim())}</pre>` : ""}
</body>
</html>
`;
  return {
    filename: withExtension(attachment.filename, "html"),
    mimeType: "text/html; charset=utf-8",
    buffer: Buffer.from(html, "utf-8"),
  };
}

export function buildXmlConversion(attachment: AttachmentForConversion): ConvertedAttachment {
  const fields = Object.entries(attachment.extractedFields)
    .filter(([, value]) => value !== null && value !== "")
    .map(
      ([key, value]) => `    <field name="${escapeXml(key)}">${escapeXml(String(value))}</field>`,
    )
    .join("\n");
  const points = attachment.keyPoints
    .map((point) => `    <point>${escapeXml(point)}</point>`)
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<attachment>
  <filename>${escapeXml(attachment.filename)}</filename>
  <mimeType>${escapeXml(attachment.mimeType)}</mimeType>
  <size>${attachment.size ?? ""}</size>
  <category>${escapeXml(attachment.category ?? "")}</category>
  <analysisStatus>${escapeXml(attachment.analysisStatus)}</analysisStatus>
  <summary>${escapeXml(attachment.summary ?? "")}</summary>
  <keyPoints>
${points}
  </keyPoints>
  <extractedFields>
${fields}
  </extractedFields>
  <contentText>${escapeXml(attachment.contentText ?? "")}</contentText>
</attachment>
`;
  return {
    filename: withExtension(attachment.filename, "xml"),
    mimeType: "application/xml; charset=utf-8",
    buffer: Buffer.from(xml, "utf-8"),
  };
}

export function buildSvgConversion(attachment: AttachmentForConversion): ConvertedAttachment {
  const report = buildPlainReport(attachment);
  const lines = report.split(/\r?\n/).slice(0, 36);
  const width = 900;
  const height = Math.max(420, 88 + lines.length * 22);
  const text = lines
    .map(
      (line, index) =>
        `<text x="36" y="${74 + index * 22}" font-size="${index === 0 ? 22 : 14}" font-weight="${index === 0 ? 700 : 400}">${escapeXml(line.slice(0, 110))}</text>`,
    )
    .join("\n  ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <rect x="18" y="18" width="${width - 36}" height="${height - 36}" rx="14" fill="#ffffff" stroke="#cbd5e1"/>
  <text x="36" y="44" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12" fill="#64748b">EVE converted report</text>
  <g font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" fill="#0f172a">
  ${text}
  </g>
</svg>
`;
  return {
    filename: withExtension(attachment.filename, "svg"),
    mimeType: "image/svg+xml; charset=utf-8",
    buffer: Buffer.from(svg, "utf-8"),
  };
}

export function buildRtfConversion(attachment: AttachmentForConversion): ConvertedAttachment {
  const text = buildPlainReport(attachment);
  const body = text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .split(/\r?\n/)
    .map((line) => `${line}\\par`)
    .join("\n");
  return {
    filename: withExtension(attachment.filename, "rtf"),
    mimeType: "application/rtf",
    buffer: Buffer.from(`{\\rtf1\\ansi\\deff0\n${body}\n}`, "utf-8"),
  };
}

export function buildPdfConversion(attachment: AttachmentForConversion): ConvertedAttachment {
  return {
    filename: withExtension(attachment.filename, "pdf"),
    mimeType: "application/pdf",
    buffer: createSimplePdf(buildPlainReport(attachment)),
  };
}

export function buildDocxConversion(attachment: AttachmentForConversion): ConvertedAttachment {
  return {
    filename: withExtension(attachment.filename, "docx"),
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: createDocx(buildPlainReport(attachment)),
  };
}

export function buildXlsxConversion(attachment: AttachmentForConversion): ConvertedAttachment {
  const rows: string[][] = [
    ["Field", "Value"],
    ["Filename", attachment.filename],
    ["MIME", attachment.mimeType],
    ["Size", attachment.size === null ? "" : String(attachment.size)],
    ["Category", attachment.category ?? ""],
    ["Status", attachment.analysisStatus],
    ["Summary", attachment.summary ?? ""],
  ];
  attachment.keyPoints.forEach((point, index) => {
    rows.push([`Key Point ${index + 1}`, point]);
  });
  for (const [key, value] of Object.entries(attachment.extractedFields)) {
    rows.push([key, value === null ? "" : String(value)]);
  }
  if (attachment.contentText?.trim()) rows.push(["Extracted Text", attachment.contentText.trim()]);
  return {
    filename: withExtension(attachment.filename, "xlsx"),
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: createXlsx(rows),
  };
}

// ─── Private helpers ─────────────────────────────────────────────────────

function buildPlainReport(attachment: AttachmentForConversion): string {
  const lines = [
    attachment.filename,
    "",
    `MIME: ${attachment.mimeType || "unknown"}`,
    `Size: ${attachment.size ?? "unknown"}`,
    `Category: ${attachment.category ?? "unknown"}`,
    `Status: ${attachment.analysisStatus}`,
  ];
  if (attachment.summary) lines.push("", "Summary", attachment.summary);
  if (attachment.keyPoints.length > 0) {
    lines.push("", "Key Points", ...attachment.keyPoints.map((point) => `- ${point}`));
  }
  const fields = Object.entries(attachment.extractedFields).filter(
    ([, value]) => value !== null && value !== "",
  );
  if (fields.length > 0) {
    lines.push("", "Extracted Fields", ...fields.map(([key, value]) => `${key}: ${String(value)}`));
  }
  if (attachment.contentText?.trim()) {
    lines.push("", "Extracted Text", attachment.contentText.trim());
  }
  if (attachment.analysisError) lines.push("", "Analysis Note", attachment.analysisError);
  return `${lines.join("\n").trim()}\n`;
}

function csvCell(value: string): string {
  const normalized = value.replace(/\r?\n/g, " ").trim();
  return `"${normalized.replace(/"/g, '""')}"`;
}

function yamlKey(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : JSON.stringify(value);
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function yamlBlock(value: string): string {
  return `|\n${value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n")}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeXml(value: string): string {
  return escapeHtml(value).replace(/'/g, "&apos;");
}

function createSimplePdf(text: string): Buffer {
  const pages = splitLinesForPdf(text);
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  const pageRefs = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  objects.push(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`);
  pages.forEach((pageLines, index) => {
    const pageObjectId = 3 + index * 2;
    const contentObjectId = pageObjectId + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
    );
    const content = [
      "BT",
      "/F1 10 Tf",
      "50 750 Td",
      "14 TL",
      ...pageLines.map((line, lineIndex) => {
        const escaped = line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
        return `${lineIndex === 0 ? "" : "T* "}(${escaped}) Tj`;
      }),
      "ET",
    ].join("\n");
    objects.push(
      `<< /Length ${Buffer.byteLength(content, "utf-8")} >>\nstream\n${content}\nendstream`,
    );
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const chunks = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  let offset = Buffer.byteLength(chunks[0], "utf-8");
  objects.forEach((object, index) => {
    offsets.push(offset);
    const chunk = `${index + 1} 0 obj\n${object}\nendobj\n`;
    chunks.push(chunk);
    offset += Buffer.byteLength(chunk, "utf-8");
  });
  const xrefOffset = offset;
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push("0000000000 65535 f \n");
  for (let index = 1; index < offsets.length; index++) {
    chunks.push(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );
  return Buffer.from(chunks.join(""), "utf-8");
}

function splitLinesForPdf(text: string): string[][] {
  const lines = text.split(/\r?\n/).flatMap((line) => wrapLineForPdf(sanitizePdfLine(line)));
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += 48) {
    pages.push(lines.slice(index, index + 48));
  }
  return pages.length > 0 ? pages : [[""]];
}

function sanitizePdfLine(line: string): string {
  let sanitized = "";
  for (const char of line) {
    const code = char.codePointAt(0) ?? 0;
    const isPrintableAscii = code >= 0x20 && code <= 0x7e;
    const isKorean =
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0x3131 && code <= 0x318e) ||
      (code >= 0x1100 && code <= 0x11ff);
    sanitized += isPrintableAscii || isKorean ? char : "?";
  }
  return sanitized;
}

function wrapLineForPdf(line: string): string[] {
  if (line.length <= 92) return [line];
  const chunks: string[] = [];
  for (let index = 0; index < line.length; index += 92) {
    chunks.push(line.slice(index, index + 92));
  }
  return chunks;
}

function createDocx(text: string): Buffer {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
${text
  .split(/\r?\n/)
  .map((line) => `    <w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
  .join("\n")}
  </w:body>
</w:document>`;
  return zipStore([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
        "utf-8",
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
        "utf-8",
      ),
    },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf-8") },
  ]);
}

function createXlsx(rows: string[][]): Buffer {
  const sheetData = rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map(
            (cell, cellIndex) =>
              `<c r="${columnName(cellIndex + 1)}${rowIndex + 1}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`,
          )
          .join("")}</row>`,
    )
    .join("");
  return zipStore([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
        "utf-8",
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
        "utf-8",
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
        "utf-8",
      ),
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Converted" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
        "utf-8",
      ),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`,
        "utf-8",
      ),
    },
  ]);
}

function columnName(index: number): string {
  let value = "";
  let current = index;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    value = String.fromCharCode(65 + remainder) + value;
    current = Math.floor((current - 1) / 26);
  }
  return value;
}

export function zipStore(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const now = dosDateTime(new Date());

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf-8");
    const crc = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(now.time, 10);
    localHeader.writeUInt16LE(now.date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(now.time, 12);
    centralHeader.writeUInt16LE(now.date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + entry.data.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
