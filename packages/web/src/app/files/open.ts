/**
 * Opening a drive row (P12 follow-up) — the pure rules. A Klorn drive file has
 * no `webUrl`: its bytes are reached through GET /api/drive/files/:id/download,
 * which checks the row is the session user's and answers a signed storage link
 * valid for at most 300 seconds, always served as an attachment under a
 * server-sanitised filename (api storage/download-name.ts). The page asks for
 * that link with its Bearer token and then navigates to it; the token never
 * goes into a URL and the link is never stored. A Klorn folder is walked into
 * with the list's `folder` filter. An external row keeps its own https link.
 */

import type { DriveFileWire } from "@klorn/contract";
import { safeWebUrl } from "./model";

export type FileOpenAction =
  | { kind: "link"; href: string }
  | { kind: "download" }
  | { kind: "folder" }
  | { kind: "none" };

const KLORN_PROVIDER = "KLORN";

/** What activating a row does; "none" leaves it plain text. */
export function fileOpenAction(file: DriveFileWire): FileOpenAction {
  if (file.provider === KLORN_PROVIDER) {
    return file.isFolder ? { kind: "folder" } : { kind: "download" };
  }
  const href = safeWebUrl(file.webUrl);
  return href ? { kind: "link", href } : { kind: "none" };
}

/** The authenticated request for one file's signed link. */
export function downloadLinkPath(id: string): string {
  return `/api/drive/files/${encodeURIComponent(id)}/download`;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The signed link, only when it is an absolute https URL without credentials
 * (or http to a loopback host: a local object store in development). Anything
 * else — javascript:, data:, blob:, a relative path — is never navigated to,
 * whatever the API answered. Returns the parsed, normalised href.
 */
export function safeDownloadUrl(url: unknown): string | null {
  if (typeof url !== "string" || url === "") return null;
  try {
    const parsed = new URL(url);
    if (parsed.username !== "" || parsed.password !== "") return null;
    if (parsed.protocol === "https:") return parsed.href;
    if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return parsed.href;
    return null;
  } catch {
    return null;
  }
}

export type DownloadErrorKey =
  | "files.download.gone"
  | "files.download.busy"
  | "files.download.error";

const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY = 429;

/** The message for a failed download, from apiFetch's "API <status>: …" error. */
export function downloadErrorKey(err: unknown): DownloadErrorKey {
  const message = err instanceof Error ? err.message : "";
  const status = Number(/^API (\d{3}):/.exec(message)?.[1]);
  if (status === HTTP_NOT_FOUND) return "files.download.gone";
  if (status === HTTP_TOO_MANY) return "files.download.busy";
  return "files.download.error";
}

/** The /files query parameter that opens one Klorn drive folder by row id. */
export const FOLDER_PARAM = "folder";

/** /files opened at one Klorn drive folder (from Today's recent files). */
export function folderHref(id: string): string {
  return `/files?${new URLSearchParams({ [FOLDER_PARAM]: id }).toString()}`;
}

/** One opened Klorn drive folder: the row id, the id its children name, its name. */
export interface FolderCrumb {
  id: string;
  externalId: string;
  name: string;
}

/** The trail cut back to `index` (-1: all files). A new array. */
export function trailTo(trail: readonly FolderCrumb[], index: number): FolderCrumb[] {
  return trail.slice(0, Math.max(0, index + 1));
}
