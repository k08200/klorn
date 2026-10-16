import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";

interface ErrorAlertProps {
  /** Short summary shown as the alert title. Required. */
  title?: string;
  /** Detail body. Can be a string or rich content like an action button. */
  children: ReactNode;
  /** Optional retry handler — when provided a "Try again" button is rendered. */
  onRetry?: () => void;
  /** Visual density. `inline` is the default; `block` adds vertical breathing room. */
  variant?: "inline" | "block";
  className?: string;
}

/**
 * Shared error surface so every page does not invent its own
 * `rounded-lg border border-red-200 bg-red-50 ...` block.
 *
 * Those literals were light-theme values: on the dark panel this box painted
 * as a near-white slab with 2.7:1 text. It runs on --state-danger-* now, which
 * swaps with the theme (5.9:1 light / 9.1:1 dark) — measured 2026-08-23.
 *
 * Single error surface as of 2026-08-13 — all boxed inline reimplementations
 * were migrated to this component. New error boxes should use it directly
 * instead of hand-rolling the border/bg pattern again.
 * Relit for the light+sky v2 system 2026-07-22.
 */
export default function ErrorAlert({
  title,
  children,
  onRetry,
  variant = "inline",
  className,
}: ErrorAlertProps) {
  const { t } = useT();
  return (
    <div
      role="alert"
      className={[
        "rounded-xl border border-state-danger-line bg-state-danger-bg text-state-danger-ink",
        variant === "block" ? "px-5 py-4" : "px-4 py-3 text-sm",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <p className="font-medium text-state-danger-ink">{title ?? t("errorAlert.title")}</p>
      <div className="mt-1 text-state-danger-ink">{children}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ease-strong mt-3 inline-flex min-h-11 items-center rounded-md border border-state-danger-line bg-surface-panel px-3 py-1.5 text-xs font-medium text-state-danger-ink transition duration-150 hover:bg-state-danger-bg active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
        >
          {t("common.tryAgain")}
        </button>
      )}
    </div>
  );
}
