"use client";

/**
 * Mail v2 data (productization plan P5, MAIL_V2): the list for one view, the
 * per-lane counts and the connected accounts. The lane and the account are
 * applied by the server (`tier` / `inbox` on GET /api/email); the counts come
 * from one grouped query, not one request per lane.
 */

import type {
  EmailLaneCountsResponse,
  EmailListItem,
  EmailListResponse,
  EmailThreadListResponse,
  EmailThreadRow,
  InboxesResponse,
} from "@klorn/contract";
import {
  type InfiniteData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { apiFetch } from "../../../lib/api";
import { queryKeys } from "../../../lib/query-keys";
import { captureClientError } from "../../../lib/sentry";
import { type AccountOption, accountOptions, type ListView, listRequestPath } from "./model";

/** Matches the API's page size; a full page means there may be another. */
const PAGE_SIZE = 50;
/** Safety net behind the WebSocket: refetch while the tab is visible. */
const LIST_POLL_MS = 30_000;
const COUNTS_STALE_MS = 30_000;
const INBOXES_STALE_MS = 5 * 60 * 1000;

interface ListPage {
  emails: EmailListItem[];
  threads: EmailThreadRow[];
  source: "gmail" | "demo";
  total: number;
  page: number;
}

type ListData = InfiniteData<ListPage, number>;

const NO_PAGES: ListPage[] = [];

/** Under `queryKeys.email.all`, so every existing invalidation reaches v2 too. */
const v2Keys = {
  list: (view: ListView) => [...queryKeys.email.all, "v2", "list", view] as const,
  laneCounts: (account: string) => [...queryKeys.email.all, "v2", "lane-counts", account] as const,
};

async function fetchPage(view: ListView, page: number): Promise<ListPage> {
  const path = listRequestPath(view, page);
  try {
    if (view.filter === "threads") {
      const data = await apiFetch<EmailThreadListResponse>(path);
      return { emails: [], threads: data.threads, source: data.source, total: data.total, page };
    }
    const data = await apiFetch<EmailListResponse>(path);
    return { emails: data.emails, threads: [], source: data.source, total: data.total, page };
  } catch (err) {
    captureClientError(err, { scope: "email.v2.load", lane: view.lane, page });
    throw err;
  }
}

export function useMailList(view: ListView) {
  const queryClient = useQueryClient();
  const { lane, account, filter, search } = view;
  // A stable object per view, so the query key and the callbacks below only
  // change when the view does.
  const key = useMemo(
    () => v2Keys.list({ lane, account, filter, search }),
    [lane, account, filter, search],
  );

  const inboxesQuery = useQuery({
    queryKey: queryKeys.email.inboxes(),
    queryFn: () => apiFetch<InboxesResponse>("/api/email/inboxes"),
    staleTime: INBOXES_STALE_MS,
  });
  const accounts: AccountOption[] = useMemo(
    () => accountOptions(inboxesQuery.data?.inboxes ?? []),
    [inboxesQuery.data],
  );

  const countsQuery = useQuery({
    queryKey: v2Keys.laneCounts(account),
    queryFn: () => {
      const query = account === "all" ? "" : `?inbox=${encodeURIComponent(account)}`;
      return apiFetch<EmailLaneCountsResponse>(`/api/email/lane-counts${query}`);
    },
    staleTime: COUNTS_STALE_MS,
  });

  const listQuery = useInfiniteQuery({
    queryKey: key,
    refetchInterval: LIST_POLL_MS,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => fetchPage({ lane, account, filter, search }, pageParam),
    getNextPageParam: (last) => (last.page * PAGE_SIZE < last.total ? last.page + 1 : undefined),
  });

  // New mail is announced over the WebSocket (NotificationBell bridges it to
  // this window event): refetch the list and the counts, no manual sync.
  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.email.all });
    window.addEventListener("conversations-updated", refresh);
    return () => window.removeEventListener("conversations-updated", refresh);
  }, [queryClient]);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.email.all }),
    [queryClient],
  );

  /**
   * Optimistic write to the rows on screen. Cancels the in-flight poll first
   * so a stale response cannot land on top; returns the snapshot to restore.
   */
  const patchRows = useCallback(
    (update: (rows: EmailListItem[]) => EmailListItem[]): ListData | undefined => {
      void queryClient.cancelQueries({ queryKey: key }, { revert: false });
      const snapshot = queryClient.getQueryData<ListData>(key);
      queryClient.setQueryData<ListData>(key, (prev) =>
        prev
          ? { ...prev, pages: prev.pages.map((page) => ({ ...page, emails: update(page.emails) })) }
          : prev,
      );
      return snapshot;
    },
    [queryClient, key],
  );

  const restoreRows = useCallback(
    (snapshot: ListData | undefined) => queryClient.setQueryData(key, snapshot),
    [queryClient, key],
  );

  const pages = listQuery.data?.pages ?? NO_PAGES;
  return {
    emails: useMemo(() => pages.flatMap((page) => page.emails), [pages]),
    threads: useMemo(() => pages.flatMap((page) => page.threads), [pages]),
    total: pages[pages.length - 1]?.total ?? 0,
    isDemo: pages[0]?.source === "demo",
    loading: listQuery.isLoading,
    /** The first load failed: there is nothing to show but the error. */
    failed: listQuery.isError && pages.length === 0,
    retry: () => void listQuery.refetch(),
    hasMore: listQuery.hasNextPage,
    loadingMore: listQuery.isFetchingNextPage,
    loadMore: () => void listQuery.fetchNextPage(),
    counts: countsQuery.data?.counts ?? null,
    accounts,
    refresh,
    patchRows,
    restoreRows,
  };
}

export type MailList = ReturnType<typeof useMailList>;
