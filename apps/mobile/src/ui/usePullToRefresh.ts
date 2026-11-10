/**
 * Pull-to-refresh on a scroll container (canvas: "당겨서 새로고침 → 모든 계정
 * 동기화"). Touch only; starts when the container is scrolled to the top.
 * Returns the pull distance (for the indicator) and the refreshing flag.
 */
import { type RefObject, useEffect, useRef, useState } from "react";

export const PULL_THRESHOLD = 64;
const MAX_PULL = 96;

export function usePullToRefresh(
  ref: RefObject<HTMLElement | null>,
  onRefresh: () => Promise<unknown>,
): { pull: number; refreshing: boolean } {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const start = useRef<number | null>(null);
  const pullRef = useRef(0);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onStart = (e: TouchEvent) => {
      start.current =
        el.scrollTop <= 0 && e.touches.length === 1 ? (e.touches[0]?.clientY ?? null) : null;
    };
    const onMove = (e: TouchEvent) => {
      if (start.current === null) return;
      const dy = (e.touches[0]?.clientY ?? 0) - start.current;
      if (dy <= 0) {
        pullRef.current = 0;
        setPull(0);
        return;
      }
      // Rubber-band: half the finger travel, capped.
      const next = Math.min(MAX_PULL, dy * 0.5);
      pullRef.current = next;
      setPull(next);
      if (e.cancelable && el.scrollTop <= 0) e.preventDefault();
    };
    const onEnd = () => {
      if (start.current === null) return;
      start.current = null;
      const reached = pullRef.current >= PULL_THRESHOLD;
      pullRef.current = 0;
      setPull(0);
      if (!reached) return;
      setRefreshing(true);
      void refreshRef
        .current()
        .catch(() => {})
        .finally(() => setRefreshing(false));
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [ref]);

  return { pull, refreshing };
}
