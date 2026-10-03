// Pins the LaneChip v2 label contrast (P2). The web package has no unit-test
// runner, so its pure contrast helper is exercised from here — same
// arrangement as web-tool-labels.test.ts. The token VALUES are read out of
// globals.css itself, so retuning a chip ink, a lane ink (the tint source) or
// a row surface re-runs the measurement instead of trusting a comment.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  composite,
  contrastRatio,
  parseHex,
  relativeLuminance,
} from "../../../web/src/lib/contrast";

const CSS = readFileSync(resolve(__dirname, "../../../web/src/app/globals.css"), "utf8");
const LANES = ["push", "meeting", "queue", "info", "silent"] as const;
const TINT_ALPHA = 0.13; // ui/lane-chip.tsx: bg-tier-<lane>-ink/13
const AA_TEXT = 4.5;

// Every surface a MailRow (and so a chip) can sit on, per theme.
const SURFACES = {
  root: [
    "surface-canvas",
    "surface-app",
    "surface-panel",
    "surface-raised",
    "surface-hover",
    "state-info-bg",
  ],
  dark: [
    "surface-app",
    "surface-canvas",
    "surface-panel",
    "surface-elevated",
    "surface-raised",
    "surface-hover",
    "state-info-bg",
  ],
} as const;

function block(selector: ":root" | ".dark"): string {
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  return CSS.slice(start, CSS.indexOf("\n}", start));
}

function token(src: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(src);
  if (!m) throw new Error(`--${name} missing or not #rrggbb`);
  return m[1];
}

describe("contrast helper", () => {
  it("parses #rrggbb and rejects other forms", () => {
    expect(parseHex("#0369a1")).toEqual([3, 105, 161]);
    expect(() => parseHex("#fff")).toThrow();
    expect(() => parseHex("rgb(0,0,0)")).toThrow();
  });

  it("matches the WCAG reference values", () => {
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
    expect(contrastRatio(parseHex("#000000"), parseHex("#ffffff"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseHex("#767676"), parseHex("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  it("composites source-over", () => {
    expect(composite([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128]);
    expect(composite([10, 20, 30], [200, 200, 200], 0)).toEqual([200, 200, 200]);
  });
});

describe("LaneChip label contrast against the composited chip", () => {
  for (const [selector, theme] of [
    [":root", "root"],
    [".dark", "dark"],
  ] as const) {
    const src = block(selector);
    for (const lane of LANES) {
      it(`${theme} ${lane} clears ${AA_TEXT}:1 on every row surface`, () => {
        const ink = parseHex(token(src, `tier-${lane}-chip-ink`));
        const tint = parseHex(token(src, `tier-${lane}-ink`));
        const worst = Math.min(
          ...SURFACES[theme].map((s) =>
            contrastRatio(ink, composite(tint, parseHex(token(src, s)), TINT_ALPHA)),
          ),
        );
        expect(worst).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }
  }
});
