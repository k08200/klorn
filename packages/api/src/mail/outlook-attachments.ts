/**
 * Outlook (Microsoft Graph) attachments in Gmail's attachment model.
 *
 * - Listed with `$select` (no contentBytes), so a list never carries file bytes.
 * - File and item (attached message) attachments become rows; reference
 *   attachments (cloud links) have no bytes and are skipped.
 * - partKey and the fetch handle are Graph's attachment id, which is stable under
 *   the IdType="ImmutableId" preference the poll already sends.
 * - Text is extracted exactly as for Gmail: only isReadableEmailAttachment file
 *   attachments, through the isolated worker, with the bytes read capped at
 *   MAX_EXTRACTABLE_BYTES. No bytes are stored; a download fetches `$value` again.
 * - Only ever requests graph.microsoft.com, with the ids path-encoded.
 */

import { extractAttachmentContentIsolated } from "./attachment-extract-isolated.js";
import { cleanAttachmentFilename, cleanMimeType } from "./attachment-names.js";
import { isReadableEmailAttachment, MAX_EXTRACTABLE_BYTES } from "./email-attachment-text.js";
import type { RawEmailAttachment } from "./email-attachments.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_TIMEOUT_MS = 30_000;
/** One page of the list; a message with more is cut, like a MIME tree past its part cap. */
const MAX_LISTED_ATTACHMENTS = 64;
const FILE_ATTACHMENT = "#microsoft.graph.fileAttachment";
const ITEM_ATTACHMENT = "#microsoft.graph.itemAttachment";

interface GraphAttachment {
  "@odata.type"?: string;
  id?: string;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  isInline?: boolean | null;
}

function graphHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, Prefer: 'IdType="ImmutableId"' };
}

function attachmentsUrl(graphMessageId: string): string {
  return `${GRAPH_BASE}/me/messages/${encodeURIComponent(graphMessageId)}/attachments`;
}

/**
 * The body as bytes, or null when it is (or declares itself) larger than
 * `maxBytes`. Reads chunk by chunk and stops at the cap.
 */
export async function readCappedBody(res: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export type OutlookBytesResult = { bytes: Buffer } | { tooLarge: true } | { status: number };

/** The raw bytes of one attachment (`$value`), capped at `maxBytes`. */
export async function fetchOutlookAttachmentBytes(
  accessToken: string,
  graphMessageId: string,
  attachmentId: string,
  maxBytes: number,
): Promise<OutlookBytesResult> {
  const res = await fetch(
    `${attachmentsUrl(graphMessageId)}/${encodeURIComponent(attachmentId)}/$value`,
    { headers: graphHeaders(accessToken), signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) },
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status };
  }
  const bytes = await readCappedBody(res, maxBytes);
  return bytes ? { bytes } : { tooLarge: true };
}

function toRow(attachment: GraphAttachment): (RawEmailAttachment & { file: boolean }) | null {
  const type = attachment["@odata.type"];
  const id = typeof attachment.id === "string" ? attachment.id : "";
  if (!id || (type !== FILE_ATTACHMENT && type !== ITEM_ATTACHMENT)) return null;
  const file = type === FILE_ATTACHMENT;
  let filename = cleanAttachmentFilename(attachment.name ?? "");
  if (!file && !filename.toLowerCase().endsWith(".eml")) {
    filename = filename ? `${filename}.eml` : "attached-message.eml";
  }
  if (!filename) return null;
  const size =
    typeof attachment.size === "number" && Number.isSafeInteger(attachment.size)
      ? attachment.size
      : null;
  return {
    gmailAttachmentId: id,
    partKey: id,
    filename,
    mimeType:
      cleanMimeType(attachment.contentType) ??
      (file ? "application/octet-stream" : "message/rfc822"),
    size,
    contentId: null,
    contentText: null,
    file,
  };
}

async function readableText(
  accessToken: string,
  graphMessageId: string,
  row: RawEmailAttachment,
): Promise<string | null> {
  if (!isReadableEmailAttachment(row.filename, row.mimeType, row.size)) return null;
  try {
    const result = await fetchOutlookAttachmentBytes(
      accessToken,
      graphMessageId,
      row.partKey,
      MAX_EXTRACTABLE_BYTES,
    );
    if (!("bytes" in result)) return null;
    return (await extractAttachmentContentIsolated(result.bytes, row.filename, row.mimeType)).text;
  } catch {
    return null; // Gmail's contract: the row stays, without text
  }
}

/**
 * The message's attachments as rows, readable file attachments with their text.
 * Throws when Graph refuses the list; the poll then persists without them.
 */
export async function listOutlookAttachments(
  accessToken: string,
  graphMessageId: string,
): Promise<RawEmailAttachment[]> {
  const params = new URLSearchParams({ $select: "id,name,contentType,size,isInline" });
  const res = await fetch(`${attachmentsUrl(graphMessageId)}?${params.toString()}`, {
    headers: graphHeaders(accessToken),
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Graph attachment list failed: http ${res.status}`);
  }
  const body = (await res.json()) as { value?: GraphAttachment[] };
  const rows: RawEmailAttachment[] = [];
  for (const attachment of (body.value ?? []).slice(0, MAX_LISTED_ATTACHMENTS)) {
    const candidate = toRow(attachment);
    if (!candidate) continue;
    const { file, ...row } = candidate;
    const contentText = file ? await readableText(accessToken, graphMessageId, row) : null;
    rows.push({ ...row, contentText });
  }
  return rows;
}
