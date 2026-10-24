/**
 * Today's lane blocks carry no count (founder decision 2026-10-24). The Today
 * header already says how many need the user (PUSH, MEETING) and how many wait
 * in Mail, so the blocks under it keep the lane chip and what the lane holds,
 * and only the quiet "N more in …" link at the bottom of a block carries a
 * figure — that is navigation, not a header count. Source pins over
 * packages/web/src/app/today/{block,mail-column}.tsx.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TODAY = resolve(__dirname, "../../../web/src/app/today");
const BLOCK = readFileSync(resolve(TODAY, "block.tsx"), "utf8");
const MAIL = readFileSync(resolve(TODAY, "mail-column.tsx"), "utf8");
const LOCALES = ["en", "ko", "ja", "zh", "de", "fr", "es"].map((code) =>
  readFileSync(resolve(__dirname, `../../../web/src/lib/locales/${code}.ts`), "utf8"),
);

/** One `function Name(` up to the next top-level declaration. */
function component(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return "";
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:export )?(?:function|const) /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("Today lane blocks carry no count (founder decision 2026-10-24)", () => {
  it("the block frame has no count slot", () => {
    expect(BLOCK).not.toMatch(/\bcount\?:/);
    expect(BLOCK).not.toMatch(/countLabel/);
    expect(BLOCK).not.toMatch(/function CountLabel/);
  });

  it("no lane block or the Info row prints a thread total", () => {
    expect(MAIL).not.toMatch(/count=\{/);
    expect(MAIL).not.toMatch(/today\.mail\.threads/);
    expect(component(MAIL, "InfoRow")).not.toMatch(/tabular-nums/);
  });

  it("keeps the lane chip and what the lane holds in every block header", () => {
    const lane = component(MAIL, "LaneBlock");
    expect(lane).toMatch(/title=\{<LaneChip tier=\{lane\} \/>\}/);
    expect(lane).toMatch(/hint=\{t\(copy\.hint\)\}/);
    const info = component(MAIL, "InfoRow");
    expect(info).toMatch(/<LaneChip tier="INFO" \/>/);
    expect(info).toMatch(/today\.lane\.info\.hint/);
  });

  it("keeps the overflow link, in caption ink", () => {
    expect(MAIL).toMatch(/today\.mail\.moreInLane/);
    const more = component(BLOCK, "LaneMoreLink");
    expect(more).toMatch(/text-caption/);
    expect(more).toMatch(/text-ink-muted/);
    expect(more).not.toMatch(/text-label/);
    expect(more).not.toMatch(/text-ink-soft/);
  });

  it("drops the now-unused thread-count string from every locale", () => {
    for (const locale of LOCALES) expect(locale).not.toMatch(/"today\.mail\.threads"/);
  });
});
