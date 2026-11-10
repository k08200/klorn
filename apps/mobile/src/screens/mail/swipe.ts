/**
 * Swipe-row decisions, pure (canvas notes.gestures):
 *
 *   swipe RIGHT → "Done": the row leaves the list (the mail itself is untouched)
 *   swipe LEFT  → the lane sheet (SILENT preselected)
 *   long press  → multi-select
 *
 * The row only claims a gesture once it is clearly horizontal, so vertical
 * scrolling and pull-to-refresh keep working. Thresholds are in CSS px and
 * px/ms so they are the same on every density.
 */

/** Movement before a gesture is read as horizontal / vertical. */
export const INTENT_SLOP = 8;
/** How much more horizontal than vertical a drag must be to be a swipe. */
export const HORIZONTAL_BIAS = 1.4;
/** Release past this distance commits (the artboard's 88px reveal). */
export const COMMIT_DISTANCE = 88;
/** A fling this fast commits from a shorter drag. */
export const FLING_VELOCITY = 0.6;
export const FLING_MIN_DISTANCE = 40;
/** Hold this long without moving to enter multi-select. */
export const LONG_PRESS_MS = 450;
/** Beyond this the row follows the finger with resistance. */
export const RESISTANCE_START = 140;

export type SwipeIntent = "pending" | "horizontal" | "vertical";

export function swipeIntent(dx: number, dy: number): SwipeIntent {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < INTENT_SLOP && ay < INTENT_SLOP) return "pending";
  if (ax > INTENT_SLOP && ax > ay * HORIZONTAL_BIAS) return "horizontal";
  if (ay >= INTENT_SLOP) return "vertical";
  return "pending";
}

export type SwipeOutcome = "done" | "lane" | "cancel";

/** Which action a drag of `dx` would trigger if released now (for the reveal + haptic). */
export function armedAction(dx: number): SwipeOutcome {
  if (dx >= COMMIT_DISTANCE) return "done";
  if (dx <= -COMMIT_DISTANCE) return "lane";
  return "cancel";
}

/**
 * What a release does. `velocity` is px/ms along x (positive = right). A
 * fling counts only in the direction the row was dragged.
 */
export function swipeOutcome(dx: number, velocity: number): SwipeOutcome {
  const armed = armedAction(dx);
  if (armed !== "cancel") return armed;
  if (Math.abs(dx) >= FLING_MIN_DISTANCE && Math.abs(velocity) >= FLING_VELOCITY) {
    if (dx > 0 && velocity > 0) return "done";
    if (dx < 0 && velocity < 0) return "lane";
  }
  return "cancel";
}

/** True exactly when this move crossed the commit line (either way) — one haptic per crossing. */
export function crossedThreshold(previousDx: number, dx: number): boolean {
  return armedAction(previousDx) !== armedAction(dx);
}

/** Where the row is drawn for a finger at `dx`: 1:1, then with resistance. */
export function rowOffset(dx: number): number {
  const ax = Math.abs(dx);
  if (ax <= RESISTANCE_START) return dx;
  const extra = ax - RESISTANCE_START;
  return Math.sign(dx) * (RESISTANCE_START + extra * 0.35);
}

/** Tracks x velocity from the last few samples (px/ms). */
export class VelocityTracker {
  private samples: Array<{ x: number; t: number }> = [];

  add(x: number, t: number): void {
    this.samples.push({ x, t });
    // Only the last 100 ms speak for the release.
    while (this.samples.length > 2 && t - (this.samples[0]?.t ?? t) > 100) this.samples.shift();
  }

  velocity(): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.t === first.t) return 0;
    return (last.x - first.x) / (last.t - first.t);
  }

  reset(): void {
    this.samples = [];
  }
}
