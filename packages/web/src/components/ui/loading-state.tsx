interface LoadingStateProps {
  /** How many skeleton rows to show. */
  rows?: number;
  /** Visual height of each row in Tailwind classes (e.g. "h-20"). */
  rowHeight?: string;
  /** Optional aria-label for screen readers. */
  label?: string;
}

/**
 * Shimmer skeleton list — replaces the per-page
 * `<div className="h-20 animate-pulse rounded-xl border border-stone-800 ..." />`
 * pattern that appeared in 6+ pages.
 */
export default function LoadingState({
  rows = 3,
  rowHeight = "h-20",
  label = "Loading",
}: LoadingStateProps) {
  return (
    <div role="status" aria-label={label} aria-live="polite" className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className={`${rowHeight} animate-pulse rounded-xl border border-stone-800 bg-stone-900/30`}
        />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}
