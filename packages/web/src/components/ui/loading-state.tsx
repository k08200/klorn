import { useT } from "../../lib/i18n";

interface LoadingStateProps {
  /** How many skeleton rows to show. */
  rows?: number;
  /** Visual height of each row in Tailwind classes (e.g. "h-20"). */
  rowHeight?: string;
  /** What is loading, for screen readers. Defaults to the localized "Loading". */
  label?: string;
}

/**
 * Shimmer skeleton list — replaces the per-page
 * `<div className="h-20 animate-pulse rounded-xl border border-stone-800 ..." />`
 * pattern that appeared in 6+ pages.
 */
export default function LoadingState({ rows = 3, rowHeight = "h-20", label }: LoadingStateProps) {
  const { t } = useT();
  const spoken = label ?? t("common.loading");
  return (
    <div role="status" aria-label={spoken} aria-live="polite" className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className={`${rowHeight} motion-safe:animate-pulse rounded-xl border border-line bg-surface-hover`}
        />
      ))}
      <span className="sr-only">{spoken}</span>
    </div>
  );
}
