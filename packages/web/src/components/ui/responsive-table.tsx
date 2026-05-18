import type { ReactNode } from "react";

interface ResponsiveTableProps {
  children: ReactNode;
  className?: string;
}

/**
 * Wraps wide tables so they horizontally scroll on small viewports
 * instead of overflowing the body. Tables with `min-w-[Xpx]` styles
 * (audited 2026-05-19 in /settings/usage) were breaking layouts on
 * phones because no scroll container surrounded them.
 *
 * Pair with a `<table className="min-w-[640px]">` inside to keep
 * column widths usable while preventing page-level overflow.
 */
export default function ResponsiveTable({ children, className }: ResponsiveTableProps) {
  return (
    <div
      className={[
        "-mx-4 overflow-x-auto sm:mx-0",
        // momentum scroll on iOS so the gesture feels native
        "[-webkit-overflow-scrolling:touch]",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="min-w-full px-4 sm:px-0">{children}</div>
    </div>
  );
}
