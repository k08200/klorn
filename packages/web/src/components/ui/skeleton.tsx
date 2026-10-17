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
  // Mirrors MailRow's three lines (sender · subject · reason) and padding.
  return (
    <div aria-hidden="true" className="flex flex-col gap-[3px] py-3 pl-4 pr-[18px]">
      <div className="flex h-[18px] items-center gap-2">
        <div className={`${SHAPE} h-3 w-28 rounded-control`} />
        <div className={`${SHAPE} h-3.5 w-4 rounded-control opacity-60`} />
        <div className="flex-1" />
        <div className={`${SHAPE} h-3 w-10 rounded-control`} />
      </div>
      <div className="flex h-[22px] items-center">
        <div className={`${SHAPE} h-4 w-2/3 rounded-control`} />
      </div>
      <div className="flex h-4 items-center">
        <div className={`${SHAPE} h-3 w-2/5 rounded-control opacity-60`} />
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
    // Announced once: the status text is the only accessible content (no
    // aria-label on top of it, which some readers speak twice).
    <div role="status" aria-live="polite" className={className}>
      {children}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export default Skeleton;
