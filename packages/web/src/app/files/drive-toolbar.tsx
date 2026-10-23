"use client";

/**
 * The Klorn drive's controls on /files, shown only while the drive is on
 * (`useKlornDrive().live`): where new files go, "Upload files" (a button that
 * opens the system file picker, several files at once), "New folder", the
 * storage line, and the running or finished upload batch with each file's
 * outcome. Progress and the summary are a polite status; a file's failure is
 * an alert, announced as it happens.
 */

import type { DriveLimitsResponse } from "@klorn/contract";
import { type ChangeEvent, useId, useRef } from "react";
import Button from "../../components/ui/button";
import { useT } from "../../lib/i18n";
import { driveUsage } from "./drive-model";
import { formatFileSize } from "./model";
import type { FolderCrumb } from "./open";
import { batchSummary, type UploadBatch, type UploadStatus } from "./upload-model";
import type { useUploads } from "./use-uploads";

interface DriveToolbarProps {
  limits: DriveLimitsResponse;
  folder: FolderCrumb | null;
  uploads: ReturnType<typeof useUploads>;
  onNewFolder: () => void;
}

export function DriveToolbar({ limits, folder, uploads, onNewFolder }: DriveToolbarProps) {
  const { t, locale } = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const destinationId = useId();
  const usage = driveUsage(limits, locale);
  const limit = formatFileSize(limits.maxFileBytes, locale);
  // No quota on the server: every upload would be refused, so none is offered.
  const canUpload = usage.quota !== null;

  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Cleared, so picking the same file again is a change too.
    event.target.value = "";
    uploads.start(files);
  };

  return (
    <section
      aria-labelledby="files-drive-heading"
      className="flex flex-col gap-3 rounded-card border border-line bg-surface-panel p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2
          id="files-drive-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-body font-semibold text-ink focus:outline-none"
        >
          {t("files.drive.title")}
        </h2>
        <p className="text-caption text-ink-muted">
          {usage.quota === null
            ? t("files.drive.error.notConfigured")
            : t("files.drive.usage", { used: usage.used, quota: usage.quota })}
        </p>
      </div>
      <p
        id={destinationId}
        className="text-body text-ink-muted [overflow-wrap:anywhere] [word-break:keep-all]"
      >
        {folder
          ? t("files.drive.destination.folder", { folder: folder.name })
          : t("files.drive.destination.root")}{" "}
        {canUpload && t("files.drive.upload.limit", { limit })}
      </p>
      <div className="flex flex-wrap gap-2">
        {canUpload && (
          <Button
            aria-describedby={destinationId}
            // Not `disabled`: that would drop focus while a batch runs.
            aria-disabled={uploads.running}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={() => {
              if (!uploads.running) inputRef.current?.click();
            }}
          >
            {t("files.drive.upload")}
          </Button>
        )}
        <Button variant="secondary" aria-describedby={destinationId} onClick={onNewFolder}>
          {t("files.drive.newFolder")}
        </Button>
      </div>
      {/* `hidden`: out of the tab order and the accessibility tree; the button opens it. */}
      <input ref={inputRef} type="file" multiple hidden onChange={onPicked} />
      {uploads.batch && (
        <UploadList
          batch={uploads.batch}
          limit={limit}
          onClear={() => {
            uploads.clear();
            headingRef.current?.focus();
          }}
        />
      )}
    </section>
  );
}

const STATUS_KEYS: Readonly<Record<Exclude<UploadStatus, "failed">, string>> = {
  waiting: "files.drive.upload.waiting",
  uploading: "files.drive.upload.uploading",
  done: "files.drive.upload.done",
};

function summaryText(
  batch: UploadBatch,
  t: (key: string, vars?: Record<string, string>) => string,
) {
  const summary = batchSummary(batch);
  if (!summary.finished) {
    // Between two files nothing is "uploading" for a moment: count the next one.
    const current = summary.current ?? Math.min(summary.done + summary.failed + 1, summary.total);
    return t("files.drive.upload.progress", {
      current: String(current),
      total: String(summary.total),
    });
  }
  const done = String(summary.done);
  return summary.failed === 0
    ? t("files.drive.upload.summaryAll", { done })
    : t("files.drive.upload.summary", { done, failed: String(summary.failed) });
}

function UploadList({
  batch,
  limit,
  onClear,
}: {
  batch: UploadBatch;
  limit: string;
  onClear: () => void;
}) {
  const { t } = useT();
  const finished = batchSummary(batch).finished;
  return (
    <div className="flex flex-col gap-1 border-t border-line-soft pt-3">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-body text-ink">
          {summaryText(batch, t)}
        </p>
        {finished && (
          <Button variant="ghost" size="sm" className="-mr-3" onClick={onClear}>
            {t("files.drive.upload.clear")}
          </Button>
        )}
      </div>
      <ul
        aria-label={t("files.drive.upload.list")}
        className="flex flex-col divide-y divide-line-soft"
      >
        {batch.items.map((item) => (
          <li key={item.key} className="flex flex-col py-2">
            <span className="truncate text-body text-ink">{item.name}</span>
            {item.status === "failed" ? (
              // Announced for the file that was refused, not for each one skipped after it.
              <p
                role={item.skipped ? undefined : "alert"}
                className="text-caption text-state-danger-ink [word-break:keep-all]"
              >
                {t(item.errorKey ?? "files.drive.error.generic", { limit })}
              </p>
            ) : (
              <span className="text-caption text-ink-muted">{t(STATUS_KEYS[item.status])}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
