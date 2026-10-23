"use client";

/**
 * Files (productization plan P12): the user's indexed files across every
 * drive source that is on, newest first, with a name search. Decision V4 keeps
 * every external source read-only here (list, search, summarise). The Klorn
 * drive, the person's own storage (D3), is editable while it is on for them
 * (GET /api/drive/limits answers): upload and "New folder" into the open
 * folder (drive-toolbar.tsx), and rename, move and delete on its own rows
 * (row-actions.tsx, manage-dialogs.tsx). While it is off the page is the
 * read-only list, exactly as before.
 */

import type { DriveFileWire } from "@klorn/contract";
import { useRef, useState } from "react";
import { PAGE_SHELL } from "../../components/page-shell";
import Button from "../../components/ui/button";
import EmptyState from "../../components/ui/empty-state";
import { Skeleton, SkeletonGroup } from "../../components/ui/skeleton";
import { useT } from "../../lib/i18n";
import { useDisplayTimeZone } from "../../lib/use-time-zone";
import { BlockError } from "../today/block";
import { isKlornEditable } from "./drive-model";
import { DriveToolbar } from "./drive-toolbar";
import { FileGlyph, FileRow } from "./file-row";
import { GoogleDriveConnect } from "./google-drive-connect";
import { ManageDialogs, type RowAction, useManageDialogs } from "./manage-dialogs";
import { SEARCH_MAX_CHARS } from "./model";
import type { FolderCrumb } from "./open";
import { ManagedRow } from "./row-actions";
import { useFileDrop } from "./use-file-drop";
import { useDebounced, useFilesList } from "./use-files";
import { useFolderTrail } from "./use-folder-trail";
import { useDriveRefresh, useKlornDrive } from "./use-klorn-drive";
import { useUploads } from "./use-uploads";

const SKELETON_KEYS = ["a", "b", "c", "d", "e", "f"];

export function FilesView() {
  const { t } = useT();
  const folders = useFolderTrail();
  // The row or crumb that moved the list is gone; focus lands on the list's name.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusList = () => headingRef.current?.focus();
  const folder = folders.folder;
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const list = useFilesList(q, folder?.externalId ?? null, folders.ready);
  const timeZone = useDisplayTimeZone();
  const searching = q.trim().length > 0;
  const { drive, dialogs, uploads, drop } = useDriveManager(folder);

  return (
    <div className={`${PAGE_SHELL} flex flex-col gap-6`}>
      <FilesHeader driveLive={drive.live} />
      {/* D5c: renders nothing while Google Drive is off on the server. */}
      <GoogleDriveConnect />
      {drive.limits && (
        <DriveToolbar
          limits={drive.limits}
          folder={folder}
          uploads={uploads}
          onNewFolder={dialogs.openFolder}
        />
      )}
      {folders.trail.length > 0 && (
        <FolderTrail
          trail={folders.trail}
          onWalk={(index) => {
            folders.walkTo(index);
            focusList();
          }}
        />
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: <search> is not yet in the JSX types this repo targets; role="search" names the same landmark */}
      <div role="search">
        <label htmlFor="files-search" className="sr-only">
          {t("files.search.label")}
        </label>
        <input
          id="files-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          maxLength={SEARCH_MAX_CHARS}
          placeholder={t("files.search.placeholder")}
          autoComplete="off"
          className="focus-ring h-11 w-full rounded-control border border-line bg-surface-panel px-3 text-body text-ink placeholder:text-ink-muted pointer-coarse:text-field"
        />
      </div>
      <section
        aria-labelledby="files-list-heading"
        aria-busy={list.loading || list.stale}
        {...drop.handlers}
        className={drop.over ? DROP_TARGET_CLASS : undefined}
      >
        <h2 id="files-list-heading" ref={headingRef} tabIndex={-1} className="sr-only">
          {searching ? t("files.results") : listTitle(folder, t("files.recent"))}
        </h2>
        {list.loading && (
          <SkeletonGroup label={t("files.loading")} className="flex flex-col gap-2">
            {SKELETON_KEYS.map((key) => (
              <Skeleton key={key} variant="row" />
            ))}
          </SkeletonGroup>
        )}
        {list.failed && <BlockError message={t("files.error")} onRetry={list.retry} />}
        {!list.loading && !list.failed && list.files.length === 0 && (
          <FilesEmpty searching={searching} inFolder={folder !== null} driveLive={drive.live} />
        )}
        <p aria-live="polite" className="sr-only">
          {list.loading || list.failed || list.stale
            ? ""
            : t("files.count", { count: String(list.files.length) })}
        </p>
        {list.files.length > 0 && (
          <FilesRows
            files={list.files}
            timeZone={timeZone}
            manageable={drive.live}
            onOpenFolder={(file) => {
              folders.open(file);
              focusList();
            }}
            onAction={dialogs.openRow}
          />
        )}
        {list.hasMore && (
          <div className="flex justify-center pt-4">
            <Button variant="secondary" onClick={list.loadMore} disabled={list.loadingMore}>
              {list.loadingMore ? t("files.loadingMore") : t("files.loadMore")}
            </Button>
          </div>
        )}
      </section>
      {drive.live && (
        <ManageDialogs dialogs={dialogs} folder={folder} listHeadingRef={headingRef} />
      )}
    </div>
  );
}

/** The list while files are dragged over it: the drive's accent, dashed, outside the rows. */
const DROP_TARGET_CLASS = "rounded-card outline-2 outline-offset-4 outline-dashed outline-accent";

/**
 * D3: the Klorn drive's state on /files. Nothing it offers changes anything
 * unless the drive answered its limits; uploads go into the open folder.
 */
function useDriveManager(folder: FolderCrumb | null) {
  const drive = useKlornDrive();
  const refreshDrive = useDriveRefresh();
  const dialogs = useManageDialogs();
  const uploads = useUploads({
    parentExternalId: folder?.externalId ?? null,
    maxFileBytes: drive.limits?.maxFileBytes ?? 0,
    onFinished: refreshDrive,
  });
  // Dropping files is a shortcut for "Upload files", offered exactly when it is.
  const canUpload = drive.limits !== null && drive.limits.quotaBytes !== null;
  const drop = useFileDrop(uploads.start, canUpload);
  return { drive, dialogs, uploads, drop };
}

interface FilesRowsProps {
  files: DriveFileWire[];
  timeZone: string;
  /** The Klorn drive is on: its own rows get their "More actions" menu. */
  manageable: boolean;
  onOpenFolder: (file: DriveFileWire) => void;
  onAction: (action: RowAction, file: DriveFileWire) => void;
}

function FilesRows({ files, timeZone, manageable, onOpenFolder, onAction }: FilesRowsProps) {
  return (
    <ul className="flex flex-col divide-y divide-line-soft">
      {files.map((file) => {
        const row = <FileRow file={file} timeZone={timeZone} onOpenFolder={onOpenFolder} />;
        return (
          <li key={file.id}>
            {manageable && isKlornEditable(file) ? (
              <ManagedRow file={file} onAction={onAction}>
                {row}
              </ManagedRow>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** "Read-only here" is true only while the Klorn drive is off for this person. */
function FilesHeader({ driveLive }: { driveLive: boolean }) {
  const { t } = useT();
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-display text-ink">{t("nav.files")}</h1>
      <p className="text-body text-ink-muted [word-break:keep-all]">
        {t(driveLive ? "files.subtitle.live" : "files.subtitle")}
      </p>
    </header>
  );
}

/** Where in the Klorn drive the list is: "All files" and each folder opened. */
function FolderTrail({ trail, onWalk }: { trail: FolderCrumb[]; onWalk: (index: number) => void }) {
  const { t } = useT();
  return (
    <nav aria-label={t("files.trail.label")}>
      <ol className="flex flex-wrap items-center gap-x-2">
        <li>
          <Button variant="ghost" size="sm" className="-mx-3" onClick={() => onWalk(-1)}>
            {t("files.trail.all")}
          </Button>
        </li>
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          return (
            <li key={crumb.id} className="flex min-w-0 items-center gap-x-2">
              <span aria-hidden="true" className="text-ink-muted">
                /
              </span>
              {last ? (
                <span aria-current="page" className="truncate text-body text-ink">
                  {crumb.name}
                </span>
              ) : (
                <Button variant="ghost" size="sm" className="min-w-0" onClick={() => onWalk(index)}>
                  <span className="truncate">{crumb.name}</span>
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const EMPTY_COPY = {
  noMatch: { title: "files.noMatch.title", body: "files.noMatch.body" },
  folderEmpty: { title: "files.folderEmpty.title", body: "files.folderEmpty.body" },
  empty: { title: "files.empty.title", body: "files.empty.body" },
  emptyLive: { title: "files.empty.title", body: "files.empty.bodyLive" },
} as const;

/** The unsearched list's name: the open folder's, or "Recent files". */
function listTitle(folder: FolderCrumb | null, recent: string): string {
  return folder?.name ?? recent;
}

function emptyKind(searching: boolean, inFolder: boolean, driveLive: boolean) {
  if (searching) return "noMatch";
  if (inFolder) return "folderEmpty";
  return driveLive ? "emptyLive" : "empty";
}

/** No rows: no match for the search, an empty folder, or nothing indexed or uploaded yet. */
function FilesEmpty({
  searching,
  inFolder,
  driveLive,
}: {
  searching: boolean;
  inFolder: boolean;
  driveLive: boolean;
}) {
  const { t } = useT();
  const kind = emptyKind(searching, inFolder, driveLive);
  return (
    <EmptyState
      headingLevel="h3"
      icon={<FileGlyph folder />}
      title={t(EMPTY_COPY[kind].title)}
      description={t(EMPTY_COPY[kind].body)}
      className="rounded-card border border-line bg-surface-panel"
    />
  );
}
