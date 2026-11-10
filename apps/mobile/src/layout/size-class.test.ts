import { describe, expect, it } from "vitest";
import { hingeOf, planLayout, postureOf, sizeClassOf } from "./size-class";
import { parseSegmentSpec } from "./viewport";

describe("size classes (canvas notes.sizes)", () => {
  it.each([
    [360, 400, "cover"], // Galaxy Z Flip cover screen
    [419, 449, "cover"],
    [420, 400, "compact"], // wide but short is not the cover
    [360, 800, "compact"], // narrow but tall is a phone
    [390, 844, "compact"],
    [412, 915, "compact"],
    [599, 900, "compact"],
    [600, 900, "medium"],
    [744, 1133, "medium"], // iPad mini portrait
    [840, 1000, "medium"],
    [841, 1000, "expanded"],
    [884, 1104, "expanded"], // Fold unfolded
    [1024, 1366, "expanded"],
    [1366, 1024, "expanded"],
  ] as const)("%i×%i → %s", (w, h, expected) => {
    expect(sizeClassOf(w, h)).toBe(expected);
  });
});

describe("layout plan", () => {
  it("compact → tab bar, one pane", () => {
    expect(planLayout({ width: 390, height: 844 })).toMatchObject({
      nav: "tabs",
      panes: 1,
      assistantFab: false,
    });
  });

  it("medium → rail + list/detail", () => {
    expect(planLayout({ width: 744, height: 1133 })).toMatchObject({ nav: "rail", panes: 2 });
  });

  it("expanded below 1024 keeps the rail (FoldOpen artboard: rail 76 + list 366)", () => {
    expect(planLayout({ width: 884, height: 1104 })).toMatchObject({
      sizeClass: "expanded",
      nav: "rail",
      panes: 2,
      listWidth: 366,
      assistantFab: true,
    });
  });

  it("expanded from 1024 → sidebar + list + detail (TabletLandscape: list 400)", () => {
    expect(planLayout({ width: 1366, height: 1024 })).toMatchObject({
      nav: "sidebar",
      panes: 2,
      listWidth: 400,
    });
    expect(planLayout({ width: 1024, height: 1366 })).toMatchObject({ nav: "sidebar", panes: 2 });
  });

  it("cover → no navigation chrome", () => {
    expect(planLayout({ width: 360, height: 400 })).toMatchObject({
      sizeClass: "cover",
      nav: "none",
    });
  });

  it("vertical hinge → book posture, list exactly left of the fold", () => {
    const segments = parseSegmentSpec("vertical:442:0", 884, 1104);
    const plan = planLayout({ width: 884, height: 1104, segments });
    expect(plan.posture).toBe("book");
    expect(plan.hinge).toEqual({ axis: "vertical", start: 442, size: 0 });
    expect(plan.nav).toBe("rail");
    expect(plan.listWidth).toBe(442 - 76);
  });

  it("a physical gap is kept out of both panes", () => {
    const segments = parseSegmentSpec("vertical:500:20", 1020, 800);
    expect(hingeOf(segments)).toEqual({ axis: "vertical", start: 500, size: 20 });
  });

  it("horizontal hinge → tabletop: one column, tabs, reading on top", () => {
    const segments = parseSegmentSpec("horizontal:540:24", 884, 1104);
    const plan = planLayout({ width: 884, height: 1104, segments });
    expect(plan.posture).toBe("tabletop");
    expect(plan.hinge).toEqual({ axis: "horizontal", start: 540, size: 24 });
    expect(plan).toMatchObject({ nav: "tabs", panes: 1 });
  });

  it("falls back to flat without (or with malformed) segments", () => {
    expect(postureOf(null)).toBe("flat");
    expect(postureOf([{ x: 0, y: 0, width: 884, height: 1104 }])).toBe("flat");
    expect(parseSegmentSpec("vertical:900:0", 884, 1104)).toBeNull();
    expect(parseSegmentSpec("diagonal:10:0", 884, 1104)).toBeNull();
    expect(parseSegmentSpec("vertical:abc", 884, 1104)).toBeNull();
  });
});
