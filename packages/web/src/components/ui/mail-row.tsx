/**
 * MailRow — the ListRow recipe (productization plan §1/§2, P2), shared later
 * by Today, Mail and Approvals. Pure presentation: props in, callbacks out.
 *
 * One-badge rule: a row carries sender, subject, a one-line snippet, time,
 * LaneChip, SourceBadge, unread dot and attachment glyph — nothing else.
 * Needs-reply, category and why-this-lane belong in the reader header.
 *
 * Semantics: the row body is ONE interactive element (a link with `href`, a
 * button with `onOpen`), so it gets a single tab stop and an accessible name
 * read in visual order. Trailing actions are siblings, never nested inside it
 * (nested interactive content is invalid), revealed on hover or keyboard focus.
 * While hidden they are pointer-events-none, so a tap on the time or chips
 * opens the row instead of hitting an invisible action. Tailwind v4 `hover:`
 * variants only apply under @media (hover: hover), so on touch the actions
 * are reachable by focus only; swipe actions arrive with P10.
 * Height is 52px with a fine pointer and 64px on touch / narrow viewports.
 * Weight carries read state: an unread row's sender and subject are semibold,
 * a read row's are regular, so a list of read mail does not read as all-bold.
 * The time has a fixed right-aligned column so the badges before it line up.
 */

import type { Tier } from "@klorn/contract";
import Link from "next/link";
import type { ReactNode } from "react";
import { LaneChip } from "./lane-chip";
import { SourceBadge, type SourceProvider } from "./source-badge";

export interface MailRowSource {
  provider: SourceProvider | (string & {});
  nickname?: string | null;
}

export interface MailRowProps {
  sender: string;
  subject: string;
  /** First line of the body; truncated to one line. */
  snippet?: string;
  /** Display time, already formatted by the caller ("09:41", "Mon"). */
  time: string;
  /** Machine-readable time for <time dateTime>. */
  timeIso?: string;
  /** Recorded lane. Omit/null for no chip — never a guess. */
  tier?: Tier | null;
  source?: MailRowSource | null;
  unread?: boolean;
  hasAttachment?: boolean;
  selected?: boolean;
  /** Navigate on activation (renders a link)… */
  href?: string;
  /** …or handle activation (renders a button). */
  onOpen?: () => void;
  /** Trailing actions, shown on hover / focus-within. Use ui/button. */
  actions?: ReactNode;
  className?: string;
}

const BODY_CLASS =
  "focus-ring flex h-13 w-full min-w-0 flex-col justify-center gap-0.5 rounded-card px-3 text-left max-md:h-16 pointer-coarse:h-16";

function PaperclipGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 text-ink-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13.5 7.5 8.2 12.8a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.7 11.3a1.1 1.1 0 0 1-1.5-1.5l5-5" />
    </svg>
  );
}

function RowContent(props: MailRowProps) {
  const { sender, subject, snippet, time, timeIso, tier, source, unread, hasAttachment } = props;
  return (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${unread ? "bg-accent-solid" : "bg-transparent"}`}
        />
        {unread && <span className="sr-only">Unread, </span>}
        <span
          className={`min-w-0 flex-1 truncate text-label ${unread ? "font-semibold text-ink" : "text-ink-soft"}`}
        >
          {sender}
        </span>
        {hasAttachment && (
          <>
            <PaperclipGlyph />
            <span className="sr-only">, has attachment</span>
          </>
        )}
        {source && <SourceBadge provider={source.provider} nickname={source.nickname} />}
        {tier && <LaneChip tier={tier} />}
        <time
          dateTime={timeIso}
          className="min-w-16 shrink-0 text-right text-caption tabular-nums text-ink-muted"
        >
          {time}
        </time>
      </span>
      <span className="flex min-w-0 items-baseline gap-2 pl-4">
        <span
          className={`shrink-0 truncate text-head ${unread ? "text-ink" : "font-normal text-ink-strong"} max-w-[60%]`}
        >
          {subject}
        </span>
        {snippet && (
          <span className="min-w-0 flex-1 truncate text-body text-ink-muted">{snippet}</span>
        )}
      </span>
    </>
  );
}

export function MailRow(props: MailRowProps) {
  const { href, onOpen, selected = false, actions, className = "" } = props;
  const current = selected ? ("true" as const) : undefined;
  return (
    <div
      className={`group relative rounded-card transition-colors duration-120 ease-fluid ${
        selected ? "bg-state-info-bg" : "hover:bg-surface-hover focus-within:bg-surface-hover"
      } ${className}`}
    >
      {href ? (
        <Link href={href} aria-current={current} className={BODY_CLASS}>
          <RowContent {...props} />
        </Link>
      ) : (
        <button type="button" onClick={onOpen} aria-current={current} className={BODY_CLASS}>
          <RowContent {...props} />
        </button>
      )}
      {actions && (
        <div
          className={`pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1 pl-2 opacity-0 transition-opacity duration-120 ease-fluid group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 ${
            selected ? "bg-state-info-bg" : "bg-surface-hover"
          }`}
        >
          {actions}
        </div>
      )}
    </div>
  );
}

export default MailRow;
