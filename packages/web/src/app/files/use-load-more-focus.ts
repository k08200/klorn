"use client";

/**
 * "Load more" disappears with the last page, and focus would fall to <body>
 * with it (WCAG 2.4.3). Once the new items are on screen, focus moves to the
 * first of them; but only when focus did fall (the person may have moved on
 * while the page loaded), and not while the button is still there to keep it.
 */

import { type RefObject, useEffect, useRef } from "react";
import { focusItemFrom } from "./focus";

export function useLoadMoreFocus(
  count: number,
  hasMore: boolean,
  containerRef: RefObject<HTMLElement | null>,
  itemSelector: string,
) {
  // The first new item's index, while a page is on its way.
  const from = useRef<number | null>(null);

  useEffect(() => {
    const at = from.current;
    if (at === null || count <= at) return;
    from.current = null;
    if (hasMore) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    focusItemFrom(containerRef.current, itemSelector, at);
  }, [count, hasMore, containerRef, itemSelector]);

  /** Wraps the list's own loadMore. */
  return (loadMore: () => void) => () => {
    from.current = count;
    loadMore();
  };
}
