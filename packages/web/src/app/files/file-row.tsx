"use client";

/**
 * One file of the drive list (productization plan P12): kind glyph, name,
 * SourceBadge, modified date and size. A file whose source gave an https link
 * opens there in a new tab; any other row is plain text (V4: no edit here).
 * The name is the source's text, rendered as text only.
 */

import type { DriveFileWire } from "@klorn/contract";
import { SourceBadge } from "../../components/ui/source-badge";
import { useT } from "../../lib/i18n";
import { formatFileSize, safeWebUrl } from "./model";

const ROW_CLASS = "-mx-3 flex min-h-13 items-center gap-3 rounded-card px-3 py-2";

function modifiedLabel(iso: string, locale: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone }).format(
      date,
    );
  } catch {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
  }
}

export function FileRow({ file, timeZone }: { file: DriveFileWire; timeZone: string }) {
  const { t, locale } = useT();
  const href = safeWebUrl(file.webUrl);
  const modified = modifiedLabel(file.modifiedAt, locale, timeZone);
  const size = file.isFolder ? t("files.folder") : formatFileSize(file.sizeBytes, locale);
  const meta = [modified, size].filter(Boolean).join(" · ");
  const body = (
    <>
      <span className="text-ink-muted">
        <FileGlyph folder={file.isFolder} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body text-ink">{file.name}</span>
        {meta && <span className="text-caption text-ink-muted">{meta}</span>}
      </span>
      <SourceBadge provider={file.provider} />
      {href && <span className="sr-only">{t("files.opensNewTab")}</span>}
    </>
  );
  if (!href) return <div className={ROW_CLASS}>{body}</div>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`focus-ring ${ROW_CLASS} transition-colors duration-120 ease-fluid hover:bg-surface-hover`}
    >
      {body}
    </a>
  );
}

export function FileGlyph({ folder }: { folder: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {folder ? (
        <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12Z" />
      ) : (
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5" />
      )}
    </svg>
  );
}
