/**
 * The live viewport: size + fold segments → LayoutPlan, re-evaluated on every
 * resize, rotation, multi-window / Stage Manager / pop-up window change and
 * fold-posture change. Selection lives in the route, so a re-layout never
 * loses the open item.
 *
 * Segments come from the Viewport Segments API (`window.viewport.segments`,
 * Chromium 138+; Samsung Internet / Android WebView on foldables). Where the
 * API is missing the app is simply "flat" — the fallback is the plain size
 * class. For tests and the mock build, `?segments=vertical:<x>:<gap>` or
 * `horizontal:<y>:<gap>` simulates a hinge (dev/mock builds only).
 */
import { useSyncExternalStore } from "react";
import { MOCK_API } from "../config";
import { type LayoutPlan, planLayout, type Segment } from "./size-class";

interface ViewportSegmentsApi {
  segments?: ReadonlyArray<{ x: number; y: number; width: number; height: number }> | null;
}

const SIM_KEY = "klorn-sim-segments";

function simulatedSegments(width: number, height: number): Segment[] | null {
  if (!(MOCK_API || import.meta.env.DEV)) return null;
  let spec: string | null = null;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("segments");
    if (fromUrl) window.sessionStorage.setItem(SIM_KEY, fromUrl);
    spec = window.sessionStorage.getItem(SIM_KEY);
  } catch {
    return null;
  }
  return parseSegmentSpec(spec, width, height);
}

/** "vertical:442:0" → two side-by-side segments split at x=442 with a 0px gap. */
export function parseSegmentSpec(
  spec: string | null,
  width: number,
  height: number,
): Segment[] | null {
  if (!spec) return null;
  const [axis, at, gap = "0"] = spec.split(":");
  const start = Number(at);
  const size = Number(gap);
  if (!Number.isFinite(start) || !Number.isFinite(size) || start <= 0 || size < 0) return null;
  if (axis === "vertical" && start + size < width) {
    return [
      { x: 0, y: 0, width: start, height },
      { x: start + size, y: 0, width: width - start - size, height },
    ];
  }
  if (axis === "horizontal" && start + size < height) {
    return [
      { x: 0, y: 0, width, height: start },
      { x: 0, y: start + size, width, height: height - start - size },
    ];
  }
  return null;
}

function readSegments(width: number, height: number): Segment[] | null {
  const api = (window as unknown as { viewport?: ViewportSegmentsApi }).viewport;
  const native = api?.segments;
  if (native && native.length > 1) {
    return native.map((s) => ({ x: s.x, y: s.y, width: s.width, height: s.height }));
  }
  return simulatedSegments(width, height);
}

let cached: { key: string; plan: LayoutPlan } | null = null;

function snapshot(): LayoutPlan {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const segments = readSegments(width, height);
  const key = `${width}x${height}|${JSON.stringify(segments)}`;
  if (!cached || cached.key !== key)
    cached = { key, plan: planLayout({ width, height, segments }) };
  return cached.plan;
}

function subscribe(onChange: () => void): () => void {
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(onChange);
  };
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  screen.orientation?.addEventListener?.("change", schedule);
  const queries = ["(horizontal-viewport-segments: 2)", "(vertical-viewport-segments: 2)"].map(
    (q) => window.matchMedia(q),
  );
  for (const mq of queries) mq.addEventListener?.("change", schedule);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    screen.orientation?.removeEventListener?.("change", schedule);
    for (const mq of queries) mq.removeEventListener?.("change", schedule);
  };
}

export function useLayoutPlan(): LayoutPlan {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
