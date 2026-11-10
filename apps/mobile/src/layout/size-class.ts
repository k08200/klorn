/**
 * Window size classes and fold posture → a layout plan. Pure, so the rules
 * in canvas notes.sizes are pinned by tests (size-class.test.ts):
 *
 *   cover     width < 420 && height < 450   Galaxy Z Flip cover screen: one job only
 *   compact   width < 600                   phones, Flip unfolded → bottom tab bar
 *   medium    600 ≤ width ≤ 840             Fold / foldable iPhone, iPad mini portrait
 *                                           → navigation rail + list/detail
 *   expanded  width > 840                   iPad, Galaxy Tab, landscape
 *                                           → sidebar + list + detail, floating assistant
 *
 * Expanded uses the full 248px sidebar only from 1024px; between 841 and
 * 1023 (Fold unfolded is ~884) the sidebar collapses to the 76px rail, which
 * is exactly the FoldOpen artboard (rail 76 + list 366 + reader).
 *
 * Foldables: two viewport segments side by side (vertical hinge, "book")
 * put the panes on either side of the hinge; stacked segments (horizontal
 * hinge, "tabletop") put reading on top and controls below. Nothing is ever
 * laid across the hinge.
 */

export type SizeClass = "cover" | "compact" | "medium" | "expanded";
export type Posture = "flat" | "book" | "tabletop";
export type NavStyle = "none" | "tabs" | "rail" | "sidebar";

export interface Segment {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const COMPACT_MAX = 600;
export const MEDIUM_MAX = 840;
export const SIDEBAR_MIN = 1024;
export const RAIL_WIDTH = 76;
export const SIDEBAR_WIDTH = 248;

export function sizeClassOf(width: number, height: number): SizeClass {
  if (width < 420 && height < 450) return "cover";
  if (width < COMPACT_MAX) return "compact";
  if (width <= MEDIUM_MAX) return "medium";
  return "expanded";
}

export function postureOf(segments: readonly Segment[] | null | undefined): Posture {
  if (!segments || segments.length !== 2) return "flat";
  const [a, b] = segments as [Segment, Segment];
  // Side by side (same row, different columns) = a vertical hinge.
  if (Math.abs(a.y - b.y) < 1 && Math.abs(a.x - b.x) >= 1) return "book";
  if (Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) >= 1) return "tabletop";
  return "flat";
}

export interface Hinge {
  axis: "vertical" | "horizontal";
  /** Where the hinge starts (x for vertical, y for horizontal), in CSS px. */
  start: number;
  /** Its thickness — 0 for a seamless fold, > 0 for a physical gap. */
  size: number;
}

export function hingeOf(segments: readonly Segment[] | null | undefined): Hinge | null {
  const posture = postureOf(segments);
  if (posture === "flat" || !segments) return null;
  const [a, b] = [...segments].sort((p, q) => p.x - q.x || p.y - q.y) as [Segment, Segment];
  if (posture === "book") {
    const start = a.x + a.width;
    return { axis: "vertical", start, size: Math.max(0, b.x - start) };
  }
  const start = a.y + a.height;
  return { axis: "horizontal", start, size: Math.max(0, b.y - start) };
}

export interface LayoutPlan {
  width: number;
  height: number;
  sizeClass: SizeClass;
  posture: Posture;
  hinge: Hinge | null;
  nav: NavStyle;
  /** How many content panes sit side by side (list/detail). */
  panes: 1 | 2;
  /** Width of the list pane when `panes` is 2 (CSS px). */
  listWidth: number;
  /** A floating "Ask the assistant" button (expanded only, canvas notes.sizes). */
  assistantFab: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function planLayout(input: {
  width: number;
  height: number;
  segments?: readonly Segment[] | null;
}): LayoutPlan {
  const { width, height } = input;
  const segments = input.segments ?? null;
  const posture = postureOf(segments);
  const hinge = hingeOf(segments);
  const base = { width, height, posture, hinge };

  // A tabletop fold reads top/bottom whatever the width: one column, tabs.
  if (posture === "tabletop") {
    return {
      ...base,
      sizeClass: sizeClassOf(width, height),
      nav: "tabs",
      panes: 1,
      listWidth: width,
      assistantFab: false,
    };
  }

  // A vertical hinge always means two panes, one per side of the fold.
  if (posture === "book" && hinge) {
    const nav: NavStyle = hinge.start >= SIDEBAR_MIN / 2 + SIDEBAR_WIDTH ? "sidebar" : "rail";
    const navWidth = nav === "sidebar" ? SIDEBAR_WIDTH : RAIL_WIDTH;
    return {
      ...base,
      sizeClass: sizeClassOf(width, height),
      nav,
      panes: 2,
      listWidth: Math.max(0, hinge.start - navWidth),
      assistantFab: false,
    };
  }

  const sizeClass = sizeClassOf(width, height);
  switch (sizeClass) {
    case "cover":
      return { ...base, sizeClass, nav: "none", panes: 1, listWidth: width, assistantFab: false };
    case "compact":
      return { ...base, sizeClass, nav: "tabs", panes: 1, listWidth: width, assistantFab: false };
    case "medium":
      return {
        ...base,
        sizeClass,
        nav: "rail",
        panes: 2,
        // The list ends at the window's centre — on a Fold, exactly at the crease.
        listWidth: Math.round(clamp(width / 2 - RAIL_WIDTH, 280, 366)),
        assistantFab: false,
      };
    case "expanded": {
      const sidebar = width >= SIDEBAR_MIN;
      const navWidth = sidebar ? SIDEBAR_WIDTH : RAIL_WIDTH;
      return {
        ...base,
        sizeClass,
        nav: sidebar ? "sidebar" : "rail",
        panes: 2,
        listWidth: sidebar
          ? Math.round(clamp((width - navWidth) * 0.36, 340, 400))
          : Math.round(clamp(width / 2 - navWidth, 300, 366)),
        assistantFab: true,
      };
    }
  }
}
