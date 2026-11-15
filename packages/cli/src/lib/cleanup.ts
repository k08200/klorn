/**
 * Synchronous cleanups for an interrupted run (Ctrl-C / SIGTERM): a `finally`
 * never runs when the process is killed by a signal, so anything that must not
 * outlive the CLI — a temporary pgpass file, a half-written dump — registers
 * here for the duration it exists. bin/klorn.mjs runs them on SIGINT/SIGTERM.
 */

const tasks = new Set<() => void>();

/** Register a cleanup; call the returned function once it is no longer needed. */
export function onInterrupt(task: () => void): () => void {
  tasks.add(task);
  return () => {
    tasks.delete(task);
  };
}

export function runInterruptTasks(): void {
  for (const task of [...tasks]) {
    try {
      task();
    } catch (err) {
      process.stderr.write(`klorn: cleanup failed: ${err instanceof Error ? err.message : err}\n`);
    }
  }
  tasks.clear();
}
