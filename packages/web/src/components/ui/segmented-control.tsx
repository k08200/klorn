"use client";

/**
 * SegmentedControl (productization plan §1/§3, P5) — one choice out of a few,
 * always visible; Mail's lane control is the first user.
 *
 * Semantics: a radiogroup. One tab stop (the checked segment, or the first one
 * when none is checked); Left/Right/Up/Down move and select, Home/End jump to
 * the ends. Handled arrow keys are `preventDefault`ed so the app hotkeys never
 * see them. Each segment's hit area is 44px tall (WCAG 2.5.8) around a 32px
 * visual capsule. On a narrow viewport the row scrolls horizontally inside
 * itself — the page never does — and the checked segment is kept in view.
 */

import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";

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

  // Keep the checked segment visible when the row is scrolled (phone width).
  useEffect(() => {
    if (value === null) return;
    const checked = groupRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    checked?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
      className={`flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
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
            className="group/segment focus-ring flex h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span
              className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-label transition-colors duration-120 ease-fluid ${
                checked
                  ? "border-line-strong bg-surface-panel text-ink"
                  : "border-transparent text-ink-mid group-hover/segment:bg-surface-hover group-hover/segment:text-ink"
              }`}
            >
              {segment.leading}
              {segment.label}
              {segment.count !== undefined && segment.count > 0 && (
                <span
                  className={`text-caption tabular-nums ${checked ? "text-ink-soft" : "text-ink-muted"}`}
                >
                  {segment.count}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
