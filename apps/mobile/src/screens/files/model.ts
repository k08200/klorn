/**
 * Files — the pure half: one list across the sources (Klorn drive, Google
 * Drive, mail attachments), the type tile, the row's source line, the search
 * over names and summaries, what opening a row does, and the attachment
 * summary card. No React, no DOM (model.test.ts).
 */
import type { DriveFileWire } from "@klorn/contract";
import type { AttachmentRow } from "../../api/queries-hub";

export type FileSource = "KLORN" | "GOOGLE" | "MAIL";
export type SourceFilter = "ALL" | FileSource;

export interface FileItem {
  /** Route-safe id: the drive row id, or `a-<attachment id>`. */
  id: string;
  source: FileSource;
  name: string;
  mimeType: string | null;
  size: number | null;
  /** The AI summary (drive D4 or the attachment analysis); text, never markup. */
  summary: string | null;
  modifiedAt: string;
  /** Mail attachments: who sent it and which mail. */
  from: string | null;
  emailId: string | null;
  /** Drive rows keep their wire row (open / download need it). */
  drive: DriveFileWire | null;
  category: string | null;
}

const ROUTE_ID = /[^A-Za-z0-9_-]/g;

export function attachmentItemId(attachmentId: string): string {
  return `a-${attachmentId.replace(ROUTE_ID, "_")}`.slice(0, 128);
}

export function fromDrive(file: DriveFileWire, summary: string | null): FileItem {
  return {
    id: file.id,
    source: file.provider === "GOOGLE" ? "GOOGLE" : "KLORN",
    name: file.name,
    mimeType: file.mimeType,
    size: file.sizeBytes,
    summary,
    modifiedAt: file.modifiedAt,
    from: null,
    emailId: null,
    drive: file,
    category: null,
  };
}

export function fromAttachment(row: AttachmentRow): FileItem {
  return {
    id: attachmentItemId(row.id),
    source: "MAIL",
    name: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    summary: row.summary,
    modifiedAt: row.date,
    from: row.from,
    emailId: row.emailId,
    drive: null,
    category: row.category,
  };
}

/** "박서연 <a@b>" → "박서연". */
export function senderName(from: string | null): string {
  if (!from) return "";
  const name = from
    .replace(/\s*<[^>]*>\s*$/, "")
    .replace(/^"|"$/g, "")
    .trim();
  return name || from.replace(/[<>]/g, "").trim();
}

export type TileKind = "pdf" | "doc" | "sheet" | "slides" | "image" | "archive" | "other";

export interface Tile {
  label: string;
  kind: TileKind;
}

const EXT = /\.([A-Za-z0-9]{1,5})$/;

/** The type tile: the extension in capitals, coloured by kind. */
export function tileOf(name: string, mimeType: string | null): Tile {
  const ext = EXT.exec(name)?.[1]?.toLowerCase() ?? "";
  const mime = mimeType ?? "";
  const label = (ext || mime.split("/")[1] || "file").slice(0, 4).toUpperCase();
  let kind: TileKind = "other";
  if (ext === "pdf" || mime === "application/pdf") kind = "pdf";
  else if (/^(docx?|rtf|txt|md|hwp|pages|odt)$/.test(ext) || mime.includes("wordprocessing"))
    kind = "doc";
  else if (/^(xlsx?|csv|numbers|ods)$/.test(ext) || mime.includes("spreadsheet")) kind = "sheet";
  else if (
    /^(pptx?|key|odp)$/.test(ext) ||
    mime.includes("presentation") ||
    mime.includes("keynote")
  )
    kind = "slides";
  else if (/^(png|jpe?g|gif|heic|webp|svg)$/.test(ext) || mime.startsWith("image/")) kind = "image";
  else if (/^(zip|rar|7z|gz|tar)$/.test(ext)) kind = "archive";
  return { label, kind };
}

/** Newest first, or by name. */
export function sortItems(
  items: readonly FileItem[],
  by: "recent" | "name",
  intlTag: string,
): FileItem[] {
  const collator = new Intl.Collator(intlTag, { sensitivity: "base", numeric: true });
  // Stable: files of one mail keep the mail's own order.
  return [...items].sort((a, b) =>
    by === "name"
      ? collator.compare(a.name, b.name)
      : Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt),
  );
}

/**
 * The search over what the client holds (mail attachments): name, summary and
 * sender. Drive rows are searched by the server (`q`, which also matches
 * summaries while D4 is on), so they are passed through as answered.
 */
export function matchesSearch(item: FileItem, q: string): boolean {
  const text = q.trim().toLowerCase();
  if (!text || item.source !== "MAIL") return true;
  return [item.name, item.summary ?? "", senderName(item.from)]
    .join("\n")
    .toLowerCase()
    .includes(text);
}

export function filterBySource(items: readonly FileItem[], filter: SourceFilter): FileItem[] {
  return filter === "ALL" ? [...items] : items.filter((i) => i.source === filter);
}

/** An https link without credentials, or nothing (a file's own link comes from its source). */
export function safeHttpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export type OpenAction =
  | { kind: "link"; href: string }
  | { kind: "download"; id: string }
  | { kind: "mail"; emailId: string }
  | { kind: "none" };

/** What "Open" does: a Klorn file downloads through a signed link; Google opens its page; a mail attachment opens its mail. */
export function openActionOf(item: FileItem): OpenAction {
  if (item.source === "MAIL")
    return item.emailId ? { kind: "mail", emailId: item.emailId } : { kind: "none" };
  if (!item.drive || item.drive.isFolder) return { kind: "none" };
  if (item.source === "KLORN") return { kind: "download", id: item.drive.id };
  const href = safeHttpsUrl(item.drive.webUrl);
  return href ? { kind: "link", href } : { kind: "none" };
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatSize(bytes: number | null, intlTag: string): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(intlTag, { maximumFractionDigits: 1 }).format(value)} ${UNITS[unit]}`;
}

/** The attachment card: how many arrived this week, by category. */
export function attachmentDigest(
  items: readonly FileItem[],
  now: Date,
  days = 7,
): { total: number; byCategory: Array<{ category: string; count: number }> } {
  const since = now.getTime() - days * 86_400_000;
  const recent = items.filter((i) => i.source === "MAIL" && Date.parse(i.modifiedAt) >= since);
  const counts = new Map<string, number>();
  for (const item of recent) {
    const category = item.category ?? "other";
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  // The artboard's order: contracts, résumés, receipts, then anything else.
  const rank = (c: string) => {
    const i = ["contract", "resume", "invoice"].indexOf(c);
    return i === -1 ? 3 : i;
  };
  const byCategory = [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category));
  return { total: recent.length, byCategory };
}

/** The upload refusals the drive answers with a code (DriveErrorCode). */
export type UploadProblem =
  | "too-large"
  | "quota-exceeded"
  | "quota-not-configured"
  | "rate-limited"
  | "storage-unavailable"
  | "failed";

export function uploadProblemOf(serverMessage: string | null, status: number): UploadProblem {
  if (status === 413) return "too-large";
  if (status === 429) return "rate-limited";
  if (status === 503) return "storage-unavailable";
  const text = serverMessage ?? "";
  if (/quota/i.test(text) && /config/i.test(text)) return "quota-not-configured";
  if (/quota/i.test(text)) return "quota-exceeded";
  return "failed";
}
