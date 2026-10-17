"use client";

/**
 * The frames every Today block shares (design detail pass W1, TodayScreen.dc):
 *
 *   lane  the header (LaneChip, what the lane holds, the thread count) sits on
 *         the canvas and the rows sit in a card under it.
 *   card  a rail card (Calendar, Assistant, Files): the heading and its
 *         trailing "Open" link inside the card.
 *
 * Plus the per-block loading and error bodies.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import Button from "../../components/ui/button";
import { MailRowSkeleton, Skeleton, SkeletonGroup } from "../../components/ui/skeleton";
import { useT } from "../../lib/i18n";

/** The card surface: 12px radius, a hairline ring and a contact shadow. */
export const CARD_CLASS =
  "overflow-hidden rounded-xl bg-surface-panel shadow-[0_1px_2px_rgb(10_14_20/0.04)] ring-1 ring-line";

interface TodayBlockProps {
  /** Id of the heading; the region is named by it. */
  headingId: string;
  /** The heading's content (h2). */
  title: ReactNode;
  /** One muted phrase after the title, e.g. what a lane holds. */
  hint?: string;
  /** Right-aligned figure, e.g. how many threads the lane holds. */
  count?: number | null;
  /** Visible form of the count ("2 threads"); the bare figure when absent. */
  countLabel?: string;
  /** Trailing link or control. */
  action?: ReactNode;
  /** `lane`: header on the canvas, body in a card. `card`: all of it in one card. */
  layout?: "lane" | "card";
  children: ReactNode;
  className?: string;
}

function CountLabel({ count, countLabel }: Pick<TodayBlockProps, "count" | "countLabel">) {
  if (typeof count !== "number") return null;
  return <p className="shrink-0 text-caption tabular-nums text-ink-muted">{countLabel ?? count}</p>;
}

export function TodayBlock(props: TodayBlockProps) {
  const { headingId, title, hint, count, countLabel, action, children, className = "" } = props;
  if (props.layout === "card") {
    return (
      <section
        aria-labelledby={headingId}
        className={`${CARD_CLASS} flex min-w-0 flex-col gap-3 p-[18px] pb-3.5 ${className}`}
      >
        <div className="flex min-h-6 items-center gap-2">
          <h2
            id={headingId}
            className="flex min-w-0 items-center gap-2 text-body font-semibold text-ink"
          >
            {title}
          </h2>
          {hint && <p className="min-w-0 truncate text-caption text-ink-muted">{hint}</p>}
          <span className="flex-1" />
          <CountLabel count={count} countLabel={countLabel} />
          {action}
        </div>
        {children}
      </section>
    );
  }
  return (
    <section aria-labelledby={headingId} className={`flex min-w-0 flex-col gap-2.5 ${className}`}>
      <div className="flex min-h-6 items-center gap-2.5">
        <h2 id={headingId} className="flex min-w-0 shrink-0 items-center gap-2 text-head text-ink">
          {title}
        </h2>
        {hint && <p className="min-w-0 truncate text-label font-normal text-ink-muted">{hint}</p>}
        <span className="flex-1" />
        <CountLabel count={count} countLabel={countLabel} />
        {action}
      </div>
      <div className={CARD_CLASS}>{children}</div>
    </section>
  );
}

/** A rail card's trailing "Open" link: 12/500 accent, padded to a 32px target. */
export function RailOpenLink({ href, label }: { href: string; label?: string }) {
  const { t } = useT();
  return (
    <Link
      href={href}
      className="focus-ring -my-1.5 inline-flex min-h-8 items-center rounded-control px-1 text-caption font-medium text-accent-deep hover:underline pointer-coarse:min-h-11"
    >
      {label ?? t("today.rail.open")}
    </Link>
  );
}

/** The last row of a lane card: "11 more in Queue →", opening Mail. */
export function LaneMoreLink({
  href,
  onClick,
  children,
}: {
  href: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="focus-ring flex h-10 items-center justify-between border-t border-line-soft px-[18px] text-label text-ink-soft transition-colors duration-120 ease-fluid hover:bg-surface-raised focus-visible:-outline-offset-2 pointer-coarse:h-11"
    >
      {children}
      <span aria-hidden="true" className="text-ink-muted">
        →
      </span>
    </Link>
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
export function BlockNote({ children, inset = false }: { children: ReactNode; inset?: boolean }) {
  return (
    <p className={`py-3 text-body text-ink-muted [word-break:keep-all] ${inset ? "px-4" : ""}`}>
      {children}
    </p>
  );
}

/** A block's own failure: says what could not load and offers one retry. */
export function BlockError({
  message,
  onRetry,
  inset = false,
}: {
  message: string;
  onRetry: () => void;
  inset?: boolean;
}) {
  const { t } = useT();
  return (
    <div role="alert" className={`flex flex-wrap items-center gap-x-3 py-1 ${inset ? "px-4" : ""}`}>
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
    // Same frame and dividers as the rows it stands in for, so nothing shifts.
    <SkeletonGroup label={label} className="divide-y divide-line-soft">
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
