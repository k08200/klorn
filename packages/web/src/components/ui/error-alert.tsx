import type { ReactNode } from "react";

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
 * `rounded-lg border border-red-900/60 bg-red-950/30 ...` block.
 *
 * Audited 2026-05-19: at least 8 pages reimplemented this from scratch.
 */
export default function ErrorAlert({
  title = "Something went wrong",
  children,
  onRetry,
  variant = "inline",
  className,
}: ErrorAlertProps) {
  return (
    <div
      role="alert"
      className={[
        "rounded-xl border border-red-900/60 bg-red-950/30 text-red-200",
        variant === "block" ? "px-5 py-4" : "px-4 py-3 text-sm",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <p className="font-medium text-red-100">{title}</p>
      <div className="mt-1 text-red-200/90">{children}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 inline-flex items-center rounded-md border border-red-700/60 px-3 py-1.5 text-xs font-medium text-red-100 hover:bg-red-900/40"
        >
          Try again
        </button>
      )}
    </div>
  );
}
