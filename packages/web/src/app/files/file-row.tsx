"use client";

/**
 * One file of the drive list (productization plan P12): kind glyph, name,
 * SourceBadge, modified date and size. What activating it does is
 * `fileOpenAction` (./open.ts): an external file with an https link opens there
 * in a new tab; a Klorn drive file downloads through its signed link; a Klorn
 * drive folder opens in /files; anything else is plain text (V4: no edit here).
 * The name is the source's text, rendered as text only.
 */

import type { DriveFileWire } from "@klorn/contract";
import Link from "next/link";
import { type ReactNode, useId } from "react";
import Button from "../../components/ui/button";
import { SourceBadge } from "../../components/ui/source-badge";
import { useT } from "../../lib/i18n";
import { formatFileSize } from "./model";
import { fileOpenAction, folderHref } from "./open";
import { useFileDownload } from "./use-download";

const ROW_CLASS = "-mx-3 flex min-h-13 items-center gap-3 rounded-card px-3 py-2";
const LINK_ROW_CLASS = `focus-ring ${ROW_CLASS} transition-colors duration-120 ease-fluid hover:bg-surface-hover`;
// The same 12px bleed as the link and plain rows (-mx-3 px-3), so every
// row's hover fill and focus ring reach equally far. The Button primitive
// pads 14px (size md, px-3.5); the body takes the 2px back on each side, so
// the content and the badge line up with the other rows. align-top: the
// Button is inline-flex, and on the baseline its line box would add a pixel
// or two below it. The link rows' height and padding go on the body: the
// Button's own min-height is its frame's, so setting one on it would race it.
const BUTTON_ROW_CLASS = "-mx-3 w-[calc(100%+1.5rem)] rounded-card align-top";
const BUTTON_ROW_BODY =
  "-mx-0.5 flex min-h-13 w-[calc(100%+0.25rem)] min-w-0 items-center gap-3 py-2 text-left";

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

interface FileRowProps {
  file: DriveFileWire;
  timeZone: string;
  /** Opens a Klorn drive folder in place; without it the folder links to /files. */
  onOpenFolder?: (file: DriveFileWire) => void;
}

export function FileRow({ file, timeZone, onOpenFolder }: FileRowProps) {
  const { t, locale } = useT();
  const metaId = useId();
  const action = fileOpenAction(file);
  const modified = modifiedLabel(file.modifiedAt, locale, timeZone);
  const size = file.isFolder ? t("files.folder") : formatFileSize(file.sizeBytes, locale);
  const meta = [modified, size].filter(Boolean).join(" · ");
  const body = (status?: ReactNode) => (
    <>
      <span className="text-ink-muted">
        <FileGlyph folder={file.isFolder} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body text-ink">{file.name}</span>
        {(status ?? meta) && (
          <span id={metaId} className="text-caption text-ink-muted">
            {status ?? meta}
          </span>
        )}
      </span>
      <SourceBadge provider={file.provider} />
    </>
  );

  if (action.kind === "download")
    return <DownloadRow file={file} metaId={metaId} hasMeta={meta !== ""} body={body} />;
  if (action.kind === "folder") {
    const label = t("files.openFolder", { name: file.name });
    if (onOpenFolder) {
      return (
        <Button
          variant="ghost"
          aria-label={label}
          aria-describedby={meta ? metaId : undefined}
          onClick={() => onOpenFolder(file)}
          className={BUTTON_ROW_CLASS}
        >
          <span className={BUTTON_ROW_BODY}>{body()}</span>
        </Button>
      );
    }
    return (
      <Link
        href={folderHref(file.id)}
        aria-label={label}
        aria-describedby={meta ? metaId : undefined}
        className={LINK_ROW_CLASS}
      >
        {body()}
      </Link>
    );
  }
  if (action.kind === "none") return <div className={ROW_CLASS}>{body()}</div>;
  return (
    <a href={action.href} target="_blank" rel="noopener noreferrer" className={LINK_ROW_CLASS}>
      {body()}
      <span className="sr-only">{t("files.opensNewTab")}</span>
    </a>
  );
}

/**
 * A Klorn drive file: a button that asks the API for the signed link and then
 * navigates to it (an attachment, so the page stays). Busy and failed states
 * are announced; a failure keeps the row usable to try again.
 */
function DownloadRow({
  file,
  metaId,
  hasMeta,
  body,
}: {
  file: DriveFileWire;
  metaId: string;
  hasMeta: boolean;
  body: (status?: ReactNode) => ReactNode;
}) {
  const { t } = useT();
  const download = useFileDownload();
  const errorId = useId();
  const status = download.isPending ? t("files.download.preparing") : undefined;
  // The meta line, or the "preparing" status shown in its place.
  const described = hasMeta || status !== undefined ? metaId : undefined;
  const describedBy = [described, download.errorKey ? errorId : undefined]
    .filter(Boolean)
    .join(" ");
  return (
    <div>
      <Button
        variant="ghost"
        aria-label={t("files.download.label", { name: file.name })}
        aria-describedby={describedBy || undefined}
        aria-busy={download.isPending}
        // Not `disabled`: that would drop keyboard focus mid-download.
        aria-disabled={download.isPending}
        onClick={() => {
          if (!download.isPending) download.start(file.id);
        }}
        className={BUTTON_ROW_CLASS}
      >
        <span className={BUTTON_ROW_BODY}>{body(status)}</span>
      </Button>
      <p aria-live="polite" className="sr-only">
        {status ?? ""}
      </p>
      {download.errorKey && (
        <p
          id={errorId}
          role="alert"
          className="pb-2 text-caption text-state-danger-ink [word-break:keep-all]"
        >
          {t(download.errorKey, { name: file.name })}
        </p>
      )}
    </div>
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
