#!/usr/bin/env node
/**
 * Lane vocabulary guard for the product web app.
 *
 * `check-lane-identity.mjs` asserts each lane owns a distinct hue; it says
 * nothing about which lanes a surface knows exist. So while the landings were
 * corrected to five lanes (#1233, #1241, #1244), the app itself kept shipping
 * the retired v1 vocabulary, every check green:
 *
 *   - playground/page.tsx typed Tier as PUSH|QUEUE|SILENT|AUTO and indexed
 *     TIER_VISUAL[result.tier] with no guard. api.klorn.ai returns MEETING for
 *     a calendar invite, so pasting one threw TypeError during render.
 *   - onboarding/review-step.tsx grouped by ["PUSH","QUEUE","AUTO","SILENT"]
 *     and filtered empty groups, so MEETING and INFO mail vanished from the
 *     first-run review — silently, which is why no DecisionLabel ground truth
 *     for those two lanes was ever seeded.
 *   - graph/page.tsx and the privacy policy still named AUTO to users.
 *
 * Three assertions, all scoped to ARRAY literals and type declarations —
 * never to object/Record keys. `Record<Tier, X>` must carry an AUTO key or it
 * will not typecheck, because the contract's Tier still includes AUTO for
 * legacy rows; having a visual ready for a legacy value is correct, and only
 * offering AUTO as a live choice is not.
 *
 *   1. No file re-declares the lane vocabulary. A local `type Tier = "PUSH" |
 *      ...` is how the playground ended up with a four-value Record that had
 *      no MEETING key to look up. Import Tier from @klorn/contract, CORE_TIERS from @/lib/tiers.
 *   2. No array literal offers a retired lane (AUTO, CALL) as a choice.
 *      TIER_V2_ENABLED has been default-ON since 2026-08-18, so v2 never
 *      emits AUTO and no UI should present it.
 *   3. An array naming two or more lanes must name all five live ones. A
 *      deliberate subset is fine — annotate it `// lane-subset: <reason>` on
 *      one of the three lines above. The point is that a partial list cannot
 *      ship silently, not that subsets are forbidden.
 *
 * Agent mode (SHADOW/SUGGEST/AUTO) and attentionMode (BASIC/AUTO) are
 * different vocabularies that happen to share the word. They are matched only
 * when AUTO appears alongside an actual lane name, so they never trip this.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "packages/web/src";
const LIVE = ["SILENT", "INFO", "QUEUE", "MEETING", "PUSH"];
const RETIRED = ["AUTO", "CALL"];
const ALL = [...LIVE, ...RETIRED];

/**
 * Blank out comments before scanning, preserving offsets so reported line
 * numbers stay true. Without this the guard flags its own prose: a docblock
 * explaining that onboarding used to group by ["PUSH","QUEUE","AUTO","SILENT"]
 * reads as a lane list to a regex.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

function sources(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * Lane names quoted inside one ARRAY literal — the shape that drives
 * iteration, and iteration is what silently drops a lane. Object/Record keys
 * are deliberately not matched: see the note above.
 */
function collections(src) {
  const found = [];
  for (const m of src.matchAll(/\[([^[\]]*)\]/g)) {
    const names = [...m[1].matchAll(/["']([A-Z]+)["']/g)]
      .map((x) => x[1])
      .filter((n) => ALL.includes(n));
    if (names.length >= 2) found.push({ names: [...new Set(names)], index: m.index });
  }
  return found;
}

/** A local union of lane strings — the vocabulary restated instead of imported. */
function redeclarations(src) {
  const found = [];
  for (const m of src.matchAll(/type\s+(\w*Tier\w*)\s*=\s*([^;]+);/g)) {
    const names = [...m[2].matchAll(/["']([A-Z]+)["']/g)]
      .map((x) => x[1])
      .filter((n) => ALL.includes(n));
    if (names.length >= 2) found.push({ name: m[1], names, index: m.index });
  }
  return found;
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;
const annotated = (src, line) =>
  src
    .split("\n")
    .slice(Math.max(0, line - 6), line)
    .some((l) => l.includes("lane-subset:"));

const problems = [];

for (const file of sources(ROOT)) {
  const raw = readFileSync(file, "utf8");
  const src = stripComments(raw);
  for (const { name, names, index } of redeclarations(src)) {
    const line = lineOf(src, index);
    if (annotated(raw, line)) continue;
    problems.push(
      `${file}:${line} re-declares the lane vocabulary as \`${name}\` (${names.join(", ")}) ` +
        `— import Tier from @klorn/contract instead`,
    );
  }
  for (const { names, index } of collections(src)) {
    const line = lineOf(src, index);
    const retired = names.filter((n) => RETIRED.includes(n));
    if (retired.length) {
      problems.push(
        `${file}:${line} offers retired lane ${retired.join(", ")} alongside ${names
          .filter((n) => LIVE.includes(n))
          .join(", ")}`,
      );
      continue;
    }
    const missing = LIVE.filter((n) => !names.includes(n));
    if (missing.length && !annotated(raw, line)) {
      problems.push(
        `${file}:${line} names ${names.join(", ")} but omits ${missing.join(", ")} ` +
          `— complete the list, or annotate it \`// lane-subset: <reason>\``,
      );
    }
  }
}

if (problems.length) {
  console.error("::error::lane vocabulary drift in the product web app");
  for (const p of problems.sort()) console.error(`✗ ${p}`);
  console.error("");
  console.error("The five live lanes are SILENT, INFO, QUEUE, MEETING, PUSH.");
  console.error("Import CORE_TIERS from @/lib/tiers instead of restating them.");
  process.exit(1);
}

console.log(`✓ lane vocabulary: ${ROOT} imports the lanes and every array names all five, or says why not.`);
