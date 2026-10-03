/**
 * Skeleton (productization plan §2, P2) — loading placeholders only, never an
 * empty state. Shapes are decorative (aria-hidden); wrap a set in
 * <SkeletonGroup> so assistive tech hears one "Loading" status instead.
 * The pulse runs only under `motion-safe`, so reduced-motion users get a
 * still placeholder (the global reduced-motion rule in globals.css backs
 * this up).
 */

import type { ReactNode } from "react";

type SkeletonVariant = "line" | "block" | "row";

interface SkeletonProps {
  variant?: SkeletonVariant;
  /** Width utility for `line` / `block` (e.g. "w-1/2"). */
  width?: string;
  /** Height utility for `block` (e.g. "h-24"). */
  height?: string;
  className?: string;
}

const SHAPE = "bg-surface-inset motion-safe:animate-pulse";

const VARIANT: Record<SkeletonVariant, string> = {
  // One line of body text: 14px glyph box inside a 21px line.
  line: "h-3.5 rounded-control",
  block: "rounded-card",
  row: "h-13 rounded-card max-md:h-16 pointer-coarse:h-16",
};

export function Skeleton({ variant = "line", width, height, className = "" }: SkeletonProps) {
  const size =
    variant === "row"
      ? "w-full"
      : `${width ?? "w-full"} ${variant === "block" ? (height ?? "h-24") : ""}`;
  return <div aria-hidden="true" className={`${SHAPE} ${VARIANT[variant]} ${size} ${className}`} />;
}

/** Placeholder matching MailRow's geometry (dot, sender, meta, subject line). */
export function MailRowSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex h-13 flex-col justify-center gap-2 px-3 max-md:h-16 pointer-coarse:h-16"
    >
      <div className="flex items-center gap-2">
        <span className="size-2 shrink-0" />
        <div className={`${SHAPE} h-3 w-32 rounded-control`} />
        <div className="flex-1" />
        <div className={`${SHAPE} h-4 w-14 rounded-full`} />
        <div className={`${SHAPE} h-3 w-10 rounded-control`} />
      </div>
      <div className="flex items-center gap-2 pl-4">
        <div className={`${SHAPE} h-3.5 w-1/3 rounded-control`} />
        <div className={`${SHAPE} h-3.5 flex-1 rounded-control opacity-60`} />
      </div>
    </div>
  );
}

interface SkeletonGroupProps {
  /** Spoken status, e.g. "Loading mail". */
  label?: string;
  children: ReactNode;
  className?: string;
}

export function SkeletonGroup({ label = "Loading", children, className = "" }: SkeletonGroupProps) {
  return (
    <div role="status" aria-live="polite" aria-label={label} className={className}>
      {children}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export default Skeleton;
