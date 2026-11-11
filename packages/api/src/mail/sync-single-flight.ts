/**
 * Per-key single flight with one trailing re-run.
 *
 * Used for push-triggered mailbox syncs: Gmail sends a Pub/Sub push per change,
 * and each push used to start its own full sync, so a burst of new mail ran
 * many concurrent syncs of the same inbox (and fanned out duplicate judge and
 * summary work). Here a call for a key that is already running does not start
 * a second run; instead every call made during the run shares ONE re-run that
 * starts when the current one settles. The re-run matters: the running sync may
 * have read the mailbox before the mail that triggered the later push arrived.
 *
 * - The re-run uses the latest caller's function (e.g. the freshest client).
 * - The re-run starts in the same callback that sees the current run settle,
 *   so there is no gap in which a new call could start a parallel run.
 * - A run older than `staleAfterMs` stops blocking: Gmail calls have no
 *   timeout, and one hung sync must not hold an inbox's push path until the
 *   process restarts. A replaced run that settles later changes nothing.
 *
 * In-memory and per process, like the rest of the push path.
 */

export interface SingleFlight<T> {
  run(key: string, fn: () => Promise<T>): Promise<T>;
}

export const DEFAULT_SYNC_STALE_AFTER_MS = 5 * 60_000;

interface Running {
  token: symbol;
  startedAt: number;
}

interface Trailing<T> {
  fn: () => Promise<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function createSingleFlight<T>(options: { staleAfterMs?: number } = {}): SingleFlight<T> {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_SYNC_STALE_AFTER_MS;
  const running = new Map<string, Running>();
  const trailing = new Map<string, Trailing<T>>();

  function start(key: string, fn: () => Promise<T>): Promise<T> {
    const token = Symbol(key);
    running.set(key, { token, startedAt: Date.now() });
    const run = (async () => fn())();
    const settle = () => {
      // A newer run replaced this stale one and owns the key now.
      if (running.get(key)?.token !== token) return;
      const next = trailing.get(key);
      if (!next) {
        running.delete(key);
        return;
      }
      trailing.delete(key);
      start(key, next.fn).then(next.resolve, next.reject);
    };
    run.then(settle, settle);
    return run;
  }

  function queueTrailing(key: string, fn: () => Promise<T>): Promise<T> {
    let resolve: (value: T) => void = () => {};
    let reject: (reason: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    trailing.set(key, { fn, promise, resolve, reject });
    return promise;
  }

  return {
    run(key, fn) {
      const current = running.get(key);
      const waiting = trailing.get(key);
      if (current && Date.now() - current.startedAt <= staleAfterMs) {
        if (!waiting) return queueTrailing(key, fn);
        waiting.fn = fn;
        return waiting.promise;
      }
      // Idle, or the running sync is stale: start now. Calls that were waiting
      // for a re-run are served by this run.
      trailing.delete(key);
      const fresh = start(key, fn);
      if (waiting) fresh.then(waiting.resolve, waiting.reject);
      return fresh;
    },
  };
}
