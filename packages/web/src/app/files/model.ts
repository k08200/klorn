/**
 * Files (productization plan P12) — the pure rules behind /files and Today's
 * recent files: how the drive list is asked for, how a size reads, and which
 * links a row may open. The list itself is read-only (decision V4: list,
 * search, summarise; no upload or edit from here).
 */

/** One page of /files. The server serves at most 100. */
export const FILES_PAGE_SIZE = 50;
/** Today's "Recent files" block. */
export const RECENT_FILES_LIMIT = 5;
/** The server reads the first 100 characters of a search; send no more. */
export const SEARCH_MAX_CHARS = 100;

const DRIVE_FILES_PATH = "/api/drive/files";

export interface FilesListRequest {
  q?: string;
  cursor?: string | null;
  limit?: number;
}

/** GET /api/drive/files with the search, page and size, URL-encoded. */
export function filesListPath({ q, cursor, limit = FILES_PAGE_SIZE }: FilesListRequest): string {
  const params = new URLSearchParams({ limit: String(limit) });
  const text = q?.trim().slice(0, SEARCH_MAX_CHARS);
  if (text) params.set("q", text);
  if (cursor) params.set("cursor", cursor);
  return `${DRIVE_FILES_PATH}?${params.toString()}`;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const STEP = 1024;

/** "1.5 KB"; empty for a folder or a size the source did not report. */
export function formatFileSize(bytes: number | null, locale: string): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "";
  let value = bytes;
  let unit = 0;
  while (value >= STEP && unit < UNITS.length - 1) {
    value /= STEP;
    unit += 1;
  }
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  return `${number} ${UNITS[unit]}`;
}

/**
 * A file's link into its own service, only when it is https and carries no
 * credentials. The name and the link come from the source, so anything else
 * (javascript:, data:, http:, a relative or protocol-relative path, user:pass@)
 * is never rendered as a link. The parsed, normalised href is returned, never
 * the source's own string.
 */
export function safeWebUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:") return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    return parsed.href;
  } catch {
    return null;
  }
}
