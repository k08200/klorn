// Pins the web shell's device classes (docs/design/design-language-v2.md,
// "Device classes"): bottom tabs below 600px, the navigation rail from 600px,
// the full sidebar from 1024px, and the mail list + reader split from 700px
// or on any two-segment (hinged) screen, with the seam on the hinge.
// The classes are Tailwind variants, so the guard reads the source: the
// shell pieces must switch at the same step or a width ends up with two
// navigations, or none. Run from the api suite because the web package has no
// unit-test runner (see web-tool-labels.test.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = resolve(__dirname, "../../../web/src");
const read = (path: string) => readFileSync(resolve(WEB, path), "utf8");

const CSS = read("app/globals.css");
const SHELL = read("components/app-shell.tsx");
const TABS = read("components/bottom-tabs.tsx");
const RAIL = read("components/nav-rail.tsx");
const SIDEBAR = read("components/sidebar.tsx");
const MAIL_LAYOUT = read("app/email/layout.tsx");
const READER_ACTIONS = read("app/email/[id]/_v2/reader-actions.tsx");
const UNDO_BAR = read("app/email/_v2/undo-bar.tsx");

/** The CSS block that follows `selector` up to its matching close brace. */
function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `${selector} missing from globals.css`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`unclosed block: ${selector}`);
}

describe("device-class breakpoints", () => {
  it("defines the rail step at 600px, in rem like Tailwind's own steps", () => {
    expect(CSS).toMatch(/--breakpoint-rail:\s*37\.5rem;/);
  });

  it("gives the shell's nav column the rail and sidebar widths", () => {
    expect(block(CSS, "@media (min-width: 37.5rem)")).toContain("72px");
    expect(block(CSS, "@media (min-width: 64rem)")).toContain("260px");
    expect(RAIL).toContain("w-[calc(72px+env(safe-area-inset-left))]");
    expect(SIDEBAR).toContain("w-[calc(260px+env(safe-area-inset-left))]");
  });
});

describe("one navigation per width", () => {
  it("the tab bar hides from 600px, where the rail shows; the rail gives way to the sidebar at 1024px", () => {
    expect(TABS).toMatch(/className="rail:hidden fixed bottom-0/);
    expect(RAIL).toMatch(/\bhidden\b[^"]*\brail:flex\b[^"]*\blg:hidden\b/);
    expect(SIDEBAR).toMatch(/<aside className="hidden lg:block /);
  });

  it("the phone header and the tab bar's clearances switch at the same step", () => {
    expect(SHELL).toContain("rail:hidden flex items-center");
    expect(SHELL).not.toMatch(/\bmd:(hidden|pb-|scroll-pb-)|max-md:/);
  });

  it("the reader's phone action bar and its desktop row never show together", () => {
    expect(READER_ACTIONS).toContain("max-rail:hidden");
    expect(READER_ACTIONS).toContain("shadow-menu rail:hidden");
    expect(READER_ACTIONS).not.toMatch(/\bmd:hidden|max-md:hidden/);
    expect(UNDO_BAR).not.toMatch(/\bmd:bottom|max-md:/);
  });
});

describe("mail split", () => {
  it("opens from 700px, or on any screen the browser reports as two side-by-side segments", () => {
    expect(MAIL_LAYOUT).toContain(
      'SPLIT_QUERY = "(min-width: 700px), (horizontal-viewport-segments: 2)"',
    );
    expect(MAIL_LAYOUT).toContain("mail-split-list");
    expect(MAIL_LAYOUT).toContain("mail-split-reader");
  });

  it("sizes the list by the space left, and puts the seam on the hinge when there is one", () => {
    expect(block(CSS, ".mail-split-list {")).toContain("clamp(280px, 45%, 440px)");
    const hinge = block(CSS, "@media (horizontal-viewport-segments: 2)");
    expect(hinge).toMatch(
      /\.mail-split-list\s*{[^}]*env\(viewport-segment-right 0 0, [^)]+\)[^}]*var\(--shell-nav-w\)/,
    );
    expect(hinge).toMatch(
      /\.mail-split-reader\s*{[^}]*env\(viewport-segment-left 1 0, [^)]+\)[^}]*env\(viewport-segment-right 0 0, [^)]+\)/,
    );
  });
});
