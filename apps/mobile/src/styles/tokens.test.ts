import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Design Language v2 (docs/design/design-language-v2.md), phone column.
const SRC = resolve(__dirname, "..");
const CSS = readFileSync(resolve(__dirname, "tokens.css"), "utf8");

function block(start: string): string {
  const at = CSS.indexOf(start);
  if (at < 0) throw new Error(`no block ${start}`);
  const open = CSS.indexOf("{", at + start.length - 1);
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    if (CSS[i] === "}" && --depth === 0) return CSS.slice(open + 1, i);
  }
  throw new Error(`unclosed ${start}`);
}

function value(src: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(src);
  if (!m) throw new Error(`--${name} missing`);
  return (m[1] ?? "").trim().replace(/\s+/g, " ");
}

const ROOT = block(":root {");
const DARK_MEDIA = block(':root:not([data-theme="light"]) {');
const DARK_FORCED = block(':root[data-theme="dark"] {');
const px = (src: string, name: string) =>
  value(src, name).replace(/^calc\((\d+(?:\.\d+)?) \* var\(--u\)\)$/, "$1");

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) cssFiles(full, out);
    else if (/\.(css|ts|tsx)$/.test(name) && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("dark theme", () => {
  it("both dark blocks are identical", () => {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(norm(DARK_MEDIA)).toBe(norm(DARK_FORCED));
  });

  it("is the one neutral canvas: #0a0a0b / #141416 / #1c1c1f", () => {
    expect(value(DARK_FORCED, "surface-app")).toBe("#0a0a0b");
    expect(value(DARK_FORCED, "surface-card")).toBe("#141416");
    expect(value(DARK_FORCED, "surface-raised")).toBe("#1c1c1f");
    expect(value(DARK_FORCED, "ink")).toBe("#f4f4f6");
    expect(value(DARK_FORCED, "ink-2")).toBe("#a2a2ad");
    expect(value(DARK_FORCED, "accent")).toBe("#38bdf8");
  });

  it("no navy surface literal is left anywhere in the app", () => {
    const NAVY = /#(?:0b1120|111a2e|16213a|1c2a40)\b|rgba\(11, ?17, ?32/i;
    const hits = cssFiles(SRC).filter((f) => NAVY.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("light theme", () => {
  it("canvas, surface, ink ramp, accent", () => {
    expect(value(ROOT, "surface-app")).toBe("#fafafa");
    expect(value(ROOT, "surface-card")).toBe("#ffffff");
    expect(value(ROOT, "ink")).toBe("#0b0d12");
    expect(value(ROOT, "ink-2")).toBe("#3b4250");
    expect(value(ROOT, "ink-3")).toBe("#5b6270");
    expect(value(ROOT, "accent")).toBe("#0369a1");
  });
});

describe("shape, depth, motion", () => {
  it("radius by role: chip 6, control 10, row 10, card 16, sheet 24", () => {
    expect(value(ROOT, "radius-chip")).toBe("6px");
    expect(value(ROOT, "radius-control")).toBe("10px");
    expect(value(ROOT, "radius-row")).toBe("10px");
    expect(value(ROOT, "radius-card")).toBe("16px");
    expect(value(ROOT, "radius-sheet")).toBe("24px");
  });

  it("the two v2 shadows", () => {
    expect(value(ROOT, "shadow-menu")).toBe(
      "0 1px 2px rgba(10, 14, 20, 0.06), 0 4px 12px -4px rgba(10, 14, 20, 0.1)",
    );
    expect(value(ROOT, "shadow-sheet")).toBe("0 12px 32px -8px rgba(10, 14, 20, 0.18)");
  });

  it("motion 120 / 200 / 320 on the v2 curve, instant under reduced motion", () => {
    expect(value(ROOT, "motion-state")).toBe("120ms");
    expect(value(ROOT, "motion-move")).toBe("200ms");
    expect(value(ROOT, "motion-sheet")).toBe("320ms");
    expect(value(ROOT, "ease")).toBe("cubic-bezier(0.32, 0.72, 0, 1)");
    const reduced = block("@media (prefers-reduced-motion: reduce) {");
    for (const name of [
      "motion-state",
      "motion-move",
      "motion-sheet",
      "motion-enter",
      "motion-exit",
    ]) {
      expect(value(reduced, name)).toBe("0ms");
    }
  });
});

describe("type roles (phone column, design px at default text size)", () => {
  const ROLES = { page: 30, title: 21, head: 17, body: 16, label: 14, caption: 13, mono: 13 };
  for (const [role, size] of Object.entries(ROLES)) {
    it(`role-${role} is ${size}`, () => {
      expect(px(ROOT, `role-${role}`)).toBe(String(size));
      expect(px(ROOT, `role-${role}-lh`)).toMatch(/^\d+$/);
    });
  }

  it("legacy steps that ARE a role follow it", () => {
    expect(value(ROOT, "type-large-title")).toBe("var(--role-page)");
    expect(value(ROOT, "type-title")).toBe("var(--role-title)");
    expect(value(ROOT, "type-headline")).toBe("var(--role-head)");
    expect(value(ROOT, "type-body")).toBe("var(--role-body)");
    expect(value(ROOT, "type-callout")).toBe("var(--role-label)");
    expect(value(ROOT, "type-subhead")).toBe("var(--role-caption)");
  });
});
