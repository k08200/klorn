#!/usr/bin/env node
/**
 * Lane identity guard.
 *
 * Every lane in the vocabulary has to be TELLABLE APART on the surfaces that
 * render it. That is not a style preference here — the product's whole claim
 * is that you can see which lane a message landed in, so a lane wearing
 * another lane's colour is a correctness bug, not a polish one.
 *
 * It has already happened once. The ontology v2 flip (#1138, 2026-08-18) made
 * five lanes live while `TIER_VISUAL` still described four: MEETING pointed at
 * `tier-plane-push` / `text-tier-push` and INFO at `tier-plane-silent` /
 * `text-ink-dim`, and `TIER_COLORS` had no entry for either, so both fell
 * through to the violet used for a scored feature. Nothing failed. The next
 * vocabulary change should not get the same silence.
 *
 * Checks, against `TIERS` in the API as the source of truth:
 *   1. every lane has a hue token   --color-tier-<lane>
 *   2. every lane has an ink token  --tier-<lane>-ink, in BOTH :root and .dark
 *   3. every lane's TIER_VISUAL accent/dot/plane is unique to it
 *   4. every lane has a TIER_COLORS entry, and no two share a hex
 *
 * AUTO is a retired v1 value kept for pre-flip rows, so it is checked like any
 * other renderable lane — it still shows up on screen until a backfill clears
 * the last row.
 */

import { readFileSync } from "node:fs";

const TIERS_FILE = "packages/api/src/judge/tiers.ts";
const CSS_FILE = "packages/web/src/app/globals.css";
const BOARD_FILE = "packages/web/src/components/firewall-board.tsx";
const GRAPH_FILE = "packages/web/src/components/relationship-graph.tsx";

const problems = [];
const note = (m) => problems.push(m);
const read = (f) => readFileSync(f, "utf8");

// ── 1. the vocabulary ──────────────────────────────────────────────────────
const tiersSrc = read(TIERS_FILE);
const tiersMatch = tiersSrc.match(/export const TIERS = \[([^\]]+)\] as const;/);
if (!tiersMatch) {
  console.error(`✗ lane identity: could not read TIERS from ${TIERS_FILE}`);
  process.exit(1);
}
const lanes = [...tiersMatch[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
if (lanes.length === 0) {
  console.error(`✗ lane identity: TIERS parsed as empty in ${TIERS_FILE}`);
  process.exit(1);
}

// ── 2. tokens ──────────────────────────────────────────────────────────────
const css = read(CSS_FILE);
// The ink tokens are theme-aware, so they must exist in both blocks. Slice on
// the block openers rather than regexing the whole file: a token defined only
// in .dark is exactly the failure this is here to catch.
const rootStart = css.indexOf(":root {");
const darkStart = css.indexOf(".dark {");
if (rootStart < 0 || darkStart < 0 || darkStart < rootStart) {
  console.error(`✗ lane identity: could not locate :root / .dark blocks in ${CSS_FILE}`);
  process.exit(1);
}
const rootBlock = css.slice(rootStart, darkStart);
const darkBlock = css.slice(darkStart);

for (const lane of lanes) {
  const key = lane.toLowerCase();
  if (!css.includes(`--color-tier-${key}:`)) {
    note(`${lane}: no hue token --color-tier-${key} in ${CSS_FILE}`);
  }
  if (!rootBlock.includes(`--tier-${key}-ink:`)) {
    note(`${lane}: no light ink token --tier-${key}-ink in :root`);
  }
  if (!darkBlock.includes(`--tier-${key}-ink:`)) {
    note(`${lane}: no dark ink token --tier-${key}-ink in .dark`);
  }
  if (!css.includes(`--color-tier-${key}-ink: var(--tier-${key}-ink)`)) {
    note(`${lane}: ink token not exposed to Tailwind via @theme inline`);
  }
}

// ── 3. the board ───────────────────────────────────────────────────────────
const board = read(BOARD_FILE);
const seen = { accent: new Map(), dot: new Map(), plane: new Map() };
for (const lane of lanes) {
  const entry = board.match(new RegExp(`\\n  ${lane}: \\{([\\s\\S]*?)\\n  \\},`));
  if (!entry) {
    note(`${lane}: no TIER_VISUAL entry in ${BOARD_FILE}`);
    continue;
  }
  const body = entry[1];
  for (const field of ["accent", "dot"]) {
    const m = body.match(new RegExp(`${field}: "([^"]+)"`));
    if (!m) {
      note(`${lane}: TIER_VISUAL.${field} missing`);
      continue;
    }
    const prev = seen[field].get(m[1]);
    if (prev) note(`${lane}: TIER_VISUAL.${field} "${m[1]}" is already ${prev}'s`);
    else seen[field].set(m[1], lane);
  }
  const plane = body.match(/tier-plane-(\w+)/);
  if (!plane) {
    // SILENT-style unlit planes are allowed to have no glow class, but then
    // nothing else may claim to be one either.
    note(`${lane}: TIER_VISUAL.plane has no tier-plane-* class`);
  } else {
    const prev = seen.plane.get(plane[1]);
    if (prev) note(`${lane}: plane "tier-plane-${plane[1]}" is already ${prev}'s`);
    else seen.plane.set(plane[1], lane);
    if (!css.includes(`.tier-plane-${plane[1]} {`)) {
      note(`${lane}: .tier-plane-${plane[1]} is not defined in ${CSS_FILE}`);
    }
  }
}

// ── 4. the graph ───────────────────────────────────────────────────────────
const graph = read(GRAPH_FILE);
const colorsBlock = graph.match(/TIER_COLORS: Record<string, string> = \{([\s\S]*?)\n\};/);
if (!colorsBlock) {
  note(`could not read TIER_COLORS from ${GRAPH_FILE}`);
} else {
  const byHex = new Map();
  for (const lane of lanes) {
    const m = colorsBlock[1].match(new RegExp(`${lane}: "(#[0-9a-fA-F]{6})"`));
    if (!m) {
      note(`${lane}: no TIER_COLORS entry — it will render as the fallback colour`);
      continue;
    }
    const prev = byHex.get(m[1]);
    if (prev) note(`${lane}: TIER_COLORS hex ${m[1]} is already ${prev}'s`);
    else byHex.set(m[1], lane);
  }
}

if (problems.length > 0) {
  console.error(`✗ lane identity: ${problems.length} problem(s) across ${lanes.length} lanes`);
  for (const p of problems) console.error(`    ${p}`);
  process.exit(1);
}
console.log(`✓ lane identity: ${lanes.length} lanes (${lanes.join(", ")}) each own their hue, ink, plane and graph colour.`);
