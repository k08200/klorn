/**
 * "Load more" and focus (WCAG 2.4.3) — the pure part. Pressing the button
 * marks where the new items will start. Once they are on screen and no more
 * pages remain (the button is gone), focus may move to the first of them.
 * The marker is spent then, and dropped when the load ends with nothing new
 * (it failed) or the list changes under it (another search or folder), so a
 * later, unrelated growth never moves focus.
 */

export interface LoadMarker {
  /** The first new item's index, while a page is on its way. */
  readonly from: number | null;
  /** The load was seen running: its end without new items is a failure. */
  readonly sawLoading: boolean;
}

export interface LoadObservation {
  count: number;
  loading: boolean;
  hasMore: boolean;
}

export function initialMarker(): LoadMarker {
  return { from: null, sawLoading: false };
}

export function markLoad(_marker: LoadMarker, count: number): LoadMarker {
  return { from: count, sawLoading: false };
}

/** The marker after a render, and where focus goes (null: nowhere). */
export function observeLoad(
  marker: LoadMarker,
  seen: LoadObservation,
): { marker: LoadMarker; focusFrom: number | null } {
  const { from } = marker;
  if (from === null) return { marker, focusFrom: null };
  if (seen.count > from) {
    return { marker: initialMarker(), focusFrom: seen.hasMore ? null : from };
  }
  if (seen.loading) return { marker: { from, sawLoading: true }, focusFrom: null };
  if (marker.sawLoading) return { marker: initialMarker(), focusFrom: null };
  return { marker, focusFrom: null };
}
