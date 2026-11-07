"use client";

/**
 * SegmentedControl (productization plan §1/§3, P5) — one choice out of a few,
 * always visible; Mail's lane control is the first user.
 *
 * Semantics: a radiogroup. One tab stop (the checked segment, or the first one
 * when none is checked); Left/Right/Up/Down move and select, Home/End jump to
 * the ends. Handled arrow keys are `preventDefault`ed so the app hotkeys never
 * see them. Drawn as one segmented track (design detail pass X3, Reader.dc):
 * 30px segments on a 36px well, the checked one lifted onto the panel; 44px
 * tall on a coarse pointer (WCAG 2.5.8). A segment is never narrower than
 * its label and count (flex-basis auto, no shrink: the 44px coarse-pointer
 * floor replaces min-w-fit, so a 0% basis would let a label spill into its
 * neighbour). When the row is wider than its column — a phone, or the mail
 * split's list — it scrolls horizontally inside itself, snapping to
 * segments; the page never does, and the checked segment is kept in view.
 * An edge with more segments past it fades out (globals.css,
 * .segmented-track), so a lane scrolled out of sight still reads as there.
 */

import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

export interface Segment<Id extends string> {
  id: Id;
  label: string;
  /** Decorative mark before the label (a lane dot). */
  leading?: ReactNode;
  /** Shown after the label when above zero. */
  count?: number;
  /** Full spoken name when the count needs words ("PUSH, 3 unread"). */
  ariaLabel?: string;
  /** Hover text saying what the count is ("3 unread in PUSH"). */
  title?: string;
  /** Text colour while checked (a lane's chip ink); ink when absent. */
  checkedClass?: string;
}

interface SegmentedControlProps<Id extends string> {
  segments: ReadonlyArray<Segment<Id>>;
  /** The checked segment; null when the current view is none of them. */
  value: Id | null;
  onChange: (id: Id) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

function targetIndex(key: string, from: number, length: number): number | null {
  if (NEXT_KEYS.has(key)) return (from + 1) % length;
  if (PREV_KEYS.has(key)) return (from - 1 + length) % length;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return null;
}

/** A sub-pixel tolerance, so a row that just fits never reads as scrollable. */
const EDGE_SLACK_PX = 1;

interface Overflow {
  start: boolean;
  end: boolean;
}

/** Whether the row has segments hidden past its start and end edges. */
function useOverflow(ref: RefObject<HTMLDivElement | null>): Overflow {
  const [overflow, setOverflow] = useState<Overflow>({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const start = el.scrollLeft > EDGE_SLACK_PX;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - EDGE_SLACK_PX;
      setOverflow((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [ref]);
  return overflow;
}

export function SegmentedControl<Id extends string>({
  segments,
  value,
  onChange,
  ariaLabel,
  disabled = false,
  className = "",
}: SegmentedControlProps<Id>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const checkedIndex = segments.findIndex((segment) => segment.id === value);
  const tabStop = checkedIndex >= 0 ? checkedIndex : 0;
  const overflow = useOverflow(groupRef);

  // Keep the checked segment in view when the row scrolls, centred so a
  // neighbour shows on each side that has one. The row scrolls itself only:
  // scrollIntoView would also move every scrolling ancestor.
  useEffect(() => {
    const row = groupRef.current;
    if (value === null || !row) return;
    const checked = row.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!checked) return;
    const rowBox = row.getBoundingClientRect();
    const box = checked.getBoundingClientRect();
    row.scrollLeft += box.left - rowBox.left - (rowBox.width - box.width) / 2;
  }, [value]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey) return;
    const to = targetIndex(event.key, tabStop, segments.length);
    if (to === null) return;
    event.preventDefault();
    onChange(segments[to].id);
    groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      data-more-start={overflow.start || undefined}
      data-more-end={overflow.end || undefined}
      className={`segmented-track flex min-w-0 snap-x snap-proximity items-center gap-0.5 overflow-x-auto rounded-[10px] bg-surface-hover p-[3px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
    >
      {segments.map((segment, index) => {
        const checked = index === checkedIndex;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a segment is a styled capsule with a count and a roving tab stop; a native radio input cannot hold that content
          <button
            key={segment.id}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={segment.ariaLabel}
            title={segment.title}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(segment.id)}
            className={`group/segment focus-ring flex h-[30px] min-w-fit pointer-coarse:min-w-11 grow shrink-0 basis-auto snap-start cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-role-caption transition-colors duration-120 ease-fluid disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11 ${
              checked
                ? `bg-surface-panel font-semibold ring-1 ring-line ${segment.checkedClass ?? "text-ink"}`
                : "font-medium text-ink-soft hover:text-ink"
            }`}
          >
            <span className="contents">
              {segment.leading}
              {segment.label}
              {segment.count !== undefined && segment.count > 0 && (
                <span className="tabular-nums">{segment.count}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
