// Pins the web side of Design Language v2 (docs/design/design-language-v2.md).
// The web package has no unit-test runner, so — like web-lane-chip-contrast —
// the values are read out of globals.css and the ui primitives themselves:
// retuning a token re-runs these checks instead of trusting a comment.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, parseHex } from "../../../web/src/lib/contrast";

const WEB = resolve(__dirname, "../../../web/src");
const CSS = readFileSync(resolve(WEB, "app/globals.css"), "utf8");
const UI_DIR = resolve(WEB, "components/ui");
const UI = readdirSync(UI_DIR)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => ({ file: f, src: readFileSync(resolve(UI_DIR, f), "utf8") }));

function block(selector: ":root" | ".dark" | "@theme" | "@theme inline"): string {
  const start = CSS.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  return CSS.slice(start, CSS.indexOf("\n}", start + 1));
}

function value(src: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(src);
  if (!m) throw new Error(`--${name} missing`);
  return m[1].trim().replace(/\s+/g, " ");
}

const ROOT = block(":root");
const DARK = block(".dark");
const THEME = block("@theme");

describe("v2 colour tokens", () => {
  it("light: canvas, surface, ink, ink-2, ink-3, accent", () => {
    expect(value(ROOT, "surface-app")).toBe("#fafafa"); // canvas
    expect(value(ROOT, "surface-canvas")).toBe("#ffffff"); // surface
    expect(value(ROOT, "ink")).toBe("#0b0d12");
    expect(value(ROOT, "ink-2")).toBe("#3b4250");
    expect(value(ROOT, "ink-3")).toBe("#5b6270");
    expect(value(ROOT, "accent-solid")).toBe("#0369a1");
  });

  it("dark: canvas, surface, raised, ink, ink-2, accent", () => {
    expect(value(DARK, "surface-app")).toBe("#0a0a0b");
    expect(value(DARK, "surface-canvas")).toBe("#141416");
    expect(value(DARK, "surface-elevated")).toBe("#1c1c1f");
    expect(value(DARK, "surface-raised")).toBe("#1c1c1f");
    expect(value(DARK, "ink")).toBe("#f4f4f6");
    expect(value(DARK, "ink-2")).toBe("#a2a2ad");
    expect(value(DARK, "accent-solid")).toBe("#38bdf8");
  });

  it("lane dot inks are unchanged", () => {
    expect(value(ROOT, "tier-push-ink")).toBe("#be123c");
    expect(value(ROOT, "tier-meeting-ink")).toBe("#4f46e5");
    expect(value(ROOT, "tier-queue-ink")).toBe("#b45309");
    expect(value(ROOT, "tier-info-ink")).toBe("#0e7490");
    expect(value(ROOT, "tier-silent-ink")).toBe("#57534e");
  });

  // The ink ramp must hold AA on the lightest/darkest surface a text line can
  // sit on (the hover surface), not just on the canvas.
  for (const [theme, src] of [
    ["light", ROOT],
    ["dark", DARK],
  ] as const) {
    for (const ink of ["ink", "ink-2", "ink-3"]) {
      it(`${theme} ${ink} clears 4.5:1 on every neutral surface`, () => {
        const surfaces = ["surface-app", "surface-canvas", "surface-raised", "surface-hover"];
        const worst = Math.min(
          ...surfaces.map((s) => contrastRatio(parseHex(value(src, ink)), parseHex(value(src, s)))),
        );
        expect(worst).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("v2 radius, depth, motion", () => {
  it("radius: 6 chip · 10 control · 16 card · 24 sheet", () => {
    expect(value(THEME, "radius-chip")).toBe("6px");
    expect(value(THEME, "radius-control")).toBe("10px");
    expect(value(THEME, "radius-card")).toBe("16px");
    expect(value(THEME, "radius-sheet")).toBe("24px");
  });

  it("depth: hairline, menu and sheet shadows — and no other shadow tokens", () => {
    expect(value(ROOT, "hairline")).toBe("rgba(10, 14, 20, 0.08)");
    expect(value(THEME, "shadow-menu")).toBe(
      "0 1px 2px rgba(10, 14, 20, 0.06), 0 4px 12px -4px rgba(10, 14, 20, 0.1)",
    );
    expect(value(THEME, "shadow-sheet")).toBe("0 12px 32px -8px rgba(10, 14, 20, 0.18)");
    const shadowTokens = [...THEME.matchAll(/--shadow-([\w-]+):/g)].map((m) => m[1]).sort();
    expect(shadowTokens).toEqual(["menu", "sheet"]);
  });

  it("motion: 120 state · 200 move · 320 sheet on one curve", () => {
    expect(value(ROOT, "motion-state")).toBe("120ms");
    expect(value(ROOT, "motion-move")).toBe("200ms");
    expect(value(ROOT, "motion-sheet")).toBe("320ms");
    expect(value(block("@theme inline"), "ease-fluid")).toBe("cubic-bezier(0.32, 0.72, 0, 1)");
  });

  it("reduced motion is instant", () => {
    const rm = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rm).toMatch(/transition-duration:\s*0\.01ms !important/);
    expect(rm).toMatch(/animation-duration:\s*0\.01ms !important/);
  });
});

describe("v2 type roles (web column)", () => {
  const ROLES = {
    page: 34,
    title: 22,
    head: 17,
    body: 15,
    label: 13,
    caption: 12,
    mono: 13,
  } as const;
  for (const [role, px] of Object.entries(ROLES)) {
    it(`text-role-${role} is ${px}px`, () => {
      expect(value(THEME, `text-role-${role}`)).toBe(`${px}px`);
      expect(value(THEME, `text-role-${role}--line-height`)).toMatch(/^\d+px$/);
    });
  }
});

describe("ui primitives sit on the v2 system", () => {
  const MIGRATED = [
    "button.tsx",
    "input.tsx",
    "menu.tsx",
    "sheet.tsx",
    "segmented-control.tsx",
    "listbox.tsx",
    "lane-chip.tsx",
  ];

  it("no shadow other than shadow-menu / shadow-sheet in components/ui", () => {
    const offenders = UI.flatMap(({ file, src }) =>
      [...src.matchAll(/(?<![\w-])shadow-(?!menu\b|sheet\b|none\b)[\w[\]/.-]+/g)].map(
        (m) => `${file}: ${m[0]}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("migrated primitives use only the v2 type roles", () => {
    const offenders = UI.filter(({ file }) => MIGRATED.includes(file)).flatMap(({ file, src }) =>
      [
        ...src.matchAll(
          /(?<![\w-])text-(?:display|title|head|body|label|caption|xs|sm|base|lg|xl)(?![\w-])/g,
        ),
      ].map((m) => `${file}: ${m[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it("migrated primitives use the v2 motion steps (no 160ms exit)", () => {
    const offenders = UI.filter(({ file }) => MIGRATED.includes(file)).flatMap(({ file, src }) =>
      [...src.matchAll(/duration-160|motion-exit|motion-enter/g)].map((m) => `${file}: ${m[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it("the lane chip is a chip: radius-chip", () => {
    const chip = UI.find((u) => u.file === "lane-chip.tsx")?.src ?? "";
    expect(chip).toMatch(/rounded-chip\b/);
  });
});
