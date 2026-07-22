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
 * `rounded-lg border border-red-200 bg-red-50 ...` block.
 *
 * Audited 2026-05-19: at least 8 pages reimplemented this from scratch.
 * Relit for the light+sky v2 system 2026-07-22.
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
        "rounded-xl border border-red-200 bg-red-50 text-red-700",
        variant === "block" ? "px-5 py-4" : "px-4 py-3 text-sm",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <p className="font-medium text-red-700">{title}</p>
      <div className="mt-1 text-red-600">{children}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ease-strong mt-3 inline-flex min-h-11 items-center rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition duration-150 hover:bg-red-100 active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
        >
          Try again
        </button>
      )}
    </div>
  );
}
