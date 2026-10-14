/**
 * The content type of a Klorn drive upload (step D3 of
 * docs/providers/unified-platform-plan.md), decided from the first bytes of the
 * file and, only to tell apart containers that share a signature (a zip, an OLE
 * compound file), from the name's extension. The client's Content-Type is never
 * read.
 *
 * The result is a LABEL: what D4 may extract text from and what a later preview
 * may show. Only the types in KLORN_DRIVE_LABELLED_TYPES are kept; everything
 * else, executables and HTML, SVG, XML or script files included, is stored as
 * application/octet-stream. Nothing is refused for its type. The download is an
 * octet-stream attachment whatever the label (D1), so no stored file ever
 * renders on the storage origin.
 */

import { allowContentTypes, type ContentTypePolicy } from "../storage/limits.js";

/** How many leading bytes the sniffer looks at. */
export const SNIFF_BYTES = 4096;

export const OCTET_STREAM = "application/octet-stream";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const ODT = "application/vnd.oasis.opendocument.text";
const ODS = "application/vnd.oasis.opendocument.spreadsheet";
const ODP = "application/vnd.oasis.opendocument.presentation";
const HWPX = "application/hwp+zip";

/** A zip container is one of these only when its extension says so. */
const ZIP_BY_EXTENSION: Readonly<Record<string, string>> = {
  docx: DOCX,
  xlsx: XLSX,
  pptx: PPTX,
  hwpx: HWPX,
};

/** An OLE compound file is one of these only when its extension says so (an .msi is one too). */
const OLE_BY_EXTENSION: Readonly<Record<string, string>> = {
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  hwp: "application/x-hwp",
};

/** UTF-8 text is labelled by its extension; any other text is text/plain. */
const TEXT_BY_EXTENSION: Readonly<Record<string, string>> = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
};

/** Text with these extensions is code or markup, never labelled text. */
const NEVER_TEXT_EXTENSIONS = new Set([
  "htm",
  "html",
  "xhtml",
  "svg",
  "svgz",
  "xml",
  "js",
  "mjs",
  "cjs",
  "sh",
  "bash",
  "zsh",
  "command",
  "bat",
  "cmd",
  "ps1",
  "vbs",
  "py",
  "rb",
  "pl",
  "php",
]);

/** Every label the drive keeps. Anything else is stored as octet-stream. */
export const KLORN_DRIVE_LABELLED_TYPES = [
  PDF,
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/avif",
  "image/tiff",
  "image/bmp",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/markdown",
  "application/json",
  "application/rtf",
  ...Object.values(OLE_BY_EXTENSION),
  ...Object.values(ZIP_BY_EXTENSION),
  ODT,
  ODS,
  ODP,
] as const;

/**
 * What `UserStorage.put` is told to accept: the labels and octet-stream, nothing
 * else. The sniffer only produces these, so this is a second lock on the same
 * door, and the reason a stored object never carries text/html or image/svg+xml.
 */
export const klornStoredTypePolicy: ContentTypePolicy = allowContentTypes([
  ...KLORN_DRIVE_LABELLED_TYPES,
  OCTET_STREAM,
]);

interface Signature {
  readonly offset: number;
  readonly bytes: readonly number[];
  readonly type: string;
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/** Fixed signatures of the labelled formats that need no extension. */
const SIGNATURES: readonly Signature[] = [
  { offset: 0, bytes: ascii("%PDF-"), type: PDF },
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], type: "image/png" },
  { offset: 0, bytes: [0xff, 0xd8, 0xff], type: "image/jpeg" },
  { offset: 0, bytes: ascii("GIF87a"), type: "image/gif" },
  { offset: 0, bytes: ascii("GIF89a"), type: "image/gif" },
  { offset: 8, bytes: ascii("WEBP"), type: "image/webp" },
  { offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00], type: "image/tiff" },
  { offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a], type: "image/tiff" },
  { offset: 0, bytes: ascii("{\\rtf"), type: "application/rtf" },
];

/** Executable and script signatures: always octet-stream, whatever the name. */
const EXECUTABLE_SIGNATURES: readonly (readonly number[])[] = [
  ascii("MZ"), // Windows PE
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal (and Java class)
  ascii("#!"), // a script with an interpreter line
];

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** An ISO base media file's brands that are HEIF / AVIF images. */
const HEIF_BRANDS: Readonly<Record<string, string>> = {
  heic: "image/heic",
  heix: "image/heic",
  heim: "image/heic",
  heis: "image/heic",
  mif1: "image/heif",
  msf1: "image/heif",
  avif: "image/avif",
};
/** An OpenDocument zip stores its type, uncompressed, as the first entry "mimetype". */
const ODF_MIMETYPE_OFFSET = 30;
/** "mimetype" and the longest OpenDocument type after it. */
const ODF_MIMETYPE_WINDOW = 64;
const ODF_TYPES = [ODT, ODS, ODP];

function startsWith(head: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => head[offset + index] === byte);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function latin1(head: Uint8Array, from: number, length: number): string {
  return String.fromCharCode(...head.subarray(from, from + length));
}

/** "BM", then the file size, then four reserved bytes that are zero. */
const BMP_HEADER_BYTES = 14;
function isBmp(head: Uint8Array): boolean {
  if (head.length < BMP_HEADER_BYTES || !startsWith(head, ascii("BM"))) return false;
  return head.subarray(6, 10).every((byte) => byte === 0);
}

function heifType(head: Uint8Array): string | null {
  if (latin1(head, 4, 4) !== "ftyp") return null;
  return HEIF_BRANDS[latin1(head, 8, 4)] ?? null;
}

function zipType(head: Uint8Array, extension: string): string {
  const firstEntry = latin1(head, ODF_MIMETYPE_OFFSET, ODF_MIMETYPE_WINDOW);
  const odf = ODF_TYPES.find((type) => firstEntry.startsWith(`mimetype${type}`));
  return odf ?? ZIP_BY_EXTENSION[extension] ?? OCTET_STREAM;
}

/**
 * True when the bytes are UTF-8 text: valid UTF-8, no NUL, no control
 * character but tab, line feed, carriage return and form feed. When the head
 * is only the start of a longer file, a multi-byte character cut at its end
 * is allowed.
 */
function isUtf8Text(head: Uint8Array, truncated: boolean): boolean {
  if (head.length === 0) return false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text: string;
  try {
    text = decoder.decode(head, { stream: truncated });
  } catch {
    return false;
  }
  return !CONTROL_BUT_WHITESPACE.test(text);
}

/** Any control character except tab, line feed, carriage return and form feed. */
const CONTROL_BUT_WHITESPACE = /[^\P{Cc}\t\n\r\f]/u;

/** Markup starts with `<` (after a BOM and white space): HTML, SVG, XML. */
function looksLikeMarkup(head: Uint8Array): boolean {
  const start = new TextDecoder("utf-8").decode(head.subarray(0, 64)).replace(/^﻿/, "");
  return start.trimStart().startsWith("<");
}

function textType(head: Uint8Array, extension: string, truncated: boolean): string {
  if (NEVER_TEXT_EXTENSIONS.has(extension)) return OCTET_STREAM;
  if (!isUtf8Text(head, truncated) || looksLikeMarkup(head)) return OCTET_STREAM;
  return TEXT_BY_EXTENSION[extension] ?? "text/plain";
}

export interface SniffOptions {
  /** True when `head` is only the start of the file (the file is longer). */
  readonly truncated?: boolean;
}

/**
 * The label of a file from its first bytes (at most SNIFF_BYTES are looked at)
 * and its cleaned name. Pure.
 */
export function sniffContentType(
  head: Uint8Array,
  name: string,
  options: SniffOptions = {},
): string {
  const sniffed = head.subarray(0, SNIFF_BYTES);
  const truncated = options.truncated ?? head.length > SNIFF_BYTES;
  const extension = extensionOf(name);
  if (EXECUTABLE_SIGNATURES.some((signature) => startsWith(sniffed, signature))) {
    return OCTET_STREAM;
  }
  const fixed = SIGNATURES.find((signature) =>
    startsWith(sniffed, signature.bytes, signature.offset),
  );
  if (fixed?.type === "image/webp") {
    return startsWith(sniffed, ascii("RIFF")) ? fixed.type : OCTET_STREAM;
  }
  if (fixed) return fixed.type;
  if (isBmp(sniffed)) return "image/bmp";
  const heif = heifType(sniffed);
  if (heif) return heif;
  if (startsWith(sniffed, ZIP)) return zipType(sniffed, extension);
  if (startsWith(sniffed, OLE)) return OLE_BY_EXTENSION[extension] ?? OCTET_STREAM;
  return textType(sniffed, extension, truncated);
}
