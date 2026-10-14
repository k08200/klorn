/**
 * Swipe triage (productization plan §3, P10) — the pure gesture rules in
 * packages/web/src/lib/swipe-gesture.ts and the row action plan in
 * packages/web/src/app/email/_v2/row-actions.ts that keeps every swipe action
 * reachable without a swipe.
 */

import { describe, expect, it } from "vitest";
import {
  REASON_DEMO,
  REASON_NOT_CLASSIFIED,
  REASON_RECONNECT,
  rowActionPlan,
  swipeAction,
} from "../../../web/src/app/email/_v2/row-actions";
import {
  classifyAxis,
  FLING_MIN_PX,
  isArmed,
  moveTrack,
  releaseOutcome,
  rubberBand,
  SWIPE_SLOP_PX,
  type SwipeConfig,
  type SwipeSample,
  type SwipeTrack,
  startTrack,
  suppressesClick,
  THRESHOLD_MAX_PX,
  thresholdFor,
  VELOCITY_WINDOW_MS,
  velocityX,
  visualOffset,
} from "../../../web/src/lib/swipe-gesture";

const WIDTH = 360;
const OPEN = { present: true, blocked: false };
const BLOCKED = { present: true, blocked: true };
const ABSENT = { present: false, blocked: false };
const BOTH: SwipeConfig = { width: WIDTH, left: OPEN, right: OPEN };

/** A drag from (0,0) through the given points, `step` ms apart. */
function drag(points: ReadonlyArray<[number, number]>, step = 16): SwipeTrack {
  let track = startTrack({ x: 0, y: 0, t: 0 });
  points.forEach(([x, y], index) => {
    const sample: SwipeSample = { x, y, t: (index + 1) * step };
    track = moveTrack(track, sample);
  });
  return track;
}

describe("classifyAxis", () => {
  it("stays pending inside the slop, so a tap never locks an axis", () => {
    expect(classifyAxis("pending", SWIPE_SLOP_PX - 1, 0)).toBe("pending");
    expect(classifyAxis("pending", 3, -4)).toBe("pending");
  });

  it("locks horizontal only when sideways travel clearly wins", () => {
    expect(classifyAxis("pending", 20, 5)).toBe("horizontal");
    expect(classifyAxis("pending", -20, 5)).toBe("horizontal");
  });

  it("treats a vertical or diagonal start as a scroll", () => {
    expect(classifyAxis("pending", 2, 30)).toBe("vertical");
    // 45°: not clearly sideways, so the list scrolls.
    expect(classifyAxis("pending", 15, 15)).toBe("vertical");
    expect(classifyAxis("pending", 12, 11)).toBe("vertical");
  });

  it("never changes once decided", () => {
    expect(classifyAxis("vertical", 200, 0)).toBe("vertical");
    expect(classifyAxis("horizontal", 0, 200)).toBe("horizontal");
  });
});

describe("track", () => {
  it("keeps the axis it locked even when the finger later drifts vertically", () => {
    const track = drag([
      [20, 2],
      [60, 40],
      [90, 120],
    ]);
    expect(track.axis).toBe("horizontal");
  });

  it("does not mutate the previous track", () => {
    const first = startTrack({ x: 0, y: 0, t: 0 });
    const next = moveTrack(first, { x: 30, y: 0, t: 16 });
    expect(first.axis).toBe("pending");
    expect(first.samples).toHaveLength(1);
    expect(next.samples).toHaveLength(2);
  });

  it("measures velocity over the recent window only", () => {
    // Slow for a long time, then a fast flick at the end.
    let track = startTrack({ x: 0, y: 0, t: 0 });
    for (let t = 50; t <= 1000; t += 50) track = moveTrack(track, { x: t / 20, y: 0, t });
    track = moveTrack(track, { x: 50 + 100, y: 0, t: 1050 });
    // Whole-track average would be 150/1050 ≈ 0.14 px/ms.
    const oldest = track.samples[0];
    expect(1050 - oldest.t).toBeLessThanOrEqual(VELOCITY_WINDOW_MS + 50);
    expect(velocityX(track)).toBeGreaterThan(0.6);
  });

  it("reports zero velocity with a single sample", () => {
    expect(velocityX(startTrack({ x: 5, y: 5, t: 10 }))).toBe(0);
  });
});

describe("thresholds", () => {
  it("arms at 35% of the row, capped for wide rows", () => {
    expect(thresholdFor(WIDTH)).toBeCloseTo(126);
    expect(thresholdFor(1200)).toBe(THRESHOLD_MAX_PX);
  });

  it("arms by distance alone, either way", () => {
    expect(isArmed(130, 0, WIDTH)).toBe(true);
    expect(isArmed(-130, 0, WIDTH)).toBe(true);
    expect(isArmed(100, 0, WIDTH)).toBe(false);
  });

  it("arms a short fling in the same direction, but not under the minimum", () => {
    expect(isArmed(60, 1.2, WIDTH)).toBe(true);
    expect(isArmed(-60, -1.2, WIDTH)).toBe(true);
    expect(isArmed(FLING_MIN_PX - 1, 3, WIDTH)).toBe(false);
  });

  it("does not arm a fling that is moving back (cancelling)", () => {
    expect(isArmed(80, -1.5, WIDTH)).toBe(false);
  });
});

describe("visualOffset", () => {
  it("follows the finger 1:1 up to the reveal width", () => {
    expect(visualOffset(100, BOTH)).toBe(100);
    expect(visualOffset(-100, BOTH)).toBe(-100);
  });

  it("rubber-bands past the reveal width and never reaches the finger", () => {
    const far = visualOffset(400, BOTH);
    expect(far).toBeGreaterThan(WIDTH * 0.6);
    expect(far).toBeLessThan(400);
    expect(visualOffset(500, BOTH)).toBeGreaterThan(far);
  });

  it("resists from the first pixel on a blocked or empty side", () => {
    const blocked: SwipeConfig = { width: WIDTH, left: ABSENT, right: BLOCKED };
    expect(visualOffset(100, blocked)).toBeLessThan(WIDTH * 0.12);
    expect(visualOffset(-100, blocked)).toBeLessThan(0);
    expect(visualOffset(-100, blocked)).toBeGreaterThan(-WIDTH * 0.12);
  });

  it("rubberBand is zero at rest and monotonic", () => {
    expect(rubberBand(0, 100)).toBe(0);
    expect(rubberBand(-5, 100)).toBe(0);
    expect(rubberBand(50, 100)).toBeLessThan(rubberBand(80, 100));
    expect(rubberBand(10_000, 100)).toBeLessThan(100);
  });
});

describe("releaseOutcome", () => {
  it("commits right (archive) past the threshold", () => {
    const track = drag([
      [20, 0],
      [80, 2],
      [150, 3],
    ]);
    expect(releaseOutcome(track, BOTH)).toEqual({ kind: "commit", direction: "right" });
  });

  it("commits left (lanes) on a fast short fling", () => {
    const track = drag(
      [
        [-15, 0],
        [-35, 0],
        [-60, 1],
      ],
      10,
    );
    expect(releaseOutcome(track, BOTH)).toEqual({ kind: "commit", direction: "left" });
  });

  it("cancels when dragged back under the threshold before release", () => {
    const track = drag(
      [
        [40, 0],
        [140, 0],
        [150, 0],
        [100, 0],
        [30, 0],
      ],
      60,
    );
    expect(releaseOutcome(track, BOTH)).toEqual({ kind: "none" });
  });

  it("does nothing for a vertical scroll, however far", () => {
    const track = drag([
      [3, 20],
      [40, 200],
      [200, 400],
    ]);
    expect(track.axis).toBe("vertical");
    expect(releaseOutcome(track, BOTH)).toEqual({ kind: "none" });
  });

  it("does nothing for a tap", () => {
    const track = drag([[3, 2]]);
    expect(releaseOutcome(track, BOTH)).toEqual({ kind: "none" });
    expect(suppressesClick(track)).toBe(false);
  });

  it("reports blocked, not commit, on a blocked side (unsupported archive)", () => {
    const config: SwipeConfig = { width: WIDTH, left: OPEN, right: BLOCKED };
    const track = drag([
      [20, 0],
      [150, 0],
    ]);
    expect(releaseOutcome(track, config)).toEqual({ kind: "blocked", direction: "right" });
  });

  it("does nothing on a side with no action", () => {
    const config: SwipeConfig = { width: WIDTH, left: ABSENT, right: OPEN };
    const track = drag([
      [-20, 0],
      [-200, 0],
    ]);
    expect(releaseOutcome(track, config)).toEqual({ kind: "none" });
  });

  it("swallows the click after any horizontal swipe, even a cancelled one", () => {
    const track = drag([
      [20, 0],
      [5, 0],
    ]);
    expect(releaseOutcome(track, BOTH)).toEqual({ kind: "none" });
    expect(suppressesClick(track)).toBe(true);
    expect(suppressesClick(null)).toBe(false);
  });
});

describe("rowActionPlan (no swipe-only actions)", () => {
  const cases = [
    { isDemo: false, needsReconnect: false, tier: "QUEUE" as const },
    { isDemo: true, needsReconnect: false, tier: "PUSH" as const },
    { isDemo: false, needsReconnect: true, tier: "INFO" as const },
    { isDemo: false, needsReconnect: false, tier: null },
  ];

  it.each(
    cases,
  )("every swipe action is also in the row's actions, with the same reason (%o)", (input) => {
    const plan = rowActionPlan(input);
    for (const direction of ["left", "right"] as const) {
      const action = swipeAction(plan, direction);
      expect(plan.menu).toContain(action.id);
      const menuAction = action.id === "archive" ? plan.archive : plan.lanes;
      expect(menuAction.blockedReason).toBe(action.blockedReason);
    }
  });

  it("maps right to archive and left to the lane picker", () => {
    const plan = rowActionPlan({ isDemo: false, needsReconnect: false, tier: "QUEUE" });
    expect(swipeAction(plan, "right").id).toBe("archive");
    expect(swipeAction(plan, "left").id).toBe("lanes");
    expect(plan.archive.blockedReason).toBeNull();
    expect(plan.lanes.blockedReason).toBeNull();
  });

  it("uses the reader's archive rule: demo, then an account that needs reconnecting", () => {
    expect(
      rowActionPlan({ isDemo: true, needsReconnect: true, tier: "QUEUE" }).archive.blockedReason,
    ).toBe(REASON_DEMO);
    expect(
      rowActionPlan({ isDemo: false, needsReconnect: true, tier: "QUEUE" }).archive.blockedReason,
    ).toBe(REASON_RECONNECT);
  });

  it("blocks a lane move on a mail with no lane yet, but still lets it archive", () => {
    const plan = rowActionPlan({ isDemo: false, needsReconnect: false, tier: null });
    expect(plan.lanes.blockedReason).toBe(REASON_NOT_CLASSIFIED);
    expect(plan.archive.blockedReason).toBeNull();
  });
});
