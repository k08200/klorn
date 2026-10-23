"use client";

/**
 * The Klorn drive's controls on /files, shown only while the drive is on
 * (`useKlornDrive().live`): where new files go, "Upload files" (a button that
 * opens the system file picker, several files at once), "New folder", the
 * storage line, and the running or finished upload batch with each file's
 * outcome, "Cancel" while it runs, and "Retry failed". Progress and the
 * summary are a polite status region that is on the page before its first
 * message, so "Uploading 1 of N" is read. A file the server refused is an alert naming it; files over
 * the cap are one alert for all of them; skipped files are not announced
 * one by one (the summary counts them).
 */

import type { DriveLimitsResponse } from "@klorn/contract";
import { type ChangeEvent, type RefObject, useId, useRef } from "react";
import Button from "../../components/ui/button";
import { useT } from "../../lib/i18n";
import { driveUsage } from "./drive-model";
import { FOCUSED_HEADING } from "./focus";
import { formatFileSize } from "./model";
import type { FolderCrumb } from "./open";
import {
  batchSummary,
  precheckFailures,
  retryableIndices,
  type UploadBatch,
  type UploadItem,
} from "./upload-model";
import type { useUploads } from "./use-uploads";

type Translate = (key: string, vars?: Record<string, string>) => string;

interface DriveToolbarProps {
  limits: DriveLimitsResponse;
  /** The server has a quota: uploads are offered (useDriveManager decides). */
  canUpload: boolean;
  folder: FolderCrumb | null;
  uploads: ReturnType<typeof useUploads>;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onNewFolder: () => void;
}

export function DriveToolbar(props: DriveToolbarProps) {
  const { limits, canUpload, folder, uploads, headingRef } = props;
  const { t, locale } = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const destinationId = useId();
  const usage = driveUsage(limits, locale);
  const limit = formatFileSize(limits.maxFileBytes, locale);

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
          className={`text-body font-semibold text-ink ${FOCUSED_HEADING}`}
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
        <Button variant="secondary" aria-describedby={destinationId} onClick={props.onNewFolder}>
          {t("files.drive.newFolder")}
        </Button>
      </div>
      {/* `hidden`: out of the tab order and the accessibility tree; the button opens it. */}
      <input ref={inputRef} type="file" multiple hidden onChange={onPicked} />
      <UploadPanel
        batch={uploads.batch}
        destination={uploads.destination}
        limit={limit}
        onRetry={() => {
          uploads.retry();
          headingRef.current?.focus();
        }}
        onCancel={() => {
          // The button goes as the batch ends: focus stays in the panel's section.
          uploads.cancel();
          headingRef.current?.focus();
        }}
        onClear={() => {
          uploads.clear();
          headingRef.current?.focus();
        }}
      />
    </section>
  );
}

function summaryText(batch: UploadBatch | null, t: Translate): string {
  if (batch === null) return "";
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

/**
 * Always on the page: with no batch it is an empty, visually hidden status
 * region (taking no room), so the first progress message lands in a region
 * screen readers already watch.
 */
function UploadPanel({
  batch,
  destination,
  limit,
  onRetry,
  onCancel,
  onClear,
}: {
  batch: UploadBatch | null;
  /** Fixed when the batch started: the open folder may have changed since. */
  destination: FolderCrumb | null;
  limit: string;
  onRetry: () => void;
  onCancel: () => void;
  onClear: () => void;
}) {
  const { t, locale } = useT();
  const destinationId = useId();
  const finished = batch !== null && batchSummary(batch).finished;
  const retryable = batch === null ? 0 : retryableIndices(batch).length;
  const tooLarge = batch === null ? [] : precheckFailures(batch);
  return (
    <div className={batch ? "flex flex-col gap-1 border-t border-line-soft pt-3" : "sr-only"}>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-body text-ink">
          {summaryText(batch, t)}
        </p>
        {batch && !finished && (
          <Button variant="ghost" size="sm" className="-mr-3" onClick={onCancel}>
            {t("files.drive.upload.cancel")}
          </Button>
        )}
        {finished && (
          <div className="-mr-3 flex flex-wrap gap-1">
            {retryable > 0 && (
              <Button variant="ghost" size="sm" aria-describedby={destinationId} onClick={onRetry}>
                {t("files.drive.upload.retry", { count: String(retryable) })}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClear}>
              {t("files.drive.upload.clear")}
            </Button>
          </div>
        )}
      </div>
      {batch && (
        <p
          id={destinationId}
          className="text-caption text-ink-muted [overflow-wrap:anywhere] [word-break:keep-all]"
        >
          {destination
            ? t("files.drive.upload.destination.folder", { folder: destination.name })
            : t("files.drive.upload.destination.root")}
        </p>
      )}
      {tooLarge.length > 0 && (
        <p role="alert" className="text-caption text-state-danger-ink [word-break:keep-all]">
          {t("files.drive.upload.tooLargeSummary", {
            count: String(tooLarge.length),
            limit,
            names: new Intl.ListFormat(locale, { type: "conjunction" }).format(tooLarge),
          })}
        </p>
      )}
      {batch && (
        <ul
          aria-label={t("files.drive.upload.list")}
          className="flex flex-col divide-y divide-line-soft"
        >
          {batch.items.map((item) => (
            <li key={item.key} className="flex flex-col py-2">
              <span className="truncate text-body text-ink">{item.name}</span>
              <ItemStatus item={item} limit={limit} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STATUS_KEYS = {
  waiting: "files.drive.upload.waiting",
  uploading: "files.drive.upload.uploading",
  done: "files.drive.upload.done",
} as const;

/** A file's state; a refusal the server gave is an alert that names the file. */
function ItemStatus({ item, limit }: { item: UploadItem; limit: string }) {
  const { t } = useT();
  if (item.status !== "failed") {
    return <span className="text-caption text-ink-muted">{t(STATUS_KEYS[item.status])}</span>;
  }
  const reason = t(item.errorKey ?? "files.drive.error.generic", { limit });
  const shown = item.cause === "skipped" ? t("files.drive.upload.skipped", { reason }) : reason;
  return (
    <p className="text-caption text-state-danger-ink [word-break:keep-all]">
      {item.cause === "sent" ? (
        <>
          <span aria-hidden="true">{shown}</span>
          <span role="alert" className="sr-only">
            {t("files.drive.upload.itemFailed", { name: item.name, reason })}
          </span>
        </>
      ) : (
        shown
      )}
    </p>
  );
}
