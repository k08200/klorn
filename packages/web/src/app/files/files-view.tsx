"use client";

/**
 * Files (productization plan P12): the user's indexed files across every
 * drive source that is on, newest first, with a name search. Read-only in v1
 * (decision V4: list, search, summarise; no upload or edit from this page).
 */

import { useRef, useState } from "react";
import Button from "../../components/ui/button";
import EmptyState from "../../components/ui/empty-state";
import { Skeleton, SkeletonGroup } from "../../components/ui/skeleton";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { BlockError } from "../today/block";
import { FileGlyph, FileRow } from "./file-row";
import { SEARCH_MAX_CHARS } from "./model";
import type { FolderCrumb } from "./open";
import { useDebounced, useFilesList } from "./use-files";
import { useFolderTrail } from "./use-folder-trail";

const DEFAULT_TIME_ZONE = "Asia/Seoul";
const SKELETON_KEYS = ["a", "b", "c", "d", "e", "f"];

export function FilesView() {
  const { t } = useT();
  const { user } = useAuth();
  const folders = useFolderTrail();
  // The row or crumb that moved the list is gone; focus lands on the list's name.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusList = () => headingRef.current?.focus();
  const folder = folders.folder;
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const list = useFilesList(q, folder?.externalId ?? null, folders.ready);
  const timeZone = user?.timezone ?? DEFAULT_TIME_ZONE;
  const searching = q.trim().length > 0;

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-display text-ink">{t("nav.files")}</h1>
        <p className="text-body text-ink-muted">{t("files.subtitle")}</p>
      </header>
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
      <section aria-labelledby="files-list-heading" aria-busy={list.loading || list.stale}>
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
          <FilesEmpty searching={searching} inFolder={folder !== null} />
        )}
        <p aria-live="polite" className="sr-only">
          {list.loading || list.failed || list.stale
            ? ""
            : t("files.count", { count: String(list.files.length) })}
        </p>
        {list.files.length > 0 && (
          <ul className="flex flex-col divide-y divide-line-soft">
            {list.files.map((file) => (
              <li key={file.id}>
                <FileRow
                  file={file}
                  timeZone={timeZone}
                  onOpenFolder={(file) => {
                    folders.open(file);
                    focusList();
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {list.hasMore && (
          <div className="flex justify-center pt-4">
            <Button variant="secondary" onClick={list.loadMore} disabled={list.loadingMore}>
              {list.loadingMore ? t("files.loadingMore") : t("files.loadMore")}
            </Button>
          </div>
        )}
      </section>
    </div>
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
} as const;

/** The unsearched list's name: the open folder's, or "Recent files". */
function listTitle(folder: FolderCrumb | null, recent: string): string {
  return folder?.name ?? recent;
}

/** No rows: no match for the search, an empty folder, or nothing indexed yet. */
function FilesEmpty({ searching, inFolder }: { searching: boolean; inFolder: boolean }) {
  const { t } = useT();
  const kind: keyof typeof EMPTY_COPY = searching ? "noMatch" : inFolder ? "folderEmpty" : "empty";
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
