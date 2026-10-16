/**
 * The text a drive file is summarised from (step D4 of
 * docs/providers/unified-platform-plan.md). It is the attachment analysis
 * pipeline's extraction, unchanged (mail/email-attachment-text.ts): the same
 * readers for text, PDF, DOCX, XLSX, PPTX, HWPX and HWP, with the same zip-bomb
 * caps. Nothing here parses a file format.
 *
 * Only a `readable` result is summarised. The extractor's `metadata` answer (an
 * image waiting for OCR, a PDF with no text layer) is a description of the file,
 * not its content, so the file is skipped instead of summarising that.
 *
 * A file's type is a label (D3 sniffs the first 4 KiB, a connector reports one):
 * a hint, never a guarantee. The extractor checks the bytes it is given.
 *
 * Google's own formats (D5d) have no bytes of their own: the connector exports a
 * Doc or a Slides deck as text/plain and a Sheet as text/csv (its first sheet
 * only), so their bytes are read as that type, under a neutral name: a Doc
 * named "notes.docx" is plain text, not a DOCX. Any other Google format (a form,
 * a drawing) has no text export and is never fetched. Without this a Doc would
 * be SKIPPED as an unsupported type.
 */

import {
  extractAttachmentContent,
  isReadableEmailAttachment,
} from "../mail/email-attachment-text.js";
import { googleTextExportType, isGoogleAppsType } from "./providers/google-files.js";
import { DRIVE_SUMMARY_MAX_INPUT_CHARS, DRIVE_SUMMARY_MAX_SOURCE_BYTES } from "./summary-policy.js";

const OCTET_STREAM = "application/octet-stream";
const IMAGE_NAME = /\.(jpg|jpeg|png|webp|heic|gif)$/i;
/** The name an export's bytes are read under: its type decides, never the file's extension. */
const EXPORT_NAMES: Readonly<Record<string, string>> = {
  "text/plain": "export.txt",
  "text/csv": "export.csv",
};

/** How the extractor reads this file's bytes: its own name and type, or a Google export's. */
interface ExtractorView {
  readonly name: string;
  readonly type: string;
}

/** The view of a file for the extractor; null for a Google format with no text export. */
function extractorView(name: string, mimeType: string | null): ExtractorView | null {
  const exported = googleTextExportType(mimeType);
  if (exported !== null) return { name: EXPORT_NAMES[exported] ?? "export.txt", type: exported };
  if (isGoogleAppsType(mimeType)) return null;
  return { name, type: mimeType ?? OCTET_STREAM };
}

export type SummaryText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: "unsupported-type" | "no-text" };

/**
 * Whether a file of this name, type and size is worth fetching at all: a type
 * the extractor reads as text, and not over the byte cap. Images are left out:
 * the extractor has no text for them.
 */
export function isSummarisableFile(
  name: string,
  mimeType: string | null,
  sizeBytes: number | null,
): boolean {
  const view = extractorView(name, mimeType);
  if (view === null) return false;
  if (view.type.startsWith("image/") || IMAGE_NAME.test(view.name)) return false;
  if (sizeBytes !== null && sizeBytes > DRIVE_SUMMARY_MAX_SOURCE_BYTES) return false;
  return isReadableEmailAttachment(view.name, view.type, sizeBytes);
}

/** The file's text, at most DRIVE_SUMMARY_MAX_INPUT_CHARS characters, or why there is none. */
export function extractSummaryText(
  bytes: Buffer,
  name: string,
  mimeType: string | null,
): SummaryText {
  const view = extractorView(name, mimeType);
  if (view === null) return { ok: false, code: "unsupported-type" };
  const extracted = extractAttachmentContent(bytes, view.name, view.type);
  if (extracted.status === "unsupported") return { ok: false, code: "unsupported-type" };
  if (extracted.status !== "readable") return { ok: false, code: "no-text" };
  // Cut in code units first (two per character covers any surrogate pair), so a
  // file of megabytes is never spread into an array of that many characters.
  const head = (extracted.text ?? "").trim().slice(0, DRIVE_SUMMARY_MAX_INPUT_CHARS * 2);
  const text = [...head].slice(0, DRIVE_SUMMARY_MAX_INPUT_CHARS).join("");
  return text.length > 0 ? { ok: true, text } : { ok: false, code: "no-text" };
}
