import { expect } from "vitest";

/**
 * Timing guard for the attachment scanners: a generous absolute budget at 1 MB
 * (the old regexes needed seconds at 40 KB and minutes at 1 MB) plus a doubling
 * check, each run timed as the fastest of five to keep GC and CI noise out.
 */
export const MB = 1_000_000;
/** Generous for CI: the old regexes needed seconds at 40 KB and minutes at 1 MB. */
const BUDGET_MS = 1000;
/** Below this both runs are too fast for their ratio to mean anything. */
const RATIO_FLOOR_MS = 250;
const MAX_DOUBLING_RATIO = 3;

export function fastestMs(run: () => unknown, attempts = 5): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < attempts; i++) {
    const startedAt = performance.now();
    run();
    best = Math.min(best, performance.now() - startedAt);
  }
  return best;
}

/** `unit` repeated to about `bytes` characters, with an optional prefix/suffix. */
export function repeatTo(bytes: number, unit: string, prefix = "", suffix = ""): string {
  return prefix + unit.repeat(Math.ceil(bytes / unit.length)) + suffix;
}

export function expectLinear(
  build: (bytes: number) => string,
  run: (input: string) => unknown,
): void {
  const small = build(MB);
  const large = build(2 * MB);
  const smallMs = fastestMs(() => run(small));
  const largeMs = fastestMs(() => run(large));
  expect(smallMs).toBeLessThan(BUDGET_MS);
  expect(largeMs).toBeLessThan(Math.max(smallMs * MAX_DOUBLING_RATIO, RATIO_FLOOR_MS));
}
