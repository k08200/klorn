"use client";

/**
 * "Load more" disappears with the last page, and focus would fall to <body>
 * with it (WCAG 2.4.3). Once the new items are on screen, focus moves to the
 * first of them; but only when focus did fall (the person may have moved on
 * while the page loaded), and not while the button is still there to keep it.
 * The marker is dropped when the load fails or the list changes (`listKey`):
 * load-more-marker.ts.
 */

import { type RefObject, useEffect, useRef } from "react";
import { focusItemFrom } from "./focus";
import { initialMarker, type LoadMarker, markLoad, observeLoad } from "./load-more-marker";

interface LoadMoreFocusOptions {
  count: number;
  hasMore: boolean;
  /** A page is on its way. */
  loading: boolean;
  /** Changes with the list itself (the search, the folder): the marker goes. */
  listKey: string;
  containerRef: RefObject<HTMLElement | null>;
  itemSelector: string;
}

export function useLoadMoreFocus({
  count,
  hasMore,
  loading,
  listKey,
  containerRef,
  itemSelector,
}: LoadMoreFocusOptions) {
  const marker = useRef<LoadMarker>(initialMarker());

  // biome-ignore lint/correctness/useExhaustiveDependencies: it must run when the list changes
  useEffect(() => {
    marker.current = initialMarker();
  }, [listKey]);

  useEffect(() => {
    const seen = observeLoad(marker.current, { count, loading, hasMore });
    marker.current = seen.marker;
    if (seen.focusFrom === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    focusItemFrom(containerRef.current, itemSelector, seen.focusFrom);
  }, [count, hasMore, loading, containerRef, itemSelector]);

  /** Wraps the list's own loadMore. */
  return (loadMore: () => void) => () => {
    marker.current = markLoad(marker.current, count);
    loadMore();
  };
}
