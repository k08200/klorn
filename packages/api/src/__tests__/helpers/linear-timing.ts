import { expect } from "vitest";

/**
 * Timing guard for the attachment scanners: a generous absolute budget at 1 MB
 * (the old regexes needed seconds at 40 KB and minutes at 1 MB) plus a doubling
 * check. Runs are timed in CPU time, not wall time: on a loaded machine (CI
 * running test files in parallel, a busy laptop) wall time also counts the time
 * this process waited for a core, which pushed a linear 2 MB hwpx scan past the
 * ratio check (CI run 40062512847: 251 ms against the 250 ms floor). Small and
 * large runs alternate, each timed as the fastest of five, so both see the same
 * machine state.
 */
export const MB = 1_000_000;
/** Generous for CI: the old regexes needed seconds at 40 KB and minutes at 1 MB. */
const BUDGET_MS = 1000;
/** Below this both runs are too fast for their ratio to mean anything. */
const RATIO_FLOOR_MS = 250;
const MAX_DOUBLING_RATIO = 3;
const ATTEMPTS = 5;
const MICROS_PER_MS = 1000;

/**
 * CPU time (user + system) this process spent in `run`. process.cpuUsage
 * counts every thread of the process, which is only this test file under
 * vitest's default forks pool; a threads pool would bill other files here.
 */
export function cpuMs(run: () => unknown): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / MICROS_PER_MS;
}

/** The fastest CPU time of each run, taking turns so no run gets a quieter stretch. */
export function fastestCpuMs(runs: ReadonlyArray<() => unknown>, attempts = ATTEMPTS): number[] {
  let best = runs.map(() => Number.POSITIVE_INFINITY);
  for (let i = 0; i < attempts; i++) {
    best = best.map((ms, j) => Math.min(ms, cpuMs(runs[j])));
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
  const [smallMs, largeMs] = fastestCpuMs([() => run(small), () => run(large)]);
  expect(smallMs).toBeLessThan(BUDGET_MS);
  expect(largeMs).toBeLessThan(Math.max(smallMs * MAX_DOUBLING_RATIO, RATIO_FLOOR_MS));
}
