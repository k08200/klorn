"use client";

/**
 * SwipeRow (productization plan §3, P10) — swipe a list row sideways to run
 * one of two actions. Touch only: it answers pointer events whose
 * `pointerType` is "touch", so a mouse, a pen and the keyboard never trigger
 * it. Swipe is a shortcut; the row's own controls must offer the same actions
 * (see app/email/_v2/row-actions.ts).
 *
 * The rules (axis lock, threshold, fling, rubber band, outcome) live in
 * lib/swipe-gesture.ts and are unit-tested; this file measures and paints.
 *
 * - `touch-action: pan-y` hands vertical scrolling to the browser, which
 *   fires pointercancel when it takes a touch over: a scroll never moves the
 *   row. Our own axis lock covers the diagonal start.
 * - The row follows the finger; the action behind it is revealed with its
 *   label, and its tint deepens once a release would run it ("armed").
 *   Dragging back under the threshold disarms it; a cancel or an unarmed
 *   release springs back.
 * - A touch that became a swipe swallows the click that follows, so the
 *   link under the finger does not open. A tap (under the slop) is untouched.
 * - Reduced motion: the row does not slide. The action is revealed in place
 *   over it, and nothing animates back.
 * - No haptics.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  CLICK_SWALLOW_MS,
  directionOf,
  isArmed,
  isClickSwallowed,
  moveTrack,
  releaseOutcome,
  type SwipeConfig,
  type SwipeDirection,
  type SwipeTrack,
  startTrack,
  suppressesClick,
  velocityX,
  visualOffset,
} from "../../lib/swipe-gesture";

/** Matches --motion-enter; the spring back and the exit slide. */
const SETTLE_MS = 200;

export interface SwipeSide {
  /** What the action is called ("Archive"). */
  label: string;
  icon: ReactNode;
  /** Why it cannot run now; shown in the reveal instead of the label. */
  blockedReason?: string | null;
  /** Leave with the row (archive) or spring back (open a sheet). */
  exits?: boolean;
}

export interface SwipeRowProps {
  children: ReactNode;
  /** Revealed when the finger moves right. */
  right?: SwipeSide;
  /** Revealed when the finger moves left. */
  left?: SwipeSide;
  /** No swipe at all (a selection or an action is in progress). */
  disabled?: boolean;
  onCommit: (direction: SwipeDirection) => void;
  /** An armed release on a blocked side; tell the user why. */
  onBlocked?: (direction: SwipeDirection, reason: string) => void;
  className?: string;
}

interface Reveal {
  direction: SwipeDirection;
  armed: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function configFor(width: number, left?: SwipeSide, right?: SwipeSide): SwipeConfig {
  return {
    width,
    left: { present: Boolean(left), blocked: Boolean(left?.blockedReason) },
    right: { present: Boolean(right), blocked: Boolean(right?.blockedReason) },
  };
}

export function SwipeRow(props: SwipeRowProps) {
  const { children, left, right, disabled = false, className = "" } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const track = useRef<SwipeTrack | null>(null);
  const pointer = useRef<number | null>(null);
  const config = useRef<SwipeConfig | null>(null);
  const reduced = useRef(false);
  // The click a swipe's release produces is swallowed until this time
  // (performance.now()), so a later keyboard or screen-reader activation never is.
  const swallowUntil = useRef(0);
  // While the row slides out after an exiting commit: no new gesture, no click.
  const exiting = useRef<{ timer: number; commit: () => void } | null>(null);
  const onCommitRef = useRef(props.onCommit);
  onCommitRef.current = props.onCommit;
  const [reveal, setReveal] = useState<Reveal | null>(null);
  // A sideways drag is in progress (or the row is sliding out). Only then does
  // the row clip and stack above the reveal; at rest it must not, or it would
  // clip the row's menus and focus ring and paint the next row over an open menu.
  const [dragging, setDragging] = useState(false);

  const paint = useCallback((offset: number, animate: boolean) => {
    const row = rowRef.current;
    if (!row) return;
    row.style.transition =
      animate && !reduced.current ? `transform ${SETTLE_MS}ms var(--ease-fluid)` : "none";
    row.style.transform = offset === 0 ? "" : `translate3d(${offset}px, 0, 0)`;
  }, []);

  const reset = useCallback(
    (animate: boolean) => {
      track.current = null;
      pointer.current = null;
      paint(0, animate);
      setReveal(null);
      if (!animate || reduced.current) setDragging(false);
      // After the spring back, unless a new drag has started meanwhile.
      else window.setTimeout(() => !track.current && setDragging(false), SETTLE_MS);
    },
    [paint],
  );

  const sideFor = (direction: SwipeDirection | null): SwipeSide | undefined =>
    direction === "right" ? right : direction === "left" ? left : undefined;

  /** Show which action a release would run, and whether it is armed. */
  const showReveal = (dx: number, next: SwipeTrack, width: number) => {
    const direction = directionOf(dx);
    if (!direction || !sideFor(direction)) {
      setReveal(null);
      return;
    }
    const armed = isArmed(dx, velocityX(next), width);
    setReveal((prev) =>
      prev?.direction === direction && prev.armed === armed ? prev : { direction, armed },
    );
  };

  /**
   * Slide the row out, then hand over: the caller removes it. Exactly once:
   * a second touch during the slide is ignored and its click swallowed. If the
   * row unmounts mid-slide (a refetch replaced the list), the commit still
   * runs at unmount — the user asked for it and the row already looked gone.
   */
  const exitThenCommit = (direction: SwipeDirection, width: number) => {
    track.current = null;
    pointer.current = null;
    paint(direction === "right" ? width : -width, true);
    const commit = () => {
      exiting.current = null;
      onCommitRef.current(direction);
    };
    const timer = window.setTimeout(() => {
      commit();
      reset(false);
    }, SETTLE_MS);
    exiting.current = { timer, commit };
  };

  // Unmount mid-slide: cancel the timer and run the commit now (see above).
  useEffect(
    () => () => {
      const pending = exiting.current;
      if (!pending) return;
      window.clearTimeout(pending.timer);
      pending.commit();
    },
    [],
  );

  // Disabled mid-drag (an action started elsewhere): drop the gesture, no commit.
  useEffect(() => {
    if (disabled && track.current) reset(true);
  }, [disabled, reset]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (exiting.current) return;
    if (disabled || event.pointerType !== "touch" || !event.isPrimary) return;
    const width = rootRef.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return;
    reduced.current = prefersReducedMotion();
    config.current = configFor(width, left, right);
    pointer.current = event.pointerId;
    track.current = startTrack({ x: event.clientX, y: event.clientY, t: event.timeStamp });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = track.current;
    const cfg = config.current;
    if (!current || !cfg || event.pointerId !== pointer.current) return;
    const next = moveTrack(current, { x: event.clientX, y: event.clientY, t: event.timeStamp });
    if (next.axis === "vertical") {
      // A scroll: let go of this touch for good.
      reset(false);
      return;
    }
    track.current = next;
    if (next.axis !== "horizontal") return;
    if (current.axis !== "horizontal") {
      // Locked sideways: keep the rest of this touch even if it leaves the row.
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDragging(true);
    }
    const dx = event.clientX - next.origin.x;
    if (!reduced.current) paint(visualOffset(dx, cfg), false);
    showReveal(dx, next, cfg.width);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = track.current;
    const cfg = config.current;
    if (!current || !cfg || event.pointerId !== pointer.current) return;
    const finished = moveTrack(current, { x: event.clientX, y: event.clientY, t: event.timeStamp });
    if (suppressesClick(finished)) swallowUntil.current = performance.now() + CLICK_SWALLOW_MS;
    const outcome = releaseOutcome(finished, cfg);
    if (outcome.kind === "none") {
      reset(true);
      return;
    }
    const side = sideFor(outcome.direction);
    if (outcome.kind === "blocked") {
      reset(true);
      if (side?.blockedReason) props.onBlocked?.(outcome.direction, side.blockedReason);
      return;
    }
    if (side?.exits && !reduced.current) {
      exitThenCommit(outcome.direction, cfg.width);
      return;
    }
    reset(true);
    props.onCommit(outcome.direction);
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== pointer.current) return;
    reset(true);
  };

  const onClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!exiting.current && !isClickSwallowed(performance.now(), swallowUntil.current)) return;
    swallowUntil.current = 0;
    event.preventDefault();
    event.stopPropagation();
  };

  const side = reveal ? (reveal.direction === "right" ? right : left) : undefined;
  const blocked = Boolean(side?.blockedReason);
  const revealTone = blocked
    ? "bg-surface-hover text-ink-muted"
    : reveal?.armed
      ? "bg-accent-solid text-accent-solid-ink"
      : "bg-state-info-bg text-state-info-ink";

  return (
    <div
      ref={rootRef}
      className={`relative rounded-card ${dragging ? "overflow-hidden" : ""} ${className}`}
      // Vertical scroll and pinch-zoom stay the browser's (WCAG 1.4.4); sideways is ours.
      style={{ touchAction: "pan-y pinch-zoom" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={onClickCapture}
    >
      {reveal && side && (
        <div
          aria-hidden="true"
          data-swipe-reveal={reveal.direction}
          data-swipe-armed={reveal.armed && !blocked ? "true" : "false"}
          className={`pointer-events-none absolute inset-0 flex items-center gap-2 px-4 text-label ${
            reveal.direction === "right" ? "justify-start" : "justify-end"
          } ${revealTone} ${reduced.current ? "z-20" : "z-0"}`}
        >
          {side.icon}
          <span className="line-clamp-2 min-w-0">{side.blockedReason || side.label}</span>
        </div>
      )}
      <div ref={rowRef} className={dragging ? "relative z-10 bg-surface-panel" : ""}>
        {children}
      </div>
    </div>
  );
}

export default SwipeRow;
