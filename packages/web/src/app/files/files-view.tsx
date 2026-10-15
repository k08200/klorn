"use client";

/**
 * Files (productization plan P12): the user's indexed files across every
 * drive source that is on, newest first, with a name search. Read-only in v1
 * (decision V4: list, search, summarise; no upload or edit from this page).
 */

import { useState } from "react";
import Button from "../../components/ui/button";
import EmptyState from "../../components/ui/empty-state";
import { Skeleton, SkeletonGroup } from "../../components/ui/skeleton";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { BlockError } from "../today/block";
import { FileGlyph, FileRow } from "./file-row";
import { SEARCH_MAX_CHARS } from "./model";
import { useDebounced, useFilesList } from "./use-files";

const DEFAULT_TIME_ZONE = "Asia/Seoul";
const SKELETON_KEYS = ["a", "b", "c", "d", "e", "f"];

export function FilesView() {
  const { t } = useT();
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const list = useFilesList(q);
  const timeZone = user?.timezone ?? DEFAULT_TIME_ZONE;
  const searching = q.trim().length > 0;

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-display text-ink">{t("nav.files")}</h1>
        <p className="text-body text-ink-muted">{t("files.subtitle")}</p>
      </header>
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
      <section aria-labelledby="files-list-heading" aria-busy={list.loading}>
        <h2 id="files-list-heading" className="sr-only">
          {searching ? t("files.results") : t("files.recent")}
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
          <EmptyState
            headingLevel="h3"
            icon={<FileGlyph folder />}
            title={searching ? t("files.noMatch.title") : t("files.empty.title")}
            description={searching ? t("files.noMatch.body") : t("files.empty.body")}
            className="rounded-card border border-line bg-surface-panel"
          />
        )}
        <p aria-live="polite" className="sr-only">
          {list.loading || list.failed
            ? ""
            : t("files.count", { count: String(list.files.length) })}
        </p>
        {list.files.length > 0 && (
          <ul className="flex flex-col divide-y divide-line-soft">
            {list.files.map((file) => (
              <li key={file.id}>
                <FileRow file={file} timeZone={timeZone} />
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
