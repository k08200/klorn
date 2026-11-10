"use client";

/**
 * The drive list for /files and Today (productization plan P12). Read-only:
 * GET /api/drive/files, which returns only the user's own rows of the sources
 * that are on. Nothing here calls a model.
 */

import type { DriveFilesListResponse } from "@klorn/contract";
import {
  type InfiniteData,
  keepPreviousData,
  type UseInfiniteQueryResult,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";
import { filesListPath, RECENT_FILES_LIMIT } from "./model";

const FILES_STALE_MS = 60_000;
const SEARCH_DEBOUNCE_MS = 250;

/** The value, once it has stopped changing for `delayMs`. */
export function useDebounced(value: string, delayMs = SEARCH_DEBOUNCE_MS): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

async function readFiles(path: string, scope: string): Promise<DriveFilesListResponse> {
  try {
    return await apiFetch<DriveFilesListResponse>(path);
  } catch (err) {
    captureClientError(err, { scope });
    throw err;
  }
}

type FilesQuery = UseInfiniteQueryResult<InfiniteData<DriveFilesListResponse>>;

/** What a paged list shows, the same for /files and for the Move picker's levels. */
function listState(query: FilesQuery, enabled: boolean) {
  return {
    files: query.data?.pages.flatMap((page) => page.files) ?? [],
    loading: !enabled || query.isLoading,
    failed: query.isError && !query.data,
    // keepPreviousData: the last search's list is on screen while a new one
    // loads. It is not this search's answer, so it pages nothing and counts nothing.
    stale: query.isPlaceholderData,
    hasMore: query.hasNextPage && !query.isPlaceholderData,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    retry: () => void query.refetch(),
  };
}

export type FilesListState = ReturnType<typeof listState>;

/** The list, or one Klorn drive folder of it (`folder`: its externalId). */
export function useFilesList(q: string, folder: string | null = null, enabled = true) {
  const text = q.trim();
  const query = useInfiniteQuery({
    queryKey: queryKeys.drive.files(text, folder),
    queryFn: ({ pageParam }) =>
      readFiles(filesListPath({ q: text, cursor: pageParam, folder }), "files.list"),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // A new search keeps the last list on screen until it answers; a new
    // folder does not, so no row of the folder just left stays clickable.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === folder ? keepPreviousData(previous) : undefined,
    staleTime: FILES_STALE_MS,
    enabled,
  });
  return listState(query, enabled);
}

/**
 * One level of the Move picker: a Klorn drive folder's folders (`root`: the top
 * level), paged among folders only (`foldersOnly=true`), so a page never fills
 * with files and leaves only "Load more".
 */
export function useFolderLevel(folder: string, enabled: boolean) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.drive.folders(folder),
    queryFn: ({ pageParam }) =>
      readFiles(filesListPath({ cursor: pageParam, folder, foldersOnly: true }), "files.move"),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: FILES_STALE_MS,
    enabled,
  });
  return listState(query, enabled);
}

export function useRecentFiles(enabled: boolean) {
  const query = useQuery({
    queryKey: queryKeys.drive.recent(),
    queryFn: () => readFiles(filesListPath({ limit: RECENT_FILES_LIMIT }), "today.files"),
    staleTime: FILES_STALE_MS,
    enabled,
  });
  return {
    files: query.data?.files ?? [],
    loading: enabled && query.isLoading,
    failed: query.isError && !query.data,
    retry: () => void query.refetch(),
  };
}
