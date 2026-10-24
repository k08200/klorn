import { expect } from "vitest";

/**
 * Timing guard for the attachment scanners: a generous absolute budget at 1 MB
 * (the old regexes needed seconds at 40 KB and minutes at 1 MB) plus a doubling
 * check. Runs are timed in CPU time, not wall time: on a loaded machine (CI
 * running test files in parallel, a busy laptop) wall time also counts the time
 * this process waited for a core, which pushed a linear 2 MB hwpx scan past the
 * ratio check in CI (251 ms against the 250 ms floor). Small and large runs
 * alternate, each timed as the fastest of five, so both see similar machine
 * state.
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
 * CPU time (user + system) this process spent in `run`. process.cpuUsage counts
 * all threads of the process, GC and JIT helpers included (the run's own cost).
 * vitest.config.ts pins the forks pool so each test file has its own process; a
 * threads pool would bill other files' work here.
 */
function cpuMs(run: () => unknown): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / MICROS_PER_MS;
}

export function fastestCpuMs(run: () => unknown, attempts = ATTEMPTS): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < attempts; i++) best = Math.min(best, cpuMs(run));
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
  const runSmall = () => run(small);
  const runLarge = () => run(large);
  let smallMs = Number.POSITIVE_INFINITY;
  let largeMs = Number.POSITIVE_INFINITY;
  // Taking turns, so neither size gets a quieter stretch of the machine.
  for (let i = 0; i < ATTEMPTS; i++) {
    smallMs = Math.min(smallMs, cpuMs(runSmall));
    largeMs = Math.min(largeMs, cpuMs(runLarge));
  }
  expect(smallMs).toBeLessThan(BUDGET_MS);
  expect(largeMs).toBeLessThan(Math.max(smallMs * MAX_DOUBLING_RATIO, RATIO_FLOOR_MS));
}
