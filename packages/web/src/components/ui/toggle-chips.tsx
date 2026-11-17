"use client";

/**
 * ToggleChips — one choice out of a row of chips that scrolls sideways inside
 * itself (never the page). The current chip is filled; an edge with chips
 * past it fades out (globals.css, .chip-track), so a chip scrolled out of
 * view still reads as there, and the current one is kept in view. A chip
 * draws 36px inside a 44px button (WCAG 2.5.8). Each chip is a toggle button
 * (aria-pressed) in a labelled group. First user: Mail's lane chips on a
 * phone (app/email/_v2/lane-chips.tsx).
 */

import { type ReactNode, useEffect, useRef } from "react";
import { useOverflow } from "./segmented-control";

export interface ToggleChip<Id extends string> {
  id: Id;
  /** What the chip shows: a dot, the label, a count. */
  content: ReactNode;
  /** Full spoken name when the face needs words ("Push, 5 mails"); must contain the label. */
  ariaLabel?: string;
}

interface ToggleChipsProps<Id extends string> {
  chips: ReadonlyArray<ToggleChip<Id>>;
  value: Id | null;
  onChange: (id: Id) => void;
  /** Names the group. */
  label: string;
  disabled?: boolean;
  /** Bleed the track to the page edges by the page's 16px gutter. */
  bleed?: boolean;
  className?: string;
  testId?: string;
}

const CHIP_FACE =
  "flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-role-label transition-colors duration-120 ease-fluid";

function chipFace(active: boolean): string {
  return active
    ? `${CHIP_FACE} bg-accent-solid font-semibold text-accent-solid-ink`
    : `${CHIP_FACE} border border-line-strong bg-surface-panel text-ink-soft group-hover/chip:bg-surface-hover`;
}

export function ToggleChips<Id extends string>({
  chips,
  value,
  onChange,
  label,
  disabled = false,
  bleed = false,
  className = "",
  testId,
}: ToggleChipsProps<Id>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const overflow = useOverflow(trackRef);

  // Keep the current chip in view; the row scrolls itself only.
  useEffect(() => {
    const track = trackRef.current;
    const chip = track?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (value === null || !track || !chip) return;
    const trackBox = track.getBoundingClientRect();
    const box = chip.getBoundingClientRect();
    if (box.left < trackBox.left || box.right > trackBox.right) {
      track.scrollLeft += box.left - trackBox.left - (trackBox.width - box.width) / 2;
    }
  }, [value]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle chips; <fieldset> would need form semantics
    <div role="group" aria-label={label} data-testid={testId} className={`min-w-0 ${className}`}>
      <div
        ref={trackRef}
        data-testid={testId ? `${testId}-track` : undefined}
        data-more-start={overflow.start || undefined}
        data-more-end={overflow.end || undefined}
        // py-1 keeps the focus ring inside the scroll box, which clips both axes.
        className={`chip-track -my-1 flex snap-x snap-proximity items-center gap-1.5 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
          bleed ? "-mx-4 scroll-px-4 px-4" : ""
        }`}
      >
        {chips.map((chip) => {
          const active = value === chip.id;
          return (
            <button
              key={chip.id}
              type="button"
              data-chip={chip.id}
              aria-pressed={active}
              aria-label={chip.ariaLabel}
              disabled={disabled}
              onClick={() => onChange(chip.id)}
              className="group/chip focus-ring flex h-11 shrink-0 snap-start items-center rounded-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className={chipFace(active)}>{chip.content}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ToggleChips;
