/**
 * MailRow — the thread-aware three-line row (design detail pass, signature
 * detail 4; Row.dc / TodayScreen.dc canvas), shared by Today and Mail. Pure
 * presentation: props in, callbacks out.
 *
 *   line 1  unread dot · sender 13/500 dim · thread count chip · SourceBadge ·
 *           LaneChip (only where the list is not already one lane) · time
 *   line 2  subject 15/600 (14/600 in the compact split-view list)
 *   line 3  why it is in its lane, 12/500 in the lane's chip ink — or, when no
 *           reason was recorded, the snippet in muted text on its own line
 *
 * An optional lane rail runs down the left edge: 2px for PUSH and MEETING,
 * 1px at 50% for QUEUE, INFO and SILENT, so the loud lanes read first.
 *
 * Semantics: the row body is ONE interactive element (a link with `href`, a
 * button with `onOpen`), so it gets a single tab stop and an accessible name
 * read in visual order. Trailing actions are siblings, never nested inside it,
 * and float as an overlay pill 12px from the right edge: they never reflow the
 * row (W6). They show on hover or keyboard focus and are not rendered visibly
 * under (hover: none); on touch, swipe and the reader carry the same actions.
 * An optional `leading` control (Mail's select checkbox) is a sibling too: it
 * sits over the unread dot, appears on hover / focus, and stays while
 * `leadingPinned`; the dot yields to it.
 */

import type { LiveTier, Tier } from "@klorn/contract";
import Link from "next/link";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { toLiveTier } from "../../lib/tiers";
import { LANE_INK_CLASS, LaneChip } from "./lane-chip";
import { SourceBadge, type SourceProvider } from "./source-badge";

export interface MailRowSource {
  provider: SourceProvider | (string & {});
  nickname?: string | null;
}

export interface MailRowProps {
  sender: string;
  subject: string;
  /** First line of the body; shown on line 3 only when there is no reason. */
  snippet?: string;
  /** Why the mail is in its lane (resolved tierReason), line 3 in lane ink. */
  reason?: string | null;
  /** Messages in this thread inside the list; a chip shows from 2. */
  threadCount?: number;
  /** The row's recorded lane: colours the reason and the rail. */
  lane?: Tier | null;
  /** Draw the lane rail on the left edge (Today's lane cards). */
  rail?: boolean;
  /** The split-view list: 14px subject instead of 15px. */
  compact?: boolean;
  /** Display time, already formatted by the caller ("09:41", "Mon"). */
  time: string;
  /** Machine-readable time for <time dateTime>. */
  timeIso?: string;
  /** Recorded lane. Omit/null for no chip — never a guess. */
  tier?: Tier | null;
  /**
   * Shown in the chip's place while there is no recorded lane ("Sorting…").
   * A neutral, dashed capsule: it says the judge has not assigned a lane, and
   * never borrows a lane's colour. Ignored when `tier` is set.
   */
  tierPending?: string;
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
  /** A control over the unread dot (a select checkbox), shown on hover / focus-within. */
  leading?: ReactNode;
  /** Keep `leading` visible regardless of hover (a selection is in progress). */
  leadingPinned?: boolean;
  className?: string;
}

const BODY_CLASS =
  "focus-ring flex w-full min-w-0 flex-col gap-[3px] py-3 pr-[18px] text-left focus-visible:-outline-offset-2";

/** 2px for the lanes that interrupt, 1px at half strength for the rest. */
const RAIL_CLASS: Record<LiveTier, string> = {
  PUSH: "w-0.5 bg-tier-push-ink",
  MEETING: "w-0.5 bg-tier-meeting-ink",
  QUEUE: "w-px bg-tier-queue-ink/50",
  INFO: "w-px bg-tier-info-ink/50",
  SILENT: "w-px bg-tier-silent-ink/50",
};

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

function ThreadCount({ count }: { count: number }) {
  const { t } = useT();
  return (
    <span className="shrink-0 rounded-control bg-surface-hover px-1.5 text-caption font-semibold tabular-nums text-ink-soft">
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{t("mailRow.threadCount", { count: String(count) })}</span>
    </span>
  );
}

function MetaLine(props: MailRowProps) {
  const { t } = useT();
  const { sender, time, timeIso, tier, source, unread, hasAttachment, tierPending } = props;
  // The dot gives way to the leading control wherever that control is showing.
  const dotYields = !props.leading
    ? ""
    : props.leadingPinned
      ? "opacity-0"
      : "group-focus-within:opacity-0 group-hover:opacity-0";
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className={`-ml-2.5 size-1.5 shrink-0 rounded-full ${unread ? "bg-accent-solid" : "bg-transparent"} ${dotYields}`}
      />
      {unread && <span className="sr-only">{t("mailRow.unread")}</span>}
      <span className="min-w-0 truncate text-label text-ink-soft">{sender}</span>
      {(props.threadCount ?? 0) > 1 && <ThreadCount count={props.threadCount ?? 0} />}
      {source && <SourceBadge provider={source.provider} nickname={source.nickname} />}
      {tier && <LaneChip tier={tier} />}
      {!tier && tierPending && (
        <span className="shrink-0 rounded-full border border-dashed border-line-strong px-2 py-px text-caption text-ink-muted">
          {tierPending}
        </span>
      )}
      {hasAttachment && (
        <>
          <PaperclipGlyph />
          <span className="sr-only">{t("mailRow.hasAttachment")}</span>
        </>
      )}
      <span className="flex-1" />
      <time dateTime={timeIso} className="shrink-0 text-caption tabular-nums text-ink-muted">
        {time}
      </time>
    </span>
  );
}

function RowContent(props: MailRowProps) {
  const { subject, snippet, reason, compact } = props;
  const lane = props.lane ? toLiveTier(props.lane) : null;
  return (
    <>
      <MetaLine {...props} />
      <span
        className={`min-w-0 truncate text-ink ${compact ? "text-body font-semibold" : "text-head tracking-[-0.005em]"}`}
      >
        {subject}
      </span>
      {reason ? (
        <span
          className={`min-w-0 truncate text-caption font-medium ${lane ? LANE_INK_CLASS[lane] : "text-ink-mid"}`}
        >
          {reason}
        </span>
      ) : snippet ? (
        <span className="min-w-0 truncate text-caption text-ink-muted">{snippet}</span>
      ) : null}
    </>
  );
}

const OVERLAY_CLASS =
  "pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-[10px] bg-surface-panel p-1 opacity-0 shadow-l2 ring-1 ring-line-strong transition-opacity duration-120 ease-fluid group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 [@media(hover:none)]:hidden";

export function MailRow(props: MailRowProps) {
  const { href, onOpen, selected = false, actions, leading, className = "" } = props;
  const lane = props.lane ? toLiveTier(props.lane) : null;
  const current = selected ? ("true" as const) : undefined;
  // A leading checkbox gets its own gutter so it never sits on the sender.
  const bodyClass = `${BODY_CLASS} ${leading ? "pl-9 pointer-coarse:pl-11" : "pl-4"}`;
  return (
    <div
      className={`group relative transition-colors duration-120 ease-fluid ${
        selected ? "bg-accent-solid/6" : "hover:bg-surface-raised focus-within:bg-surface-raised"
      } ${className}`}
    >
      {selected ? (
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-accent-solid" />
      ) : (
        props.rail &&
        lane && (
          <span aria-hidden="true" className={`absolute inset-y-0 left-0 ${RAIL_CLASS[lane]}`} />
        )
      )}
      {href ? (
        <Link href={href} aria-current={current} className={bodyClass}>
          <RowContent {...props} />
        </Link>
      ) : (
        <button type="button" onClick={onOpen} aria-current={current} className={bodyClass}>
          <RowContent {...props} />
        </button>
      )}
      {leading && (
        <div
          // Centred on the first line (12px padding + its 18px line height).
          className={`absolute left-0 top-0 flex h-[42px] items-center ${
            props.leadingPinned
              ? ""
              : "pointer-events-none opacity-0 transition-opacity duration-120 ease-fluid group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
          }`}
        >
          {leading}
        </div>
      )}
      {actions && <div className={OVERLAY_CLASS}>{actions}</div>}
    </div>
  );
}

export default MailRow;
