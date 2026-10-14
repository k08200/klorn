/**
 * Swipe triage gesture rules (productization plan §3, P10) — pure, no DOM.
 *
 * A row follows one touch through four questions, each answered here so the
 * component only measures and paints:
 *
 * 1. Axis lock: nothing moves until the finger has travelled `slop` px. Then
 *    the gesture is horizontal only when the sideways travel clearly beats the
 *    vertical one (`HORIZONTAL_BIAS`); anything else is a scroll and the row
 *    stays put for the rest of that touch. A tap never gets this far.
 * 2. Offset: the row follows the finger 1:1 up to the reveal width, then
 *    resists (rubber band). A direction with no action, or a blocked one,
 *    resists from the first pixel, so it is felt as "not here" without moving
 *    far enough to look like it will do something.
 * 3. Armed: past the distance threshold, or flung fast enough in the same
 *    direction after a short minimum, the action will run on release.
 *    Dragging back under the threshold disarms it (cancellable).
 * 4. Outcome on release: the armed direction's action, "blocked" when that
 *    direction is armed but its action cannot run (the caller says why), or
 *    nothing.
 */

export type SwipeAxis = "pending" | "horizontal" | "vertical";
/** `right` = finger moved right (dx > 0). */
export type SwipeDirection = "left" | "right";

/** Travel before the axis is decided; below it a release is a tap. */
export const SWIPE_SLOP_PX = 10;
/** Horizontal wins only when |dx| exceeds |dy| by this factor. */
export const HORIZONTAL_BIAS = 1.2;
/** Fraction of the row width that arms an action. */
export const THRESHOLD_FRACTION = 0.35;
/** Cap on the distance threshold, so a wide row does not need a long drag. */
export const THRESHOLD_MAX_PX = 140;
/** A fling arms with less travel, but never less than this. */
export const FLING_MIN_PX = 40;
/** px per ms; ~600 px/s. */
export const FLING_VELOCITY = 0.6;
/** How far a working direction follows 1:1 before resisting, as a fraction of width. */
export const REVEAL_FRACTION = 0.6;
/** Rubber-band constant (UIScrollView's 0.55). */
export const RUBBER_BAND = 0.55;
/** How far a blocked or empty direction may stretch, as a fraction of width. */
export const BLOCKED_STRETCH_FRACTION = 0.12;
/** Velocity is measured over the last stretch of samples this long. */
export const VELOCITY_WINDOW_MS = 100;

export interface DirectionState {
  /** The direction has an action at all. */
  present: boolean;
  /** The action exists but cannot run now (demo mail, account needs reconnecting). */
  blocked: boolean;
}

export interface SwipeConfig {
  width: number;
  left: DirectionState;
  right: DirectionState;
}

export interface SwipeSample {
  x: number;
  y: number;
  /** ms, monotonic (event.timeStamp). */
  t: number;
}

export interface SwipeTrack {
  axis: SwipeAxis;
  origin: SwipeSample;
  /** Recent samples, oldest first, trimmed to the velocity window. */
  samples: readonly SwipeSample[];
}

export type SwipeOutcome =
  | { kind: "none" }
  | { kind: "commit"; direction: SwipeDirection }
  | { kind: "blocked"; direction: SwipeDirection };

const NO_OUTCOME: SwipeOutcome = { kind: "none" };

/** Decide the axis from the travel so far; once decided it never changes. */
export function classifyAxis(
  current: SwipeAxis,
  dx: number,
  dy: number,
  slop = SWIPE_SLOP_PX,
): SwipeAxis {
  if (current !== "pending") return current;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < slop) return "pending";
  return ax > ay * HORIZONTAL_BIAS ? "horizontal" : "vertical";
}

export function startTrack(sample: SwipeSample): SwipeTrack {
  return { axis: "pending", origin: sample, samples: [sample] };
}

/** Fold one pointer move into the track (a new object; the old one is untouched). */
export function moveTrack(track: SwipeTrack, sample: SwipeSample): SwipeTrack {
  const axis = classifyAxis(track.axis, sample.x - track.origin.x, sample.y - track.origin.y);
  const all = [...track.samples, sample];
  // The samples inside the window, plus the last one before it so a slow,
  // steady drag still has a baseline to measure from.
  const firstInside = all.findIndex((s) => sample.t - s.t <= VELOCITY_WINDOW_MS);
  return { axis, origin: track.origin, samples: all.slice(Math.max(0, firstInside - 1)) };
}

/** Horizontal velocity in px/ms over the recent samples; 0 when unknown. */
export function velocityX(track: SwipeTrack): number {
  const first = track.samples[0];
  const last = track.samples.at(-1);
  if (!first || !last || last.t <= first.t) return 0;
  return (last.x - first.x) / (last.t - first.t);
}

export function directionOf(dx: number): SwipeDirection | null {
  if (dx > 0) return "right";
  if (dx < 0) return "left";
  return null;
}

/** Distance that arms an action on a row this wide. */
export function thresholdFor(width: number): number {
  return Math.min(Math.max(width, 0) * THRESHOLD_FRACTION, THRESHOLD_MAX_PX);
}

/** Resistance past `limit`: the further out, the less each pixel moves. */
export function rubberBand(overshoot: number, dimension: number): number {
  if (overshoot <= 0 || dimension <= 0) return 0;
  return (1 - 1 / ((overshoot * RUBBER_BAND) / dimension + 1)) * dimension;
}

function stateFor(config: SwipeConfig, direction: SwipeDirection): DirectionState {
  return direction === "left" ? config.left : config.right;
}

/** Where the row is drawn for a finger travel of `dx`. */
export function visualOffset(dx: number, config: SwipeConfig): number {
  const direction = directionOf(dx);
  if (!direction) return 0;
  const sign = direction === "right" ? 1 : -1;
  const travel = Math.abs(dx);
  const state = stateFor(config, direction);
  if (!state.present || state.blocked) {
    const stretch = config.width * BLOCKED_STRETCH_FRACTION;
    return sign * rubberBand(travel, stretch);
  }
  const reveal = config.width * REVEAL_FRACTION;
  if (travel <= reveal) return dx;
  return sign * (reveal + rubberBand(travel - reveal, config.width - reveal));
}

/** Whether the travel (and its speed) would run the action if released now. */
export function isArmed(dx: number, velocity: number, width: number): boolean {
  const direction = directionOf(dx);
  if (!direction) return false;
  const travel = Math.abs(dx);
  if (travel >= thresholdFor(width)) return true;
  const sameWay = direction === "right" ? velocity > 0 : velocity < 0;
  return travel >= FLING_MIN_PX && sameWay && Math.abs(velocity) >= FLING_VELOCITY;
}

/** What a release does, given the track so far. */
export function releaseOutcome(track: SwipeTrack, config: SwipeConfig): SwipeOutcome {
  if (track.axis !== "horizontal") return NO_OUTCOME;
  const last = track.samples.at(-1) ?? track.origin;
  const dx = last.x - track.origin.x;
  const direction = directionOf(dx);
  if (!direction) return NO_OUTCOME;
  const state = stateFor(config, direction);
  if (!state.present) return NO_OUTCOME;
  if (!isArmed(dx, velocityX(track), config.width)) return NO_OUTCOME;
  return state.blocked ? { kind: "blocked", direction } : { kind: "commit", direction };
}

/** The click that follows a touch must not open the row once it became a swipe. */
export function suppressesClick(track: SwipeTrack | null): boolean {
  return track !== null && track.axis === "horizontal";
}
