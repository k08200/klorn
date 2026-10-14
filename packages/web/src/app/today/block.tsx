"use client";

/**
 * The frame every Today block shares (productization plan §2, P6): a labelled
 * region with a one-line header (title, optional count and trailing link) over
 * its body, plus the per-block loading and error bodies. Blocks are flat on
 * the canvas and separated by a hairline — no cards — so three columns of
 * different content still read as one page.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import Button from "../../components/ui/button";
import { MailRowSkeleton, Skeleton, SkeletonGroup } from "../../components/ui/skeleton";
import { useT } from "../../lib/i18n";

interface TodayBlockProps {
  /** Id of the heading; the region is named by it. */
  headingId: string;
  /** The heading's content (h2). */
  title: ReactNode;
  /** One muted phrase after the title, e.g. what a lane holds. */
  hint?: string;
  /** Right-aligned figure, e.g. how many mails the lane holds. */
  count?: number | null;
  /** Spoken form of the count ("3 mails"). */
  countLabel?: string;
  /** Trailing link or control. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function TodayBlock(props: TodayBlockProps) {
  const { headingId, title, hint, count, countLabel, action, children, className = "" } = props;
  return (
    <section aria-labelledby={headingId} className={`min-w-0 ${className}`}>
      <div className="flex min-h-11 items-center gap-2 border-b border-line">
        <h2 id={headingId} className="flex min-w-0 items-center gap-2 text-head text-ink">
          {title}
        </h2>
        {hint && <p className="min-w-0 truncate text-label font-normal text-ink-muted">{hint}</p>}
        <span className="flex-1" />
        {typeof count === "number" && (
          <p className="text-label tabular-nums text-ink-soft">
            <span aria-hidden={countLabel ? "true" : undefined}>{count}</span>
            {countLabel && <span className="sr-only">{countLabel}</span>}
          </p>
        )}
        {action}
      </div>
      {children}
    </section>
  );
}

const LINK_CLASS =
  "focus-ring inline-flex min-h-11 items-center gap-1 rounded-control text-label text-accent-deep hover:underline";

/** A text link with a 44px target, for "Open calendar" and "N more in Mail". */
export function BlockLink({
  href,
  onClick,
  children,
  className = "",
}: {
  href: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link href={href} onClick={onClick} className={`${LINK_CLASS} ${className}`}>
      {children}
      <Chevron />
    </Link>
  );
}

export function Chevron() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}

/** One quiet line for a block that has nothing in it. Not an error. */
export function BlockNote({ children }: { children: ReactNode }) {
  return <p className="py-3 text-body text-ink-muted [word-break:keep-all]">{children}</p>;
}

/** A block's own failure: says what could not load and offers one retry. */
export function BlockError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useT();
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 py-1">
      <p className="min-w-0 flex-1 py-2 text-body text-state-danger-ink [word-break:keep-all]">
        {message}
      </p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {t("today.retry")}
      </Button>
    </div>
  );
}

const ROW_KEYS = ["a", "b", "c", "d", "e"];

export function MailRowsSkeleton({ rows, label }: { rows: number; label: string }) {
  return (
    // Same bleed as the rows it stands in for, so nothing shifts on load.
    <SkeletonGroup label={label} className="-mx-3 pt-1">
      {ROW_KEYS.slice(0, rows).map((key) => (
        <MailRowSkeleton key={key} />
      ))}
    </SkeletonGroup>
  );
}

export function LinesSkeleton({ lines, label }: { lines: number; label: string }) {
  const widths = ["w-full", "w-11/12", "w-4/5", "w-2/3", "w-1/2"];
  return (
    <SkeletonGroup label={label} className="flex flex-col gap-2 py-3">
      {ROW_KEYS.slice(0, lines).map((key, index) => (
        <Skeleton key={key} width={widths[index % widths.length]} />
      ))}
    </SkeletonGroup>
  );
}
