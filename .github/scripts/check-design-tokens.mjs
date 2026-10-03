#!/usr/bin/env node
/**
 * Design-token burn-down guard for the product web app (productization plan
 * §2 / P1).
 *
 * P1 added the design system tokens (type scale, radii, elevation, motion) in
 * packages/web/src/app/globals.css. P2 migrates call sites onto them. Between
 * the two, the only way to keep the migration from going backwards is to stop
 * NEW off-system styling from landing while the old call sites are burned down.
 *
 * Rules (counted per file, comments stripped):
 *
 *   arbitrary-font-size  `text-[11px]` and friends — use text-display / title /
 *                        head / body / label / caption.
 *   raw-palette          a raw Tailwind palette colour in a utility
 *                        (`bg-slate-100`, `text-amber-700/80`, …) — use the
 *                        semantic surface / ink / line / state / tier tokens,
 *                        which carry the light/dark pair and the measured
 *                        contrast. Raw literals are how the dark theme broke.
 *   raw-button           a raw `<button` in app/** pages — use ui/button.
 *   retired-auto-lane    `tier-auto` — the retired v1 AUTO lane's tokens stay
 *                        only for legacy Record<Tier, …> visuals.
 *
 * Baseline: .github/scripts/design-tokens-baseline.json holds the per-file
 * count of each rule at the time it was taken. A file may never exceed its
 * baseline, and a file absent from the baseline is allowed zero. Counts can
 * only go DOWN:
 *
 *   node .github/scripts/check-design-tokens.mjs            # check (CI)
 *   node .github/scripts/check-design-tokens.mjs --update   # lower the baseline
 *
 * `--update` rewrites the baseline from the current tree but refuses to run
 * while any count is above its baseline, so it can only ratchet downwards.
 * Run it after migrating call sites and commit the smaller baseline with the
 * change. Never raise a number by hand; fix the call site instead.
 *
 * `--update --init` seeds a baseline from scratch and is the only way past the
 * ratchet — reserved for introducing a new rule, never for a regression.
 * Allowances are keyed by path: moving or renaming a file resets its allowance
 * to 0, so move the baseline key with the file in the same commit.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WEB = "packages/web/src";
const SCAN_DIRS = [`${WEB}/app`, `${WEB}/components`];
const BASELINE = ".github/scripts/design-tokens-baseline.json";

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|rose|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink";
const UTILITY =
  "bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|divide|from|via|to|fill|stroke|shadow|decoration|placeholder|caret|accent";

const RULES = [
  {
    id: "arbitrary-font-size",
    re: /(?<![\w-])text-\[\d+(?:\.\d+)?px\]/g,
    applies: () => true,
    hint: "use a type role: text-display / title / head / body / label / caption",
  },
  {
    id: "raw-palette",
    re: new RegExp(`(?<![\\w-])(?:${UTILITY})-(?:${PALETTE})-(?:50|[1-9]00|950)(?![\\w-])`, "g"),
    applies: () => true,
    hint: "use a semantic token (surface-* / ink-* / line-* / state-* / tier-*)",
  },
  {
    id: "raw-button",
    re: /<button(?=[\s>])/g,
    applies: (file) => file.startsWith(`${WEB}/app/`),
    hint: "use the Button primitive from @/components/ui/button",
  },
  {
    id: "retired-auto-lane",
    re: /tier-auto\b/g,
    applies: () => true,
    hint: "AUTO is a retired v1 lane — never style new UI with it",
  },
];

/**
 * Blank out comments, preserving offsets. String literals are matched first and
 * kept verbatim, so a `//` inside a string or URL ("https://…") is not taken
 * for a line comment and cannot hide a class name later on the same line.
 */
function stripComments(src) {
  return src.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (m, str) => (str ? m : m.replace(/[^\n]/g, " ")),
  );
}

function sources(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // Normalise to forward slashes so baseline keys match on every OS.
    const full = join(dir, e.name).replaceAll("\\", "/");
    if (e.isDirectory()) sources(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

function countAll() {
  const counts = Object.fromEntries(RULES.map((r) => [r.id, {}]));
  const firstHit = {};
  for (const file of SCAN_DIRS.flatMap((d) => sources(d)).sort()) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const rule of RULES) {
      if (!rule.applies(file)) continue;
      const hits = [...src.matchAll(rule.re)];
      if (!hits.length) continue;
      counts[rule.id][file] = hits.length;
      const line = src.slice(0, hits[hits.length - 1].index).split("\n").length;
      firstHit[`${rule.id}:${file}`] = { line, text: hits[hits.length - 1][0] };
    }
  }
  return { counts, firstHit };
}

function loadBaseline() {
  if (!existsSync(BASELINE)) return Object.fromEntries(RULES.map((r) => [r.id, {}]));
  const parsed = JSON.parse(readFileSync(BASELINE, "utf8"));
  return Object.fromEntries(RULES.map((r) => [r.id, parsed[r.id] ?? {}]));
}

const total = (byFile) => Object.values(byFile).reduce((a, b) => a + b, 0);

const { counts, firstHit } = countAll();
const baseline = loadBaseline();
const updating = process.argv.includes("--update");
// Seeding needs an explicit --init: deleting the baseline and running --update
// must not be a way to raise every count.
const bootstrap = process.argv.includes("--init");

const regressions = [];
const improvements = [];
for (const rule of RULES) {
  const files = new Set([...Object.keys(counts[rule.id]), ...Object.keys(baseline[rule.id])]);
  for (const file of [...files].sort()) {
    const now = counts[rule.id][file] ?? 0;
    const allowed = baseline[rule.id][file] ?? 0;
    if (now > allowed) {
      const hit = firstHit[`${rule.id}:${file}`];
      regressions.push(
        `${file}:${hit.line} ${rule.id} ${now} > baseline ${allowed} (e.g. \`${hit.text}\`) — ${rule.hint}`,
      );
    } else if (now < allowed) {
      improvements.push(`${file} ${rule.id} ${allowed} → ${now}`);
    }
  }
}

if (updating) {
  if (regressions.length && !bootstrap) {
    console.error("::error::refusing to update the design-token baseline: counts went UP");
    for (const r of regressions) console.error(`✗ ${r}`);
    process.exit(1);
  }
  const sorted = Object.fromEntries(
    RULES.map((r) => [
      r.id,
      Object.fromEntries(Object.entries(counts[r.id]).sort(([a], [b]) => a.localeCompare(b))),
    ]),
  );
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
  for (const r of RULES) console.log(`  ${r.id}: ${total(counts[r.id])}`);
  console.log(`✓ wrote ${BASELINE}`);
  process.exit(0);
}

if (regressions.length) {
  console.error("::error::new off-system styling in the product web app");
  for (const r of regressions) console.error(`✗ ${r}`);
  console.error("");
  console.error("Tokens live in packages/web/src/app/globals.css (productization plan §2).");
  console.error("Baselines only go down — see the header of .github/scripts/check-design-tokens.mjs.");
  process.exit(1);
}

if (improvements.length) {
  console.log("Counts below baseline — lock the gain in with `--update`:");
  for (const i of improvements) console.log(`  ↓ ${i}`);
}
const summary = RULES.map((r) => `${r.id} ${total(counts[r.id])}`).join(", ");
console.log(`✓ design tokens: no new off-system styling (${summary}).`);
