import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

/**
 * --color-accent (#0ea5e9) and --color-accent-light (#38bdf8) are surface and
 * tint values, not text backgrounds: white on them measures 2.77:1 and 2.14:1
 * in BOTH themes, because neither is theme-swapped. --accent-solid carries the
 * filled-control pair instead and does swap (white on sky-700 in light, ink on
 * sky-400 in dark).
 *
 * The first test is a source invariant — it catches the regression at the line
 * that introduces it, anywhere in the app, including screens behind auth that
 * a rendered check can never reach. The second proves the tokens actually
 * resolve to a passing pair on the surfaces we can load.
 */

// Playwright resolves testDir from the package root, so cwd is packages/web.
const SRC = join(process.cwd(), "src");
// A bare fill is either the flat token or a gradient STOP built from it — the
// first version of this guard only matched the flat form, so 37 gradient
// buttons and avatars carried white text at 2.14:1 straight through it
// (found 2026-08-23). from-/to-/via- are covered explicitly.
const BANNED = /\b(?:bg|from|via|to)-accent(-light)?\b(?!-)/;
// Notice surfaces and semantic text. Every shade listed is a single Tailwind
// value that does NOT swap with the theme, so it is wrong in one theme by
// construction: the -50/-200 surfaces painted near-white slabs on the dark
// panel, and the -600/-700 inks dropped under 4.5:1 there.
// Deliberately NOT banned: bare -400/-500 fills (status dots, quota bars) and
// every alpha variant (bg-emerald-500/10) — graphical washes carrying no text
// of their own, judged against 1.4.11's 3:1.
const BANNED_DANGER =
  /\b(?:bg-red-(?:50|100)|border-red-200|text-red-(?:200|400|500|600|700)|bg-red-(?:600|700))(?![\w/])/;
const BANNED_STATE =
  /\b(?:bg-(?:emerald|amber|sky)-50|border-(?:emerald|amber|sky)-200|border-amber-300|text-(?:emerald|amber)-(?:200|600|700)|text-sky-800)(?![\w/])/;
// --color-accent and its -light/-muted tints are SURFACE values: as text they
// measure 2.77 / 2.14 / 1.6:1 on white. --accent-deep is the text step, and in
// the dark it resolves to the same bright blue those were reaching for.
const BANNED_ACCENT_TEXT =
  /\b(?:hover:|focus:|group-hover:)?text-accent(?:-light|-muted)?(?:\/\d+)?(?![-\w])/;
const CLASS_STRING = /"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;

/**
 * Drop block comments before scanning. A JSDoc that quotes the banned recipe
 * to explain why it is banned is documentation, not a violation — and
 * error-alert.tsx does exactly that.
 */
function withoutBlockComments(text: string): string {
  // Same length out as in, so match.index still maps to the real line.
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

test.describe("Accent contrast", () => {
  test("no source file paints white text on a bare accent fill", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      // Scan the whole file, not line by line: a className template literal
      // can span several lines, and the per-line version could never match
      // one — which is how the bottom-tabs account badge slipped through.
      const text = withoutBlockComments(readFileSync(file, "utf8"));
      for (const match of text.matchAll(CLASS_STRING)) {
        const body = match[1] ?? match[2] ?? "";
        if (BANNED.test(body) && /\btext-white\b/.test(body)) {
          const line = text.slice(0, match.index).split("\n").length;
          offenders.push(`${file.slice(SRC.length + 1)}:${line}`);
        }
      }
    }
    expect(offenders, "use bg-accent-solid + text-accent-solid-ink instead").toEqual([]);
  });

  test("no source file pins a raw semantic colour, or an accent tint used as text", () => {
    // Same failure mode as the accent one, opposite direction: these Tailwind
    // reds are single values that do not swap, so text-red-600 read 3.6:1 on
    // the dark panel while text-red-400 read 2.5:1 in light, and the
    // bg-red-50/border-red-200 notice box painted as a near-white slab in
    // dark. --state-danger-* / --danger-solid carry both themes instead.
    //
    // Deliberately NOT banned: bg-red-400/500 as a bare fill (status dots,
    // over-quota bars) and every alpha variant (bg-red-500/10) — those are
    // graphical washes carrying no text, judged against 1.4.11's 3:1.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = withoutBlockComments(readFileSync(file, "utf8"));
      for (const match of text.matchAll(CLASS_STRING)) {
        const body = match[1] ?? match[2] ?? "";
        if (BANNED_DANGER.test(body) || BANNED_STATE.test(body) || BANNED_ACCENT_TEXT.test(body)) {
          const line = text.slice(0, match.index).split("\n").length;
          offenders.push(`${file.slice(SRC.length + 1)}:${line}`);
        }
      }
    }
    expect(
      offenders,
      "use the --state-{ok,warn,info,danger}-* tokens, text-accent-deep for accent TEXT, or bg-danger-solid + text-danger-solid-ink for a filled destructive control",
    ).toEqual([]);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`filled accent controls clear AA in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await mockAuthProbes(page);
      await page.goto("/reset-password");
      // The CTA starts disabled, and a disabled control is exempt from 1.4.3 —
      // measuring it would test the disabled tokens, not the accent pair.
      await page.locator('input[type="email"]').fill("someone@example.com");
      const cta = page.getByRole("button", { name: /send reset link/i });
      await expect(cta).toBeEnabled();

      // The button carries a colour transition, so the frame right after the
      // disabled attribute drops still paints the disabled pair. Poll until
      // the transition settles rather than racing it.
      const measure = () =>
        cta.evaluate((el) => {
          const parse = (c: string) => {
            const ctx = document.createElement("canvas").getContext("2d")!;
            ctx.fillStyle = "#000";
            ctx.fillStyle = c;
            const h = ctx.fillStyle as string;
            if (h.startsWith("#")) return [1, 3, 5].map((i) => Number.parseInt(h.substr(i, 2), 16));
            return h
              .match(/[\d.]+/g)!
              .map(Number)
              .slice(0, 3);
          };
          const lum = (a: number[]) => {
            const f = (v: number) =>
              (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            return 0.2126 * f(a[0]) + 0.7152 * f(a[1]) + 0.0722 * f(a[2]);
          };
          const cs = getComputedStyle(el);
          const l1 = lum(parse(cs.color));
          const l2 = lum(parse(cs.backgroundColor));
          return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        });
      await expect.poll(measure).toBeGreaterThanOrEqual(4.5);
    });
  }
});

async function mockAuthProbes(page: Page) {
  await page.route("**/api/auth/signup-status", (r) => r.fulfill({ json: { open: true } }));
  await page.route("**/api/auth/providers", (r) =>
    r.fulfill({ json: { providers: [{ id: "google" }] } }),
  );
}
