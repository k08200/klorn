/**
 * Vision/OCR attachment policy — the deterministic "should this attachment go
 * to the vision model?" rules, kept in one leaf module (no DB / route deps) so
 * they're a single editable, unit-testable surface. Mirrors the keyword-policy
 * / tier-policy pattern. Consumed by routes/email-attachments.ts (the OCR
 * route).
 */

/** Hard ceiling: above this an attachment is too large to send to vision OCR. */
export const MAX_VISION_ATTACHMENT_BYTES = 8_000_000;

// Floor: below this an image carries no readable content — it's a tracking
// pixel, spacer, or a tiny email logo/icon. The BetaList digest that surfaced
// this shipped a 558-byte logo.png on every row; sending those to the vision
// model burns quota and (when the model is down) floods the UI with
// VISION_FAILED noise.
const MIN_VISION_IMAGE_BYTES = 4_000;

// Decorative chrome newsletters embed as real image attachments: logos,
// spacers, social/footer icons, signature images. Matched on the filename so a
// reasonably-sized logo (at or above the byte floor) is still skipped.
// Boundary is `^` or `-`/`_` only (NOT `/`): stored attachment filenames are
// basenames, so a `/` would only appear if a path leaked in — and then a
// directory named "logo/" must not make a real image read as decorative.
const DECORATIVE_FILENAME_RE =
  /(?:^|[-_])(?:logo|icon|spacer|pixel|tracking|beacon|divider|separator|bullet|header|footer|banner|sig|signature|social|facebook|twitter|instagram|linkedin)[-_.\d]*\.(?:png|gif|jpe?g|webp|bmp|svg)$/i;

const IMAGE_EXT_RE = /\.(?:png|gif|jpe?g|webp|bmp|svg)$/i;

/**
 * Whether an attachment is a candidate for vision/OCR at all: images, PDFs, or
 * rows whose stored text says extraction is still pending/failed. Used to skip
 * plain-text attachments that were already handled by the text-analysis path.
 */
export function isVisionAttachment(row: {
  filename: string;
  mimeType: string;
  contentText: string | null;
  analysisStatus: string;
}): boolean {
  const lower = row.filename.toLowerCase();
  return (
    row.mimeType.startsWith("image/") ||
    row.mimeType.includes("pdf") ||
    /\.(jpg|jpeg|png|webp|heic|pdf)$/i.test(lower) ||
    /OCR 분석 대기|텍스트 레이어 없음|추출 실패/.test(row.contentText ?? "") ||
    ["UNSUPPORTED", "VISION_FAILED"].includes(row.analysisStatus)
  );
}

/**
 * True when an image attachment is decorative (a tracking pixel, spacer, or a
 * small logo/icon) rather than content worth OCR'ing. Running vision on these
 * burns quota and surfaces VISION_FAILED noise; the user wants them quietly
 * marked done, not analyzed. Non-image attachments (PDFs/docs) are never
 * decorative here — they always get analyzed.
 */
export function isDecorativeImage(row: {
  filename: string;
  mimeType: string;
  size: number | null;
}): boolean {
  const isImage = row.mimeType.startsWith("image/") || IMAGE_EXT_RE.test(row.filename);
  if (!isImage) return false;
  // A KNOWN size below the floor (including a 0-byte / corrupt image) is
  // decorative; a null size is "unknown" and falls through to the filename
  // check rather than being treated as 0.
  if (row.size != null && row.size < MIN_VISION_IMAGE_BYTES) return true;
  return DECORATIVE_FILENAME_RE.test(row.filename);
}
